# Design: Audio Device Selection, Duplicate Removal & Language Model Fix

**Date:** 2026-03-19
**Status:** Approved

---

## Problem Summary

Three related issues in the OpenOats Tauri app:

1. **System audio not selectable** — WASAPI loopback capture runs automatically as the "them" track but always uses the default render device. There is no UI to choose a different output device to loop back from.
2. **Duplicate mic selector** — A microphone dropdown exists in both `ControlBar.tsx` (working, populates device list) and `SettingsView.tsx` > Advanced > Audio Input (broken, never populates device list, always shows "System Default" only).
3. **Language selector has no effect** — The transcription locale is saved and passed to Whisper correctly, but the downloaded model is `ggml-base.en.bin` — the English-only variant — which ignores the language parameter entirely.

---

## Decisions

- System audio: add a device dropdown in `ControlBar` (Option A) — mirrors the mic selector pattern, visible and quick to change before recording.
- Duplicate mic selector: remove the broken one from `SettingsView` entirely.
- Language model: keep both models (`base-en` and `base`), add an explicit user-facing toggle in Settings > Advanced > Transcription (Option A/B hybrid). Default stays `base-en` to preserve existing behaviour.

---

## Data Model Changes

### `AppSettings` — two new fields

| Field | Type | Default | Description |
|---|---|---|---|
| `systemAudioDeviceName` | `Option<String>` / `string \| null` | `null` | Selected loopback device. `null` = system default. |
| `whisperModel` | `String` / `string` | `"base-en"` | `"base-en"` or `"base"`. Controls which model file is used. |

### Model filenames

| Setting value | Filename | Notes |
|---|---|---|
| `"base-en"` | `ggml-base.en.bin` | English-only, existing behaviour |
| `"base"` | `ggml-base.bin` | Multilingual Whisper base model |

Both files live in the app data directory. Only the selected model needs to be downloaded.

---

## Backend Changes

### New Tauri command: `list_sys_audio_devices`

```
list_sys_audio_devices() -> Vec<String>
```

- **Windows:** enumerates WASAPI render endpoints via `IMMDeviceEnumerator::EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)`, returns friendly names.
- **macOS:** delegates to `audio_macos` module device enumeration.
- **Other:** returns empty vec.
- Registered in `lib.rs` `invoke_handler`.

### `SystemAudioCapture` — optional device selection

`WasapiLoopback::new()` gains a `device_name: Option<&str>` parameter:
- `Some(name)`: enumerate render endpoints, find the one with matching friendly name, use it for loopback capture.
- `None`: fall back to `GetDefaultAudioEndpoint` (existing behaviour, no regression).

### `start_transcription` — reads `systemAudioDeviceName`

Reads `settings.system_audio_device_name` and passes it to `SystemAudioCapture::new()`, following the same pattern as `input_device_name` for mic selection.

### `AppState::model_path` — settings-aware

`model_path` is updated to accept the `whisper_model` setting value:

```rust
fn model_filename(whisper_model: &str) -> &'static str {
    match whisper_model {
        "base" => "ggml-base.bin",
        _ => "ggml-base.en.bin",  // default / "base-en"
    }
}
```

`check_model` and `download_model` both read `settings.whisper_model` before resolving the path, so they operate on the correct file.

---

## Frontend Changes

### `ControlBar.tsx` — system audio device selector

A second `<select>` is added immediately after the mic selector:

- Populated on mount via `invoke<string[]>("list_sys_audio_devices")`.
- First option: `"🔊 System Default"` (value `"default"`).
- Disabled while `isRunning` (same as mic selector).
- `onChange` reads current settings, writes `systemAudioDeviceName: value === "default" ? null : value` via `save_settings`.
- Component manages its own `selectedSysDevice` state internally — no new props needed.

### `SettingsView.tsx` — remove duplicate mic selector

Delete the entire "Audio Input" subsection from the Advanced tab (currently lines 678–694). The ControlBar is the canonical location for audio device selection.

### `SettingsView.tsx` — model selector in Transcription section

Added below the locale input in Advanced > Transcription:

```
Whisper Model
  ● English only (base-en)   [✓ ready]
  ○ Multilingual (base)       [Download ~142 MB]
```

- Radio group bound to `settings.whisperModel`.
- Each option shows a `✓ ready` badge if the corresponding file exists (checked via `check_model` with model variant), or a `Download` button if not.
- Clicking Download triggers the existing `download_model` flow (with model variant passed).
- Switching to an already-downloaded model takes effect immediately on next recording start.
- Switching to a model not yet downloaded shows the Download button but does not auto-start a download.

### `types.ts`

Add to `AppSettings`:

```typescript
systemAudioDeviceName: string | null;
whisperModel: string;
```

---

## Error Handling

- If `list_sys_audio_devices` fails, the system audio selector shows only "System Default" — graceful degradation, no crash.
- If the selected system audio device is unavailable at capture time, `buffer_stream()` logs a warning and returns an empty stream (existing behaviour, "them" track simply produces no audio).
- If `whisperModel` is an unrecognised value, the backend defaults to `base-en`.

---

## Out of Scope

- Selecting per-channel sample rate or bit depth.
- Showing real-time audio level for the system audio device in the selector.
- Auto-switching models based on locale.
