# Changelog

## [Unreleased] - Next version

### Save recordings

- **Record Audio toggle** — a new checkbox in the ControlBar lets users opt in to
  recording audio before each session starts. The toggle is disabled mid-session
  so the choice is locked in at call start.
- **Per-channel WAV export** — mic and system audio are streamed to separate temp
  WAV files (16kHz mono f32) in real time during the session with no overhead
  when recording is off.
- **Save modal** — when a recorded session ends, a modal offers three checkboxes:
  *Microphone (you)*, *System audio (them)*, and *Merged (both channels mixed)*.
  Clicking Save Selected opens a file picker for each chosen file in sequence.
- **Merged channel** — the merged WAV averages mic and system samples
  frame-by-frame, zero-padding the shorter channel if they differ in length.
- **Remembered save location** — the last directory chosen in the file picker is
  persisted in `AppSettings.lastRecordingDir` and pre-seeded on the next save.
- Closes issue #24.

### Suggestions controls

- **Suggestion quick controls** - added an easy-to-find live suggestions toggle and
  cadence control directly in the main app UI instead of burying cadence in
  Settings only.
- **Suggestion disable setting** - added a persisted `suggestionsEnabled` setting
  so users can fully turn off live suggestion checks and overlay surfacing.

All notable changes to OpenCassava are documented here.

Format: `## [version] — title` followed by grouped bullet points.
The release workflow reads this file and extracts the section that matches the
current tag, so keep each release block between its own `## [x.y.z]` header
and the next one.

## [Unreleased] — next version

### Developer workflow

- **Root lint entrypoint** — added a repo-root `npm run lint` / `npm run lint:fix`
  path that delegates to the Tauri frontend so contributors and CI use the same
  command.
- **Scoped frontend ESLint** — tightened the frontend lint command to target the
  TypeScript React source, local Node build scripts, and the ESLint config
  itself while ignoring generated directories.
- **Typed lint cleanup** — removed the existing frontend lint failures that were
  blocking a real enforced lint pass, including unsafe `any` usage, stale effect
  dependencies, and unused props/state.
- **PR lint job** — pull requests now install frontend dependencies and run the
  frontend lint check in GitHub Actions instead of only running Rust tests.
- **Lint cache ignored** — the frontend ESLint cache file is now ignored so local
  lint runs do not dirty the worktree.

---

## [Unreleased] — next version

### UI improvements

- **Update availability indicator** - the desktop UI now checks the installed app
  version against the latest GitHub release and shows a persistent status badge
  with a direct download link when an update is available. Tracks issue `#25`.

---

## [0.3.0] — Local Cohere Transcribe

### Transcription

- **Local Cohere Transcribe provider** — added `cohere-transcribe` as a new
  first-class STT backend using a local Python worker with Transformers for
  `CohereLabs/cohere-transcribe-03-2026`.
- **Cross-platform setup flow** — Cohere Transcribe can now be configured from
  the desktop app on Windows, macOS, and Linux with app-managed runtime setup,
  supported-locale checks, Hugging Face token support, and Whisper fallback
  when Cohere is unavailable.

---

## [0.2.1] — omniASR LLM Unlimited v2 & Linux fixes

### omniASR model migration

- **LLM Unlimited v2 family** — omniASR now uses the `LLM_Unlimited_*_v2` model
  family (`LLM_Unlimited_300M_v2`, `LLM_Unlimited_1B_v2`, `LLM_Unlimited_7B_v2`).
  Settings UI updated to list the new names.
- **Automatic migration** — saved settings referencing the old `omniASR_LLM_*`
  names (including the 3B variant) are remapped to the closest v2 equivalent on
  load; no manual action needed.

### Linux (native) fixes

- **Pinned torch + CUDA cleanup** — `torch` is pinned before installing
  `omnilingual-asr` on native Linux to prevent pip pulling incompatible CUDA
  builds. Stale CUDA packages are removed from the venv on install.
- **Blackwell CUDA variant** — installer detects CUDA 12.8+ (Blackwell GPUs) and
  selects the appropriate torch wheel index.

### Test / CI fixes

- **macOS unit tests** — fixed a series of test compilation and assertion issues
  on macOS; `cargo test -p opencassava-core` now passes on all three platforms.
- **`ld_library_path` test gated to non-Windows** — `PathBuf` uses backslashes on
  Windows, so the test is skipped on that platform to avoid false negatives.

---

## [0.2.0] — Omni-ASR WSL2 overhaul

