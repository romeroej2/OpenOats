# NeMo Speaker Diarization Design

**Date:** 2026-03-24
**Status:** Approved
**Scope:** System audio (Them) stream only — Parakeet STT backend

---

## Overview

Add per-segment speaker diarization to the system audio transcription pipeline using NVIDIA's TitaNet speaker embedding model. Each VAD segment is labeled with a stable speaker ID immediately after transcription. Speaker identity is maintained across segments using an in-memory anchor table with cosine similarity matching.

Diarization is a no-op for Whisper and FasterWhisper backends and degrades gracefully to the existing "Speaker A" fallback if TitaNet errors.

---

## Architecture

```
System audio → VAD → segment (≥1 s)
                        ├─ worker.transcribe(samples) → text (non-empty guard)
                        └─ worker.speaker_id(samples)  → "speaker_0" | "speaker_1" | …
                                                              ↓
                                              participant_label: "Speaker 1" | "Speaker 2" | …
                                                              ↓
                                              TranscriptPayload + SessionRecord
```

Mic and system audio use **separate** Parakeet worker processes (`warmed_parakeet_mic` and `warmed_parakeet_sys`). Each has its own module-level state. There is no shared state and no concurrency concern between the two streams.

---

## Components

### 1. Python Worker (`parakeet_worker.py`)

**Module-level state**

```python
SPEAKER_ANCHORS: dict[str, np.ndarray] = {}   # speaker_id → mean embedding
SPEAKER_COUNTER: int = 0                        # incremented when a new anchor is created
TITANET_MODEL = None                            # loaded lazily, cached after first load
COSINE_THRESHOLD = 0.7
MIN_SPEAKER_ID_SAMPLES = 16_000                 # 1.0 s at 16 kHz — shorter segments are skipped
```

---

**New command: `speaker_id`**

Input: `{"command": "speaker_id", "samples": [...], "model": "...", "device": "..."}`

Steps:
1. If `len(samples) < MIN_SPEAKER_ID_SAMPLES`: return `{"ok": true, "result": {"speaker_id": null}}` — segment too short to embed reliably.
2. Load TitaNet if not already cached (see below).
3. Write samples to a temp WAV at 16 kHz, extract a 192-d embedding via `TITANET_MODEL.get_embedding()`.
4. Compare embedding to all entries in `SPEAKER_ANCHORS` using cosine similarity.
5. If best match ≥ `COSINE_THRESHOLD`: return that speaker's stable ID and update its anchor online: `anchor = 0.9 * anchor + 0.1 * new_embedding`.
6. If no match: increment `SPEAKER_COUNTER`, store new anchor as `f"speaker_{SPEAKER_COUNTER - 1}"`, return new ID.
7. Return `{"ok": true, "result": {"speaker_id": "speaker_N"}}`.

On any exception: return `{"ok": false, "error": "..."}` — does not affect ASR.

**`speaker_id` MUST NOT be called for silent or noise-only audio.** The Rust caller is responsible for ensuring `transcribe()` returned non-empty text before calling `speaker_id`.

---

**New command: `clear_speakers`**

Resets both `SPEAKER_ANCHORS` and `SPEAKER_COUNTER`:

```python
SPEAKER_ANCHORS.clear()
SPEAKER_COUNTER = 0
```

Returns `{"ok": true, "result": {"cleared": true}}`.

---

**`ensure_model` update**

The `diarization_enabled` flag is passed in the `ensure_model` payload:

```json
{"command": "ensure_model", "model": "...", "device": "...", "diarization_enabled": true}
```

If `diarization_enabled` is `true`: after loading the ASR model, also call `EncDecSpeakerLabelModel.from_pretrained("nvidia/titanet-large")` and cache it in `TITANET_MODEL`. This download (~80 MB) is covered by the existing install log streaming UI and the pre-warm loading indicator. If `diarization_enabled` is `false`: TitaNet is not downloaded. This avoids ~80 MB of unnecessary downloads.

If TitaNet fails to load during `ensure_model`, log a warning and continue — ASR model loading is not affected.

---

### 2. Rust `ParakeetConfig` + `ParakeetWorker` (`parakeet.rs`)

**`ParakeetConfig` gains one new field:**

```rust
pub diarization_enabled: bool,
```

