# OpenOats Multiplatform Design Spec
**Date:** 2026-03-18
**Status:** Approved

## Overview

Migrate OpenOats from a split Mac-only Swift app + minimal Windows Tauri stub into a fully unified, feature-complete cross-platform app. The target architecture is a shared Rust core library (`openoats-core`) powering a single Tauri app with a shared React/TypeScript UI on both Windows and macOS.

The migration follows an incremental strategy: keep the Mac Swift app shipping while building Windows to full feature parity, then replace the Mac Swift app with the Tauri app.

---

## Architecture

### Repository Structure

```
OpenOats (monorepo)
├── crates/
│   └── openoats-core/           # Rust library — all business logic
│       └── src/
│           ├── lib.rs
│           ├── models.rs         # Utterance, Speaker, Session, Suggestion, ConversationState, etc.
│           ├── settings.rs       # AppSettings (cross-platform JSON persistence via dirs crate)
│           ├── keychain.rs       # Secret storage (keyring crate)
│           ├── audio/
│           │   ├── mod.rs        # AudioCaptureService + MicCaptureService traits
│           │   └── cpal_mic.rs   # Cross-platform mic capture (CPAL)
│           ├── transcription/
│           │   ├── mod.rs
│           │   ├── vad.rs        # Energy-based VAD (unified threshold)
│           │   ├── whisper.rs    # WhisperManager (whisper-rs wrapper)
│           │   ├── streaming_transcriber.rs  # VAD + whisper pipeline
│           │   └── engine.rs     # TranscriptionEngine (mic + system audio orchestration)
│           ├── storage/
│           │   ├── mod.rs
│           │   ├── session_store.rs    # JSONL + sidecar session persistence
│           │   ├── template_store.rs   # Template CRUD (JSON)
│           │   └── transcript_logger.rs
│           └── intelligence/
│               ├── mod.rs
│               ├── llm_client.rs       # OpenRouter + Ollama HTTP clients
│               ├── embedding_client.rs # Voyage AI + Ollama + OpenAI-compatible
│               ├── knowledge_base.rs   # KB loading, chunking, embedding cache
│               ├── suggestion_engine.rs
│               └── notes_engine.rs
│
├── OpenOatsTauri/
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── lib.rs            # Tauri commands — thin bridge to openoats-core
│   │       ├── audio_windows.rs  # WASAPI loopback (system audio, "them") — Phase 2
│   │       └── audio_mac.rs      # CoreAudio tap (system audio, Mac) — Phase 3
│   └── src/                      # React/TypeScript UI (shared across platforms)
│       ├── components/
│       │   ├── ControlBar.tsx
│       │   ├── TranscriptView.tsx
│       │   ├── SuggestionsView.tsx
│       │   ├── NotesView.tsx
│       │   ├── SettingsView.tsx
│       │   ├── OnboardingView.tsx
│       │   └── ConsentModal.tsx
│       ├── App.tsx
│       └── main.tsx
│
├── Sources/OpenOatsMac/          # Kept shipping through Phase 2
├── Sources/OpenOatsCore/         # Deprecated after Phase 3
├── Sources/OpenOatsWindows/      # Deprecated after Phase 3
└── Package.swift                 # Simplified or removed in Phase 4
```

### Principles

- `openoats-core` owns all business logic. It has no Tauri dependency.
- `src-tauri` is a thin command adapter — it wires Tauri commands/events to core functions.
- Platform-specific audio implementations (WASAPI loopback, CoreAudio tap) live in `src-tauri` and are injected into core at app startup via trait objects.
- The React UI is fully shared between Windows and Mac — no platform-specific UI code.

---

## Migration Phases

### Phase 1 — Rust Core Foundation
**Goal:** Establish `openoats-core` crate and migrate existing Tauri inline code into it. Windows app gains session persistence and settings.

Tasks:
- Create `crates/openoats-core` with workspace `Cargo.toml`
- Move existing `audio.rs`, `transcriber.rs` from `src-tauri/src` into `openoats-core`
- Port `models.rs` (Utterance, Speaker, Session, Suggestion, ConversationState, etc.) from Swift to Rust
- Implement `AppSettings` in Rust using `dirs` + `serde_json` (JSON file in app data dir)
- Implement `keychain.rs` using `keyring` crate
- Implement `SessionStore` in Rust (JSONL + `.meta.json` sidecar, same format as Swift)
- Wire updated Tauri commands to core
- Windows app now persists sessions across restarts

