# OpenCassava

<p align="center">
  <img src="assets/opencassava_logo.png" width="128" alt="OpenCassava Logo" />
</p>

**A meeting note-taker that talks back - now on Windows and Mac.**

> **Disclaimer & Acknowledgement:** OpenCassava is a descendant of the excellent [OpenOats](https://github.com/yazinsai/OpenOats) project created by [yazinsai](https://github.com/yazinsai). A huge thank you to the original creator for laying the groundwork for this application. OpenCassava has now evolved into its own dedicated project with a focus on comprehensive cross-platform support and expanded features.

<p align="center">
  <a href="https://github.com/romeroej2/OpenCassava/releases/latest">
    <img src="https://img.shields.io/badge/Download_for_Windows-EXE-black?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" />
  </a>
  &nbsp;
  <a href="https://github.com/romeroej2/OpenCassava/releases/latest">
    <img src="https://img.shields.io/badge/Download_for_macOS-DMG-silver?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" />
  </a>
  &nbsp;
  <a href="https://github.com/romeroej2/OpenCassava/releases/latest">
    <img src="https://img.shields.io/badge/Download_for_Linux-DEB-orange?style=for-the-badge&logo=linux&logoColor=white" alt="Download for Linux" />
  </a>
</p>

OpenCassava sits next to your call, transcribes both sides of the conversation in real time, and searches your own notes to surface talking points right when you need them.

For first-time setup with LM Studio, start here: [LM Studio Setup Guide](docs/lm-studio-setup.md)

<p align="center">
  <img src="assets/image.png" width="360" alt="OpenCassava during a call - suggestions drawn from your own notes appear at the top, live transcript below" />
</p>


## Contributing

Found a bug or have an idea? [Open an issue](https://github.com/romeroej2/OpenCassava/issues). PRs encouraged.



## Features

### During a live call

- **Invisible to the other side** - the overlay window is hidden from screen sharing by default, so no one knows you're using it.
- **Live transcript + instant search** - see both sides of the conversation in real time, search while people are speaking, and copy/export when needed.
- **Smarter call capture** - built-in echo cancellation suppresses speaker bleed into your mic, and a configurable mic voice threshold reduces low-level noise.
- **Push-to-talk mic mode** - switch mic capture between always-on and push-to-talk, then hold the live trigger button or your chosen shortcut to send mic audio to transcription only while you are speaking.
- **Auto summaries while you talk** - generate periodic summaries (30 seconds to 10 minutes), review summary history, and regenerate on demand.
- **Contextual talking points** - when the conversation hits a key moment, OpenCassava retrieves related knowledge and suggests useful responses.

### Knowledge and note workflows

- **Obsidian vault integration** - connect a local Obsidian vault, choose which folders feed suggestions, and publish canonical meeting notes back into the vault.
- **Knowledge base search** - use selected Obsidian folders or a legacy folder of `.md`/`.txt` notes and retrieve relevant passages with embeddings.
- **Custom prompts and templates** - tailor prompts for retrieval, suggestions, question generation, and post-call note formatting.
- **Structured note generation** - convert transcripts into clean markdown notes using built-in or custom templates, then keep a canonical copy in Obsidian.
- **Session history** - every session is automatically saved and accessible from the History sidebar.

### AI & deployment flexibility

- **Runs 100% locally** - tested primarily with LM Studio for LLM suggestions and local embeddings; no audio has to leave your device.
- **Flexible AI providers** - use local providers like Ollama, or cloud endpoints through OpenRouter and OpenAI-compatible APIs.
- **Multi-language transcription** - supports `whisper-rs`, [NVIDIA Parakeet](https://github.com/NVIDIA/NeMo), and [Omni-ASR](https://github.com/facebookresearch/omnilingual-asr) (1,600+ languages) for local speech recognition.
- **Omni-ASR on Windows** - multilingual Omni-ASR runs via WSL2 on Windows. The app guides you through setup automatically.

---

## Product Design

OpenCassava is designed for high-pressure conversations (interviews, sales calls, support escalations, technical meetings) where speed and clarity matter.

### Design principles

- **Stay out of the way:** an always-available overlay that doesn't steal focus from your call.
- **Readability first:** high-contrast dark UI, clear grouping, and low visual noise so you can skim under pressure.
- **Fast path to value:** get useful output in seconds (transcript, suggestions, summary) with minimal setup friction.
- **Progressive power:** simple defaults for first-time users with advanced controls in Settings for deeper customization.
- **Privacy by architecture:** local-first transcription and local model support are built into the core workflow.

### Interface map

- **Control Bar** — start/stop sessions, status, and live session actions.
- **Suggestions View** — real-time AI guidance sourced from your knowledge base.
- **Transcript View** — dual-speaker timeline for "you" and "them".
- **Search + Export** — quickly find moments and export transcript artifacts.
- **Notes View** — generated notes and template-based post-call output.
- **Session Sidebar** — access and review prior sessions.
- **Settings** — provider setup, prompts, transcription options, and knowledge base pathing.

---

## How it works

1. You start a call and click **Start Session**.
2. OpenCassava captures your microphone and (on Windows & Mac) system audio - the other side's voice is captured as "them".
3. If **Settings -> General -> Audio & Capture -> Mic Capture Mode** is set to **Push to talk**, the mic is only sent to speech-to-text while you hold the live **Hold to talk** button or your configured in-app shortcut.
4. As important moments happen, it searches your selected Obsidian knowledge folders (or legacy knowledge base folder) and surfaces relevant talking points.
5. During or after the call, use summaries and note templates to turn raw dialogue into structured documentation.
6. When the session ends, OpenCassava can publish a canonical note into Obsidian and reindex it for future suggestions.
7. Review, search, and export session artifacts from Session History.

---

## Downloads

Grab the latest release for your platform from the [Releases page](https://github.com/romeroej2/OpenCassava/releases/latest).

On every tag push, GitHub Actions publishes installers for all supported desktop platforms:

- Windows: EXE and MSI
- macOS: DMG
- Linux: DEB

### Build from source

**Requirements:**
- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) 18+
- Xcode Command Line Tools (macOS only)

```bash
# Clone the repo
git clone https://github.com/romeroej2/OpenCassava.git
cd OpenCassava

# Build the Tauri app
cd opencassava
npm install
npm run tauri -- build
```

The installers are output to `opencassava/src-tauri/target/release/bundle/`.

---

## What you need

### Windows & macOS

- **OS:** Windows 10/11 (64-bit) or macOS 15+ (Apple Silicon)
- **For local mode (Tested):** LM Studio (or [Ollama](https://ollama.com/)) running locally with your preferred models. For LM Studio, use `text-embedding-nomic-embed-text-v1.5` for embeddings. For Ollama, use `nomic-embed-text`.
- **For cloud mode (Untested):** [OpenRouter](https://openrouter.ai/) API key + [Voyage AI](https://www.voyageai.com/) API key.
- **For OpenAI-compatible embeddings:** any server implementing `/v1/embeddings`.

### Python-based STT engines

The following engines require Python 3 to be installed on your system:

| Engine | Platform | Python Requirement |
|---|---|---|
| `faster-whisper` | Windows, macOS, Linux | Python 3 on native system PATH |
| `parakeet` | Windows, macOS, Linux | Python 3 on native system PATH |
| `omni-asr` | macOS, Linux | Python 3 on native system PATH |
| `omni-asr` | **Windows** | **WSL2** with Python 3 inside it |

**`omni-asr` on Windows (WSL2 setup):**

1. Open PowerShell as Administrator and run:
   ```
   wsl --install
   ```
2. After reboot, open the WSL terminal (Ubuntu) and run:
   ```
   sudo apt update && sudo apt install -y python3 python3-venv python3-pip
   ```
3. In OpenCassava, go to **Settings → Advanced**, select `Omni-ASR`, and click **Set up Omni-ASR**.

The app will detect missing prerequisites automatically and show guided setup steps in the Settings UI.

---

## Quick start

1. Open the app and grant microphone permissions (and system audio recording on Windows).
2. Open Settings (`Cmd+,` or `Ctrl+,`) and configure your chosen cloud or local providers.
3. In **Settings -> General**, either connect a local Obsidian vault or point OpenCassava at a legacy folder of `.md` or `.txt` files.
4. Optional: in **Settings -> General -> Audio & Capture**, switch **Mic Capture Mode** to **Push to talk** and record a shortcut if you only want your mic forwarded while a trigger is held.
5. Click **Start Session** to go live. If push-to-talk is enabled, use the live **Hold to talk** control in the capture panel or your configured shortcut while the app window is focused. *(The first run downloads the required local Whisper speech model.)*

---

## Obsidian

OpenCassava integrates with Obsidian through the local filesystem. This release does not require an Obsidian plugin, MCP server, or URI-based integration.

### Setup

1. Open **Settings -> General -> Obsidian**.
2. Choose your local Obsidian vault folder.
3. Add one or more vault-relative folders to include in the knowledge base.
4. Optionally choose a default notes template for automatic post-call note generation.

### What OpenCassava reads

- The vault folders you explicitly add under the Obsidian knowledge base include list.
- The canonical notes that OpenCassava publishes under `OpenCassava/Meetings`.
- Markdown and text files (`.md` and `.txt`).

### What OpenCassava does not index

- `.obsidian`
- `OpenCassava/Transcripts`
- Non-text attachments and other unsupported file types

### What OpenCassava writes

- Canonical meeting notes go to `OpenCassava/Meetings/YYYY/MM/<session_id>.md`.
- Transcript companion files go to `OpenCassava/Transcripts/YYYY/MM/<session_id>.md`.
- Internal session data still remains in the app's normal storage under AppData. Obsidian is the human-readable knowledge layer, not a replacement for internal session persistence.

### Behavior and clarifications

- The canonical Obsidian note is generated automatically when a session stops.
- If you manually regenerate notes later, OpenCassava rewrites the same canonical Obsidian note for that session instead of creating duplicates.
- `OpenCassava/Transcripts` is intentionally excluded from retrieval so raw transcripts do not pollute suggestions.
- Once an Obsidian vault is connected, the legacy knowledge base folder setting is kept only for backwards compatibility and is ignored for retrieval.
- Suggestion sources are shown using vault-relative paths so you can see exactly which note and section was retrieved.

---

## Architecture

OpenCassava is built on a cross-platform Rust core with a shared React frontend.

| Component | Technology |
|---|---|
| Framework | [Tauri 2](https://tauri.app/) |
| Core logic | Rust (`opencassava-core`) |
| Transcription | whisper-rs (default) · faster-whisper · NVIDIA Parakeet · Omni-ASR |
| Audio capture | cpal (mic), WASAPI (Windows system audio) |
| LLM inference | OpenRouter API or [Ollama](https://ollama.com/) |
| Embeddings | Voyage AI, Ollama, or OpenAI-compatible |
| Frontend UI | React 18 + TypeScript + Vite |
| Secret storage | Windows Credential Manager / macOS Keychain |

---

## Recording Consent & Legal Disclaimer

**Important:** OpenCassava records and transcribes audio from your microphone and system audio. Many jurisdictions have laws requiring consent from some or all participants before a conversation may be recorded.

**By using this software, you acknowledge and agree that:**
- **You are solely responsible** for determining whether recording is lawful in your jurisdiction and for obtaining any required consent.
- **The developers and contributors of OpenCassava provide no legal advice** and accept no liability for any unauthorized or unlawful recording conducted using this software.

**Do not use this software to record conversations without proper consent where required by law.**

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and upgrade notes.

---

## License

MIT