Full end-to-end repair of the Omni-ASR pipeline on Windows via WSL2, fixing a
series of cascading installation and runtime issues discovered during testing.

### Installation fixes

- **Venv moved to Linux-native filesystem** — virtual environment now lives under
  `$HOME/.local/share/opencassava/omni-asr/venv` inside WSL2 (ext4), not on the
  Windows NTFS mount (`/mnt/c/…`). PyTorch `.so` files cannot be loaded by the
  Linux dynamic linker from NTFS; this was the root cause of the
  `libcudart.so.13: cannot open shared object file` error.
- **CPU torch pre-installed before omnilingual-asr** — `torch==2.6.0` and
  `torchaudio==2.6.0` are now installed from the PyTorch CPU index *before*
  `omnilingual-asr` resolves its dependencies, preventing pip from pulling CUDA
  builds from PyPI.
- **`libsndfile.so.1` symlink created automatically** — `fairseq2n` looks for
  `libsndfile.so.1` at runtime; the installer now symlinks it from `soundfile`'s
  bundled `libsndfile_x86_64.so`, so `apt install libsndfile1` is not required.
- **`LD_LIBRARY_PATH` set on worker spawn** — the worker process launches with
  `LD_LIBRARY_PATH='{venv}/lib'` so the dynamic linker finds the symlink.
- **Reinstall loop eliminated** — `install_runtime` returns early when the install
  stamp is valid, preventing pip from reinstalling everything on every launch.
- **Stale lock auto-cleared** — a `setup.lock` left by a crashed install is
  removed automatically on the next health check if the runtime is installed.
- **Cleanup on failure** — a partial venv is deleted when installation fails so
  the next attempt always starts from scratch.

### Runtime fixes

- **Correct import path** — worker was importing from `omnilingual_asr.pipelines`
  (does not exist); fixed to `omnilingual_asr.models.inference`.
- **Correct API usage** — worker was calling `ASRInferencePipeline.from_pretrained`
  (does not exist); fixed to `ASRInferencePipeline(model_card, device=device)`
  constructor and `pipeline.transcribe([audio_dict])` returning `List[str]`.
- **No temp WAV file** — audio is now passed as a pre-decoded dict directly to the
  pipeline, eliminating the write/read cycle.
- **Model pre-loaded on record** — `ensure_model()` is called immediately after the
  worker spawns so the 1+ GB checkpoint loads up front with log output, rather
  than silently blocking the first audio chunk.
- **Full tracebacks in error responses** — Python exceptions now include the
  traceback in the JSON error payload for easier debugging.

### Model names & settings

- **Correct fairseq2 card names** — the app was using HuggingFace-style paths
  (`facebook/omnilingual-asr-300m`) which are not valid fairseq2 card names.
  Correct names are `omniASR_CTC_300M`, `omniASR_CTC_1B`, `omniASR_LLM_300M`, etc.
- **Automatic migration** — saved settings with old HuggingFace-style names are
  remapped to correct fairseq2 names on load; no manual action needed.
- **Updated model dropdown** — Settings now lists all six models
  (CTC 300M / 1B / 3B and LLM 300M / 1B / 7B) with descriptions.
- **Default model** is `omniASR_CTC_300M` — fast and reliable. LLM models
  (`omniASR_LLM_*`) are available in the dropdown but require a complete
  multi-shard download; select them manually once the download finishes.

### Language conditioning

- **`lang` wired through** — transcription locale (e.g. `en`) is mapped to a
  fairseq2 language code (e.g. `eng_Latn`) and passed to `pipeline.transcribe`.
- **LLM models honor language** — `omniASR_LLM_*` models output in the requested
  language regardless of the audio's detected language.
- **CTC garbage filter** — when a Latin-script language is requested but the CTC
  model returns entirely non-Latin characters (Arabic etc. from misdetection on
  short/noisy clips), the result is silently dropped instead of surfaced as
  garbage text.

- **Recommendation updated** - Omni-ASR remains available, but it is not the
  recommended engine for this release. Parakeet is the preferred STT backend
  and our current recommendation for day-to-day use.

### Bug fixes

- **UTF-8 panic in log pump** — `pump_stderr` panicked when a Unicode progress-bar
  character (`▊`, `█`) fell on a non-char-boundary byte offset. Fixed by snapping
  the truncation index to the next valid char boundary.
- **Log line whitespace** — tqdm progress bars pad lines with trailing spaces for
  `\r` overwriting; these are now trimmed before logging.

---

## [0.1.6] — Previous release

See git history for changes prior to v0.2.0.