**Deliverable:** Windows app with audio, transcription, session persistence, and settings storage.

### Phase 2 — Windows Feature Parity
**Goal:** Windows Tauri app reaches full feature parity with the Mac Swift app.

Tasks:
- System audio capture via WASAPI loopback (`audio_windows.rs`) — enables "them" speaker
- `LLMClient`: OpenRouter + Ollama HTTP clients (`reqwest` + `tokio`)
- `EmbeddingClient`: Voyage AI + Ollama + OpenAI-compatible
- `KnowledgeBase`: file loading, chunking, cosine similarity search, JSON embedding cache
- `SuggestionEngine`: trigger detection, KB retrieval, LLM surfacing gate
- `NotesEngine`: template-based notes generation
- `TemplateStore` in Rust
- React UI components: SettingsView, SuggestionsView, NotesView, SessionHistoryView, OnboardingView, ConsentModal, ControlBar with mic selector
- Recording consent gate before first session
- Screen-share content protection (`content_protection` Tauri capability)
- Floating always-on-top overlay window mode

**Deliverable:** Windows Tauri app feature-complete, ready for user testing.

### Phase 3 — Mac Tauri Migration
**Goal:** Replace OpenOatsMac Swift app with the Tauri app running on macOS.

Tasks:
- macOS system audio capture via CoreAudio AudioDeviceTap (`audio_mac.rs`)
- macOS permissions flow: microphone + screen recording via Tauri capabilities
- Validate overlay/floating window behavior on macOS
- Test screen-share hiding on macOS (`content_protection`)
- End-to-end validation on Mac
- Deprecate `OpenOatsMac` Swift executable

**Deliverable:** Single Tauri app shipping on both Windows and Mac.

### Phase 4 — Swift Cleanup
**Goal:** Remove all Swift code and simplify the repository.

Tasks:
- Remove `Sources/OpenOatsCore`
- Remove `Sources/OpenOatsMac`
- Remove `Sources/OpenOatsWindows`
- Simplify or remove `Package.swift`
- Update CI/build scripts

**Deliverable:** Clean Rust + React monorepo with no Swift dependency.

---

## Key Technical Decisions

| Concern | Solution | Rationale |
|---|---|---|
| Mic capture | `cpal` (existing) | Already working cross-platform |
| System audio Windows | WASAPI loopback via `windows-rs` | Native, no extra deps, captures all output audio |
| System audio Mac | CoreAudio AudioDeviceTap via `coreaudio-rs` | Equivalent to ScreenCaptureKit approach |
| Secret storage | `keyring` crate | Abstracts Windows Credential Manager + macOS Keychain |
| Settings persistence | JSON file via `dirs` + `serde_json` | Portable, no platform-specific APIs needed |
| HTTP / API clients | `reqwest` + `tokio` | Standard async Rust HTTP, replaces Swift URLSession |
| Vector search / KB | Cosine similarity in Rust, JSON cache | No external DB needed at this scale |
| Frontend ↔ Backend | Tauri invoke (commands) + emit (events) | Already established pattern in codebase |
| Logging | `log` crate + Tauri log plugin | Replaces `/tmp/openoats.log` hack |
| Window overlay | Tauri `always_on_top` + `decorations: false` | Cross-platform Tauri config |
| Screen-share hiding | Tauri `content_protection` capability | Maps to OS APIs on each platform |
| UI framework | React + TypeScript (existing) | Already in repo, shared across platforms |

---

## UI Component Map

