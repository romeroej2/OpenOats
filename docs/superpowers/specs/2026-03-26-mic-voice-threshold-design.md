# Mic Voice Threshold (Noise Gate) — Design Spec

**Date:** 2026-03-26
**Status:** Approved

---

## Problem

The frequency-domain AEC (PBFDAF) reduces echo at the signal level, but faint residual echo
from the remote speaker leaking into the microphone can still be transcribed. The user observed
that their own speaking voice registers at a noticeably higher RMS than the echo pickup. A
noise gate that silences mic audio below a calibrated voice-level threshold will prevent these
low-level echoes from reaching the transcription engine.

---

## Goals

- Allow the user to calibrate their normal speaking voice level once via a button
- Gate mic audio: chunks whose RMS is below `calibrated_rms × multiplier` are replaced with silence
- Gating applies to both transcription output and the AEC cleaned signal (Option B user choice)
- The threshold multiplier is a persisted, user-configurable value (default 0.6)
- The calibration UI shows a live waveform bar so the user can see their mic level in real time
- No regression when calibration has not been performed (gate defaults to open/disabled)

---

## Data Model

Two new fields in `AppSettings` (`crates/opencassava-core/src/settings.rs`):

```rust
pub mic_calibration_rms: Option<f32>,  // mean top-30% block RMS from calibration; None = gate disabled
pub mic_threshold_multiplier: f32,     // fraction of calibrated RMS used as gate floor; default 0.6
```

Derived threshold at runtime:
```
threshold = mic_calibration_rms.unwrap_or(0.0) * mic_threshold_multiplier
```

If `mic_calibration_rms` is `None`, `threshold` is `0.0` and the gate is open.

---

## Component Changes

### `crates/opencassava-core/src/audio/echo_cancel.rs` — `MicEchoProcessor`

New field:
```rust
threshold: f32,  // 0.0 = disabled
```

New method:
```rust
pub fn set_threshold(&mut self, threshold: f32)
```

Behavior change in `process_chunk`, after AEC produces `cleaned`:
1. Compute `rms(&cleaned)`
2. If `rms < self.threshold && self.threshold > 0.0` → return `vec![0.0; mic.len()]`
3. Otherwise return `cleaned`

Default: `threshold = 0.0` (gate off). Existing behavior unchanged when threshold is not set.

---

### `opencassava/src-tauri/src/engine.rs`

**At session start** (`start_recording`):
- Reconstruct threshold: `let threshold = settings.mic_calibration_rms.unwrap_or(0.0) * settings.mic_threshold_multiplier;`
- Call `echo_processor.set_threshold(threshold)` after constructing the processor.

**New Tauri command: `calibrate_mic_threshold`**
1. Opens a `CpalMicCapture` on the currently selected mic device
2. Captures audio for 3 seconds
3. Computes RMS for each 256-sample block
4. Sorts block RMSes, takes the mean of the top 30% (captures active speech, ignores silent gaps)
5. Saves `settings.mic_calibration_rms = Some(mean_top_30_rms)`
6. Calls `settings.save()` to persist
7. Returns the measured RMS value to the frontend

**New Tauri commands: `start_calibration_preview` / `stop_calibration_preview`**
- `start_calibration_preview`: starts a lightweight mic capture that emits `calibration-audio-level` events every 100ms (same `{ you: f32 }` shape as the `you` field of `audio-level`)
- `stop_calibration_preview`: stops the capture and cleans up
- These commands are safe to call outside of a recording session and must not interfere with one if it is running

---

### Settings UI (`opencassava/src/components/Settings.tsx` or equivalent)

New **Mic Voice Threshold** section, placed below the echo cancellation toggle:

**When not calibrated:**
- Text: "Not calibrated — gate is disabled"
- "Calibrate" button

**Calibration flow (on button click):**
1. Call `start_calibration_preview`; show live `WaveformVisualizer` bar driven by `calibration-audio-level` events
2. Display countdown: "Speak normally… 3 / 2 / 1"
3. After 3 seconds, call `calibrate_mic_threshold`; stop preview via `stop_calibration_preview`
4. Display result: "Calibrated: [rms value]"

**When calibrated:**
- Shows current calibrated RMS value
- "Recalibrate" button (reruns the flow above)
- **Sensitivity** input: numeric input or small slider, range 0.1–1.0, step 0.05, label "Sensitivity (threshold multiplier)"
  - Updates `mic_threshold_multiplier` in settings on change
- Helper text: "Audio below this level will be silenced. Recalibrate if you change microphones."

The `WaveformVisualizer` component is reused as-is from the ControlBar.

---

## Settings Defaults

| Field | Default | Notes |
|---|---|---|
| `mic_calibration_rms` | `None` | Gate disabled until calibrated |
| `mic_threshold_multiplier` | `0.6` | 60% of speaking level |

---

## Error Handling

- If mic device is unavailable during calibration, return an error string to the frontend and show it inline
- If calibration produces a very low RMS (< 0.001, e.g. mic muted), warn the user: "Level too low — check your microphone"
- `start_calibration_preview` while a recording session is active: either reuse `audio-level` events directly, or emit `calibration-audio-level` from the existing mic stream (no duplicate capture)

---

## Testing

- Unit test: `MicEchoProcessor` with threshold set — verify that a chunk with RMS below threshold returns silence
- Unit test: threshold = 0.0 — verify all audio passes through unchanged
- Unit test: `calibrate_mic_threshold` logic (block RMS top-30% mean) as a pure function, independently testable
- Manual: calibrate with normal speech, confirm echo from speaker is silenced in subsequent recording
