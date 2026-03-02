# On The Spot v2 — SwiftUI + FluidAudio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the Python/Tkinter meeting copilot as a native SwiftUI macOS app with real-time transcription and speaker diarization using FluidAudio's CoreML pipeline.

**Architecture:** SwiftUI app with AppKit interop for the floating overlay panel. FluidAudio SDK handles all audio intelligence (STT via Parakeet, VAD via Silero, diarization). AVAudioEngine captures mic audio and feeds it to FluidAudio's StreamingEouAsrManager. Settings via UserDefaults, sessions saved as JSONL.

**Tech Stack:** Swift 5.9+, SwiftUI, AppKit (NSPanel), FluidAudio SDK, CoreML, AVAudioEngine

---

### Task 1: Create Xcode project scaffold

**Files:**
- Create: `OnTheSpot/` (Xcode project directory)
- Create: `OnTheSpot/OnTheSpot.xcodeproj`
- Create: `OnTheSpot/OnTheSpot/OnTheSpotApp.swift`
- Create: `OnTheSpot/OnTheSpot/ContentView.swift`
- Create: `OnTheSpot/OnTheSpot/Info.plist`
- Create: `OnTheSpot/OnTheSpot/OnTheSpot.entitlements`

**Step 1: Create the Xcode project via command line**

We'll use a Swift Package Manager executable target wrapped in an Xcode project. Create the directory structure:

```
OnTheSpot/
  Package.swift
  Sources/
    OnTheSpot/
      App/
        OnTheSpotApp.swift
      Views/
        ContentView.swift
      Info.plist
      OnTheSpot.entitlements
```

**Step 2: Create `Package.swift`**

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OnTheSpot",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.10.0"),
    ],
    targets: [
        .executableTarget(
            name: "OnTheSpot",
            dependencies: ["FluidAudio"],
            path: "Sources/OnTheSpot"
        ),
    ]
)
```

**Step 3: Create minimal `OnTheSpotApp.swift`**

```swift
import SwiftUI

@main
struct OnTheSpotApp: App {
    init() {
        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 700, minHeight: 500)
        }
    }
}
```

**Step 4: Create placeholder `ContentView.swift`**

```swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack {
            Text("On The Spot")
                .font(.largeTitle)
            Text("Meeting Copilot")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

**Step 5: Create `Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSMicrophoneUsageDescription</key>
    <string>On The Spot needs microphone access for real-time speech transcription during meetings.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>On The Spot uses speech recognition to transcribe meeting audio in real-time.</string>
</dict>
</plist>
```

**Step 6: Create `OnTheSpot.entitlements`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
```

**Step 7: Verify it builds and launches**

```bash
cd OnTheSpot && swift build && swift run
```

Expected: A window appears with "On The Spot / Meeting Copilot" text.

**Step 8: Commit**

```bash
git add OnTheSpot/
git commit -m "feat: create SwiftUI project scaffold with FluidAudio dependency"
```

---

### Task 2: Audio engine — mic capture and streaming to FluidAudio

**Files:**
- Create: `Sources/OnTheSpot/Audio/AudioEngine.swift`

**Step 1: Create `AudioEngine.swift`**

This class captures mic audio via AVAudioEngine, converts to 16kHz mono Float32, and feeds it to FluidAudio's StreamingEouAsrManager.

```swift
import AVFoundation
import FluidAudio

@Observable
class AudioEngine {
    var isListening = false
    var currentText = ""
    var utterances: [Utterance] = []

    private var audioEngine: AVAudioEngine?
    private var streamingManager: StreamingEouAsrManager?

    struct Utterance: Identifiable {
        let id = UUID()
        let text: String
        let timestamp: Date
        let speakerId: String?
    }

    func start() async throws {
        let manager = StreamingEouAsrManager(
            configuration: .default,
            chunkSize: .ms320,
            eouDebounceMs: 1280
        )
        try await manager.loadModels()

        manager.setEouCallback { [weak self] finalText in
            guard let self else { return }
            let utterance = Utterance(
                text: finalText,
                timestamp: Date(),
                speakerId: nil
            )
            Task { @MainActor in
                self.utterances.append(utterance)
                self.currentText = ""
            }
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: recordingFormat) { buffer, _ in
            Task {
                if let samples = try? AudioConverter.resampleBuffer(buffer) {
                    let text = try? await manager.process(audioBuffer: samples)
                    if let text {
                        await MainActor.run {
                            self.currentText = text
                        }
                    }
                }
            }
        }

        engine.prepare()
        try engine.start()

        self.audioEngine = engine
        self.streamingManager = manager
        self.isListening = true
    }

    func stop() async {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)

        if let final = try? await streamingManager?.finish() {
            if !final.isEmpty {
                let utterance = Utterance(text: final, timestamp: Date(), speakerId: nil)
                await MainActor.run {
                    self.utterances.append(utterance)
                }
            }
        }

        await streamingManager?.reset()
        audioEngine = nil
        streamingManager = nil
        isListening = false
        currentText = ""
    }
}
```

**Step 2: Verify it compiles**

```bash
swift build
```

**Step 3: Commit**

```bash
git add Sources/OnTheSpot/Audio/AudioEngine.swift
git commit -m "feat: add AudioEngine with FluidAudio streaming ASR"
```

---

### Task 3: Main window UI

**Files:**
- Modify: `Sources/OnTheSpot/Views/ContentView.swift`
- Create: `Sources/OnTheSpot/Views/TranscriptView.swift`

**Step 1: Create `TranscriptView.swift`**

```swift
import SwiftUI