Set in `AppState::parakeet_config()` alongside `language`:
```rust
diarization_enabled: settings.diarization_enabled,
```

This threads `diarization_enabled` into both the free function `ensure_model` and the worker method, without requiring call-site changes beyond `parakeet_config()`.

**Free function `ensure_model` — no signature change needed.** It already receives `config: &ParakeetConfig`, so the internal call becomes `worker.ensure_model(config.diarization_enabled)?`.

**`ParakeetWorker` — new and updated methods:**

```rust
/// Updated signature — diarization_enabled controls TitaNet download.
pub fn ensure_model(&mut self, diarization_enabled: bool) -> Result<(), String>

/// Returns stable speaker ID (e.g. "speaker_0"), or None if segment was too short.
pub fn speaker_id(&mut self, samples: &[f32]) -> Result<Option<String>, String>

pub fn clear_speakers(&mut self) -> Result<(), String>
```

---

### 3. `StreamingTranscriber` (`streaming_transcriber.rs`)

**`OnFinal` signature change**

```rust
pub type OnFinal = Box<dyn Fn(String, Option<String>) + Send + 'static>;
// (text, speaker_id)
// speaker_id is None when: non-Parakeet backend, diarization disabled,
// segment too short, or speaker_id call failed.
```

**All call sites that construct an `OnFinal` closure must be updated to accept two arguments.** The affected locations are:

1. `engine.rs` — `on_them` closure (system audio stream)
2. `engine.rs` — `on_you` closure (mic stream) — always receives `None`, second arg ignored: `|text, _speaker_id| { ... }`
3. `streaming_transcriber.rs` tests — update to: `|text, _speaker_id| { tx.send(text).ok(); }`

Whisper and FasterWhisper branches in `streaming_transcriber.rs` always pass `None` as the second argument. This is enforced inside the transcriber — callers do not need to know which backend is active.

**Parakeet branch update — ordering is strict:**

```
1. worker.transcribe(samples) → text
2. if text.is_empty() → on_final(text, None); continue   ← guard: skip speaker_id
3. if diarization_enabled:
       worker.speaker_id(samples) → Ok(Some(id)) | Ok(None) | Err(_)
       on_final(text, speaker_id_result.ok().flatten())
   else:
       on_final(text, None)
```

`speaker_id` is **never** called if `transcribe()` returned empty text.

**`clear_speakers` at session start**

`StreamingTranscriber` gains a `clear_speakers_on_start: bool` field. When `true` and backend is Parakeet, `worker.clear_speakers()` is called inside the `spawn_blocking` closure in `run()`, immediately after the worker is obtained (either taken from `prewarmed_parakeet` or freshly spawned via `ParakeetWorker::spawn`) and `ensure_model` succeeds — before the `for samples in seg_rx.iter()` loop begins.

The mutable `worker` is already available at that point in the blocking thread (the existing code calls `worker.ensure_model()` there). `clear_speakers` is called right after `ensure_model` succeeds, using the same `&mut worker`. No additional locking or ownership change is required.

The Them-stream transcriber is constructed with `clear_speakers_on_start: true`. The You-stream transcriber with `false`.

**`diarization_enabled` field**

```rust
pub struct StreamingTranscriber {
    // ...existing fields...
    diarization_enabled: bool,
    clear_speakers_on_start: bool,
}
```

Builder methods: `.with_diarization(enabled: bool)`, `.with_clear_speakers_on_start(enabled: bool)`.

---

### 4. Engine (`engine.rs`)

**`on_them` closure update**

Receives `(text, speaker_id: Option<String>)`. Maps to participant fields via helper:

```rust
fn speaker_id_to_label(id: &str) -> (String, String) {
    // Expected format: "speaker_N" where N is a non-negative integer.
    // Returns (participant_id, participant_label).
    // If format is unexpected, returns ("remote_1", "Speaker A") as fallback.
    if let Some(n_str) = id.strip_prefix("speaker_") {
        if let Ok(n) = n_str.parse::<usize>() {
            return (id.to_string(), format!("Speaker {}", n + 1));
        }
    }
    ("remote_1".to_string(), "Speaker A".to_string())
}
```

