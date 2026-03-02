# On The Spot v2 — SwiftUI + FluidAudio Rewrite

## Goal

Replace the Python/Tkinter app with a native SwiftUI macOS app using FluidAudio's CoreML pipeline for real-time transcription with speaker diarization during meetings.

## Architecture

Pure Swift. No Python, no Electron, no web views.

- **UI**: SwiftUI with AppKit interop for overlay (`NSPanel`)
- **Speech**: FluidAudio SDK — Parakeet TDT v3 (CoreML) for transcription, Parakeet EOU 120M for real-time end-of-utterance detection, Silero VAD for voice activity detection, speaker diarization for identifying who's talking
- **Audio**: `AVAudioEngine` for mic capture, feeding FluidAudio's `StreamingEouAsrManager`
- **Storage**: `@AppStorage` for settings, JSONL files for sessions
- **Overlay**: `NSPanel` with `sharingType = .none` (best-effort screen-share invisibility)

## v1 Features

### Main Window
- Start/stop live transcription button
- Real-time transcript view with speaker labels (color-coded per speaker)
- Status indicator (idle / listening / transcribing)
- Toggle overlay checkbox
- Model download progress on first launch

### Overlay
- Floating `NSPanel`, always on top
- Shows latest transcribed text with speaker label
- Dark translucent appearance
- Best-effort invisible to screen sharing (`sharingType = .none`)
- Resizable and draggable
- Esc = panic hide
- Cmd+Shift+O = toggle

### Session Management
- Auto-save transcripts to `~/Library/Application Support/On The Spot/sessions/`
- JSONL format with timestamps and speaker IDs

## Out of Scope for v1

- Knowledge base / TF-IDF search
- Suggestions engine
- Audio file transcription
- Language picker (Parakeet v3 handles 25 languages automatically)

## Key Technical Decisions

1. **FluidAudio over Apple SpeechAnalyzer** — Speaker diarization is essential for a meeting copilot. FluidAudio provides STT + VAD + diarization in one pipeline. Apple's SpeechAnalyzer has slightly better accuracy but zero diarization capability.
2. **NSPanel over NSWindow** — Panels float above other windows without taking focus, and `sharingType = .none` provides best-effort screen-share invisibility.
3. **Xcode project** — Required for proper entitlements, Info.plist, code signing, and notarization. FluidAudio added as SPM dependency.
4. **CoreML on Apple Neural Engine** — All models run on the ANE, not CPU/GPU. Low power, fast inference.

## Dependencies

- [FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache 2.0) — SPM package
  - Parakeet TDT v3 CoreML (~600MB, auto-downloaded on first launch)
  - Parakeet EOU 120M CoreML (streaming end-of-utterance)
  - Silero VAD CoreML (voice activity detection)
  - Speaker diarization CoreML (up to 4 speakers)

## Signing & Distribution

Reuse the existing Developer ID Application certificate (Yazin Alirhayim, team B6CT95J3J5). Update GitHub Actions to compile Swift via `xcodebuild` instead of PyInstaller. Same notarization flow.