struct TranscriptView: View {
    let utterances: [AudioEngine.Utterance]
    let currentText: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(utterances) { utterance in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(utterance.speakerId ?? "Speaker")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.secondary)
                                Text(utterance.timestamp, style: .time)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            Text(utterance.text)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                        .id(utterance.id)
                    }

                    if !currentText.isEmpty {
                        Text(currentText)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .id("partial")
                    }
                }
                .padding()
            }
            .onChange(of: utterances.count) {
                withAnimation {
                    proxy.scrollTo(utterances.last?.id ?? "partial", anchor: .bottom)
                }
            }
        }
    }
}
```

**Step 2: Update `ContentView.swift`**

```swift
import SwiftUI

struct ContentView: View {
    @State private var engine = AudioEngine()
    @State private var showOverlay = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading) {
                    Text("On The Spot")
                        .font(.title2.bold())
                    Text("Meeting Copilot")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack(spacing: 12) {
                    // Status pill
                    HStack(spacing: 6) {
                        Circle()
                            .fill(engine.isListening ? .red : .secondary)
                            .frame(width: 8, height: 8)
                        Text(engine.isListening ? "Listening" : "Idle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Toggle("Overlay", isOn: $showOverlay)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                }
            }
            .padding()

            Divider()

            // Transcript
            TranscriptView(
                utterances: engine.utterances,
                currentText: engine.currentText
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            // Controls
            HStack {
                Button(engine.isListening ? "Stop" : "Start") {
                    Task {
                        if engine.isListening {
                            await engine.stop()
                        } else {
                            try? await engine.start()
                        }
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .controlSize(.large)

                Spacer()

                Text("\(engine.utterances.count) utterances")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding()
        }
    }
}
```

**Step 3: Verify it builds**

```bash
swift build
```

**Step 4: Commit**

```bash
git add Sources/OnTheSpot/Views/
git commit -m "feat: add main window UI with transcript view and controls"
```

---

### Task 4: Floating overlay panel

**Files:**
- Create: `Sources/OnTheSpot/Views/OverlayPanel.swift`
- Create: `Sources/OnTheSpot/Views/OverlayContent.swift`
- Modify: `Sources/OnTheSpot/Views/ContentView.swift` (wire up overlay toggle)

**Step 1: Create `OverlayPanel.swift`**

```swift
import AppKit
import SwiftUI

class OverlayPanel: NSPanel {
    init<Content: View>(@ViewBuilder content: () -> Content) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 260),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .resizable, .closable, .titled],
            backing: .buffered,
            defer: false
        )

        sharingType = .none
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        isFloatingPanel = true
        isMovableByWindowBackground = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        backgroundColor = NSColor(white: 0.08, alpha: 0.92)
        isOpaque = false
        hasShadow = true
        animationBehavior = .utilityWindow

        contentView = NSHostingView(rootView: content().ignoresSafeArea())

        // Position in top-left
        if let screen = NSScreen.main {
            let origin = NSPoint(x: 36, y: screen.visibleFrame.maxY - 260 - 56)
            setFrameOrigin(origin)
        }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
```

**Step 2: Create `OverlayContent.swift`**

```swift
import SwiftUI

struct OverlayContent: View {
    let currentText: String
    let lastUtterance: AudioEngine.Utterance?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("On The Spot")
                    .font(.headline)
                Spacer()
                Text("Esc to hide")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if let utterance = lastUtterance {
                VStack(alignment: .leading, spacing: 4) {
                    Text(utterance.speakerId ?? "Speaker")
                        .font(.caption.bold())
                        .foregroundStyle(.blue)
                    Text(utterance.text)
                        .font(.body)
                        .lineLimit(4)
                }
            }

            if !currentText.isEmpty {
                Text(currentText)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            if lastUtterance == nil && currentText.isEmpty {
                Text("Waiting for speech...")
                    .font(.body)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
```

**Step 3: Wire overlay into ContentView and App**

Add overlay panel management to `OnTheSpotApp.swift` — create/show/hide the panel based on the `showOverlay` state, register global hotkeys (Esc to hide, Cmd+Shift+O to toggle).

**Step 4: Verify it builds**

```bash
swift build
```

**Step 5: Commit**

```bash
git add Sources/OnTheSpot/Views/OverlayPanel.swift Sources/OnTheSpot/Views/OverlayContent.swift
git commit -m "feat: add floating overlay panel with screen-share invisibility"
```

---

### Task 5: Speaker diarization integration

**Files:**
- Create: `Sources/OnTheSpot/Audio/DiarizationEngine.swift`
- Modify: `Sources/OnTheSpot/Audio/AudioEngine.swift` (add speaker labeling)

**Step 1: Create `DiarizationEngine.swift`**

Run FluidAudio's offline diarizer on accumulated audio to identify speakers. Since diarization is batch-only, accumulate audio and run periodically.

```swift
import FluidAudio

actor DiarizationEngine {
    private var manager: OfflineDiarizerManager?
    private var accumulatedSamples: [Float] = []

    func prepare() async throws {
        let config = OfflineDiarizerConfig()
        let manager = OfflineDiarizerManager(config: config)
        try await manager.prepareModels()
        self.manager = manager
    }

    func appendSamples(_ samples: [Float]) {
        accumulatedSamples.append(contentsOf: samples)
    }

    func identifySpeakers() async throws -> [DiarizationSegment] {
        guard let manager, accumulatedSamples.count > 16000 * 10 else { return [] }
        let result = try await manager.process(audio: accumulatedSamples)
        return result.segments.map { segment in
            DiarizationSegment(
                speakerId: segment.speakerId,
                startTime: segment.startTimeSeconds,
                endTime: segment.endTimeSeconds
            )
        }
    }
}

struct DiarizationSegment {
    let speakerId: String
    let startTime: Double
    let endTime: Double
}
```

**Step 2: Integrate with AudioEngine**

Update `AudioEngine` to accumulate raw audio samples, run diarization periodically (every ~30s), and label utterances with speaker IDs.

**Step 3: Verify it builds**

```bash
swift build
```

**Step 4: Commit**

```bash
git add Sources/OnTheSpot/Audio/DiarizationEngine.swift
git commit -m "feat: add speaker diarization engine"
```

---

### Task 6: Session storage

**Files:**
- Create: `Sources/OnTheSpot/Storage/SessionStore.swift`

**Step 1: Create `SessionStore.swift`**

```swift
import Foundation

class SessionStore {
    private let sessionsDir: URL
    private var currentFile: URL?
    private var fileHandle: FileHandle?

    init() {
        sessionsDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("On The Spot/sessions")
        try? FileManager.default.createDirectory(at: sessionsDir, withIntermediateDirectories: true)
    }

    func startSession() {
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        currentFile = sessionsDir.appendingPathComponent("\(stamp).jsonl")
        FileManager.default.createFile(atPath: currentFile!.path, contents: nil)
        fileHandle = try? FileHandle(forWritingTo: currentFile!)
    }

    func append(utterance: AudioEngine.Utterance) {
        guard let fileHandle else { return }
        let entry: [String: Any] = [
            "text": utterance.text,
            "timestamp": ISO8601DateFormatter().string(from: utterance.timestamp),
            "speaker": utterance.speakerId ?? "unknown"
        ]
        if let data = try? JSONSerialization.data(withJSONObject: entry),
           let line = String(data: data, encoding: .utf8) {
            fileHandle.write(Data((line + "\n").utf8))
        }
    }

    func endSession() {
        try? fileHandle?.close()
        fileHandle = nil
        currentFile = nil
    }
}
```

**Step 2: Integrate with AudioEngine**

Start a session when listening begins, append each utterance, end when stopped.

**Step 3: Commit**

```bash
git add Sources/OnTheSpot/Storage/SessionStore.swift
git commit -m "feat: add JSONL session storage"
```

---

### Task 7: Settings and keyboard shortcuts

**Files:**
- Create: `Sources/OnTheSpot/Settings/AppSettings.swift`
- Modify: `Sources/OnTheSpot/App/OnTheSpotApp.swift` (add keyboard shortcuts)

**Step 1: Create `AppSettings.swift`**

```swift
import SwiftUI

class AppSettings: ObservableObject {
    @AppStorage("overlayEnabled") var overlayEnabled = false
    @AppStorage("eouDebounceMs") var eouDebounceMs = 1280
    @AppStorage("chunkSize") var chunkSize = "320"
}
```

**Step 2: Add global keyboard shortcuts**

In the app, register:
- `Esc` — hide overlay (panic key)
- `Cmd+Shift+O` — toggle overlay

**Step 3: Commit**

```bash
git add Sources/OnTheSpot/Settings/
git commit -m "feat: add settings and keyboard shortcuts"
```

---

### Task 8: Build, sign, and package as .app

**Files:**
- Create: `scripts/build_swift_app.sh`
- Modify: `.github/workflows/release-dmg.yml`

**Step 1: Create `scripts/build_swift_app.sh`**

Build the Swift package, create a proper .app bundle from the executable, embed Info.plist and entitlements, code sign.

**Step 2: Update GitHub Actions workflow**

Replace the PyInstaller build steps with `swift build -c release` and the new packaging script.

**Step 3: Test locally**

```bash
chmod +x scripts/build_swift_app.sh
./scripts/build_swift_app.sh
./scripts/make_dmg.sh
```

Verify: DMG opens, app launches, mic permission prompt appears, transcription works.

**Step 4: Commit**

```bash
git add scripts/build_swift_app.sh .github/workflows/release-dmg.yml
git commit -m "feat: add Swift build and packaging scripts"
```

---

### Task 9: End-to-end verification

**Step 1:** Launch the app from the DMG
**Step 2:** Grant mic permission when prompted
**Step 3:** Click "Start" — verify models download and transcription begins
**Step 4:** Speak — verify text appears in transcript with speaker labels
**Step 5:** Toggle overlay — verify it floats and shows latest text
**Step 6:** Press Esc — verify overlay hides immediately
**Step 7:** Start a screen share (Zoom/Meet) — verify overlay is not visible to others
**Step 8:** Click "Stop" — verify session is saved to `~/Library/Application Support/On The Spot/sessions/`