| `speaker_id`        | `participant_id` | `participant_label` |
|---------------------|-----------------|---------------------|
| `Some("speaker_0")` | `"speaker_0"`   | `"Speaker 1"`       |
| `Some("speaker_1")` | `"speaker_1"`   | `"Speaker 2"`       |
| `Some("speaker_N")` | `"speaker_N"`   | `"Speaker N+1"`     |
| `None`              | `"remote_1"`    | `"Speaker A"` (existing fallback) |
| Unrecognised format | `"remote_1"`    | `"Speaker A"` (fallback) |

**`on_you` closure update**

Updated to accept the new `(text, Option<String>)` signature; the second argument is always ignored.

**`StreamingTranscriber` construction**

The Them-stream transcriber:
```rust
StreamingTranscriber::new(...)
    .with_diarization(settings.diarization_enabled)
    .with_clear_speakers_on_start(true)
```

The You-stream transcriber:
```rust
StreamingTranscriber::new(...)
    .with_diarization(false)
    .with_clear_speakers_on_start(false)
```

**`ensure_model` / pre-warm**

`parakeet_config` passes `settings.diarization_enabled` through to `ParakeetWorker::ensure_model()`, which passes it to the Python `ensure_model` command. This controls whether TitaNet is downloaded.

---

### 5. Settings (`settings.rs` + `AppSettings`)

One new field:

```rust
#[serde(default = "default_true")]
pub diarization_enabled: bool,
```

Default: `true`. Uses the existing `default_true` function.

`AppSettings` uses a hand-written `Default` impl (not `#[derive(Default)]`). The explicit struct initializer in `impl Default for AppSettings` must also include:

```rust
diarization_enabled: default_true(),
```

Without this, the field will fail to compile or silently default to `false`.

---

### 6. Frontend (`SettingsView.tsx`)

One new toggle in the Parakeet settings section:

- **Label:** "Speaker diarization"
- **Description:** "Automatically identify different speakers in call audio"
- Visible only when `sttProvider === "parakeet"`
- Bound to `diarization_enabled` setting

No changes to `TranscriptView`, `NotesView`, `SuggestionsView`, or any event schemas — `participant_label` is already rendered and stored correctly.

---

## Data Flow (full path)

1. System audio chunk arrives → VAD accumulates → speech segment fires
2. Segment sent via mpsc channel to blocking Parakeet thread
3. `worker.transcribe(samples)` → `text`
4. If `text` is empty → `on_final(text, None)`; skip to next segment
5. If `diarization_enabled` and `len(samples) ≥ MIN_SPEAKER_ID_SAMPLES`: `worker.speaker_id(samples)` → `Some("speaker_N")` or `None`
6. `on_final(text, speaker_id)` fires
7. `engine.rs` maps speaker_id to `participant_label` via `speaker_id_to_label`
8. `SessionRecord` written with correct participant fields
9. `transcript` event emitted to frontend with `participant_label: "Speaker N+1"`
10. `TranscriptView` renders the label — no logic change required

---

## What Does Not Change

- Session storage format (JSONL) — `participant_id`/`participant_label` fields already exist
- `SuggestionEngine` — filters by `Speaker::Them` regardless of participant label
- Notes generation — uses `display_label()` which already returns `participant_label` when set
- Overlay
- Whisper / FasterWhisper branches — always pass `None` as second arg to `on_final`
- Mic (You) stream — `diarization_enabled: false`, second arg always `None`

---

## Error / Degradation Path

| Failure | Behaviour |
|---------|-----------|
| TitaNet fails to load during `ensure_model` | Warning logged; `TITANET_MODEL` stays `None`; all `speaker_id` calls return error |
| `speaker_id` returns error | Warning logged; `None` passed to `on_final`; utterance gets "Speaker A" fallback |
| Segment too short (< 1 s) | Python returns `{"speaker_id": null}`; treated as `None`; utterance gets fallback |
| `speaker_id_to_label` parse failure | Returns `("remote_1", "Speaker A")` fallback |
| Non-Parakeet backend | `diarization_enabled` ignored; all utterances get "Speaker A" label |
| `diarization_enabled: false` | `speaker_id` call and TitaNet download skipped entirely |

---

## Out of Scope

- Mic stream diarization (single speaker by definition)
- Post-session re-diarization / label correction
- User-assigned speaker names (renaming "Speaker 1" to "Alice")
- Diarization for Whisper or FasterWhisper backends
- Persisting the anchor table across sessions