| SwiftUI (Mac) | React Component | Description |
|---|---|---|
| `ContentView` | `App.tsx` | Top-level layout shell |
| `ControlBar` | `ControlBar.tsx` | Start/stop, mic selector, status indicator |
| `TranscriptView` | `TranscriptView.tsx` | Utterance list, auto-scroll, you/them labels |
| `SuggestionsView` | `SuggestionsView.tsx` | AI suggestion cards, helpful/not helpful feedback |
| `NotesView` | `NotesView.tsx` | Generated notes markdown display, template picker |
| `SettingsView` | `SettingsView.tsx` | Tabbed: transcription, LLM, embeddings, KB, privacy |
| `OnboardingView` | `OnboardingView.tsx` | First-run wizard |
| `RecordingConsentView` | `ConsentModal.tsx` | Must-acknowledge modal before first session |
| `OverlayPanel` | Tauri window config | Floating always-on-top window |
| `CheckForUpdatesView` | Tauri updater plugin | Deferred to Phase 3+ |

**State management:** React context + hooks. No external state library. Tauri events feed into React state via `listen()`.

---

## Gaps & Optimizations

The following issues were identified in the current codebase and will be fixed during migration:

### Bugs / Gaps
1. `WindowsExports.swift` — all C-binding stubs are empty, never connected to Tauri. Removed in Phase 4.
2. `resolvedMicDeviceID()` in `TranscriptionEngine.swift` always returns input unchanged — mic device selection is broken. Fixed when porting engine to Rust.
3. `WhisperManager.transcribe()` hardcodes `language = "en"`, ignoring `AppSettings.transcriptionLocale`. Fixed in Rust port.
4. `diagLog()` writes to `/tmp/openoats.log` — invalid path on Windows. Replaced with `log` crate + Tauri log plugin.
5. `KeychainHelper` Windows fallback stores secrets in plain `UserDefaults`. Fixed with `keyring` crate in Phase 1.
6. System audio ("them" speaker) completely absent on Windows. Addressed in Phase 2.
7. Tauri transcript events only emit `speaker: "you"` — "them" path never fires. Fixed when system audio is added.

### Optimizations
1. VAD threshold inconsistency: Swift uses `0.0001` (energy), Rust uses `0.005` (RMS). Unified in `openoats-core/vad.rs`.
2. Rust `sync_channel(500)` buffer size hardcoded. Made configurable via settings.
3. `build_mic_stream` only handles `F32` and `I16` sample formats. `U16` added.
4. Model path hardcoded to `ggml-base.en.bin` — no model switching. Wired to settings in core.
5. `SuggestionEngine` delayed write hardcoded to 5 seconds. Made configurable.

---

## Progress Tracking

- [ ] **Phase 1 — Rust Core Foundation**
  - [ ] Create `crates/openoats-core` with workspace Cargo.toml
  - [ ] Move audio + transcription into core crate
  - [ ] Port data models to Rust
  - [ ] Implement AppSettings (JSON persistence)
  - [ ] Implement keychain (keyring crate)
  - [ ] Implement SessionStore (JSONL + sidecar)
  - [ ] Wire Tauri commands to core

- [ ] **Phase 2 — Windows Feature Parity**
  - [ ] WASAPI loopback system audio capture
  - [ ] LLM client (OpenRouter + Ollama)
  - [ ] Embedding client (Voyage + Ollama + OpenAI-compatible)
  - [ ] KnowledgeBase (load, chunk, embed, search)
  - [ ] SuggestionEngine
  - [ ] NotesEngine + TemplateStore
  - [ ] React: ControlBar with mic selector
  - [ ] React: SuggestionsView
  - [ ] React: NotesView + template picker
  - [ ] React: SettingsView (all tabs)
  - [ ] React: SessionHistoryView
  - [ ] React: OnboardingView
  - [ ] React: ConsentModal
  - [ ] Screen-share content protection
  - [ ] Floating overlay window mode

- [ ] **Phase 3 — Mac Tauri Migration**
  - [ ] CoreAudio system audio capture (Mac)
  - [ ] macOS permissions flow (mic + screen recording)
  - [ ] Overlay window validation on Mac
  - [ ] End-to-end Mac validation
  - [ ] Deprecate OpenOatsMac Swift app

- [ ] **Phase 4 — Swift Cleanup**
  - [ ] Remove Sources/OpenOatsCore
  - [ ] Remove Sources/OpenOatsMac
  - [ ] Remove Sources/OpenOatsWindows
  - [ ] Simplify/remove Package.swift
  - [ ] Update CI/build scripts
