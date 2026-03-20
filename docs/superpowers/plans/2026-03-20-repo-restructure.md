# Repo Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flatten the `OpenCassava/` wrapper directory to repo root, rename the Tauri app folder to `opencassava/`, and remove all fork artifacts in a single history-preserving commit.

**Architecture:** All tracked files are moved with `git mv` (preserves history), tracked artifacts are removed with `git rm`, and all internal path references (Cargo.toml, CI workflow, .gitignore, README, docs) are updated to match the new layout before committing.

**Tech Stack:** Git, Cargo (Rust workspace), GitHub Actions, Node.js/npm

**Spec:** `docs/superpowers/specs/2026-03-20-repo-restructure-design.md`

---

## Pre-flight check

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean`. If not, stash or commit pending changes before proceeding.

- [ ] **Step 2: Rename the GitHub repo**

Go to `https://github.com/romeroej2/OpenOats/settings`, scroll to "Repository name", rename it to `OpenCassava`, and confirm. Do this **before** updating the remote URL or any push will fail.

---

## Task 1: Remove tracked artifacts

**Files:**
- Delete: `OpenCassava/OpenCassavaTauri/src-tauri/err.txt`
- Delete: `OpenCassava/OpenCassavaTauri/src-tauri/OpenCassavaWindows.dll`
- Delete gitlink: `.claude/worktrees/relaxed-antonelli`

- [ ] **Step 1: Remove err.txt and the Windows DLL**

```bash
git rm OpenCassava/OpenCassavaTauri/src-tauri/err.txt
git rm OpenCassava/OpenCassavaTauri/src-tauri/OpenCassavaWindows.dll
```

Expected: both files staged for deletion.

- [ ] **Step 2: Remove the dead worktree gitlink**

`.claude/worktrees/relaxed-antonelli` is a gitlink (mode `160000`), not a regular directory. Filesystem deletion alone leaves a dangling index entry — use `git rm`:

```bash
git rm -r .claude/worktrees/
```

Expected: `rm '.claude/worktrees/relaxed-antonelli'`

---

## Task 2: Move files to new locations

**Files:**
- Move: `OpenCassava/OpenCassavaTauri/` → `opencassava/`
- Move: `OpenCassava/crates/` → `crates/`
- Move: `OpenCassava/Cargo.toml` → `Cargo.toml`
- Move: `OpenCassava/Cargo.lock` → `Cargo.lock`
- Move: `OpenCassava/package.json` → `package.json`
- Move: `OpenCassava/package-lock.json` → `package-lock.json`

- [ ] **Step 1: Move the Tauri app folder**

```bash
git mv OpenCassava/OpenCassavaTauri opencassava
```

Expected: all files under `OpenCassava/OpenCassavaTauri/` now staged as moved to `opencassava/`.

- [ ] **Step 2: Move the crates folder**

```bash
git mv OpenCassava/crates crates
```

Expected: `crates/opencassava-core/` now at repo root.

- [ ] **Step 3: Move the workspace Cargo.toml**

```bash
git mv OpenCassava/Cargo.toml Cargo.toml
```

`Cargo.lock` is currently gitignored (`OpenCassava/Cargo.lock` in `.gitignore`) so `git mv` would fail. Copy it as a plain filesystem operation — after `.gitignore` is updated in Task 4, `git add -A` in Task 8 will pick it up as a new tracked file at the repo root.

```bash
cp OpenCassava/Cargo.lock Cargo.lock
```

- [ ] **Step 4: Move the workspace package.json; copy package-lock.json**

```bash
git mv OpenCassava/package.json package.json
```

`package-lock.json` is also currently gitignored (`OpenCassava/package-lock.json` in `.gitignore`). Copy it:

```bash
cp OpenCassava/package-lock.json package-lock.json
```

- [ ] **Step 5: Verify OpenCassava/ is now empty**

```bash
ls OpenCassava/
```

Expected: empty or only contains `node_modules/` and `target/` (both gitignored). The `OpenCassava/` directory itself is untracked at this point — it will disappear on commit if empty, or you can `rm -rf OpenCassava/` to clean up local untracked directories now.

- [ ] **Step 6: Remove empty untracked directories**

```bash
rm -rf OpenCassava/
rm -rf output/
rm -rf scripts/
```

These are untracked (or now-empty), so no `git rm` needed — just filesystem cleanup.

---

## Task 3: Update `Cargo.toml` workspace members

**Files:**
- Modify: `Cargo.toml` (just moved from `OpenCassava/Cargo.toml`)

- [ ] **Step 1: Update workspace members**

Open `Cargo.toml` and change:

```toml
[workspace]
members = [
    "crates/opencassava-core",
    "OpenCassavaTauri/src-tauri",
]
```

to:

```toml
[workspace]
members = [
    "crates/opencassava-core",
    "opencassava/src-tauri",
]
```

The `[patch.crates-io]` entry `whisper-rs = { path = ".build/whisper-rs" }` now resolves to `<repo-root>/.build/whisper-rs`. This path is gitignored and regenerated on first build — no change needed to that line.

- [ ] **Step 2: Verify the path depth of the src-tauri dependency**

Open `opencassava/src-tauri/Cargo.toml` and confirm:

```toml
opencassava-core = { path = "../../crates/opencassava-core" }
```

`opencassava/src-tauri/` is two levels from repo root, so `../../crates/` resolves to `<repo-root>/crates/` — correct. No change needed.

---

## Task 4: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Replace the file contents**

Replace the entire `.gitignore` with:

```gitignore
__pycache__/
*.pyc
build/
dist/
*.spec
.worktrees/
.beads/
.build/
data/
CLAUDE.md
AGENTS.md
node_modules/
opencassava/node_modules/
*.log
target/
.claude/settings.local.json
.claude/worktrees/
opencassava/.npm-cache/
```

Key changes from the old file:
- `OpenCassava/.build/` → `.build/`
- `OpenCassava/node_modules/` → `node_modules/` + `opencassava/node_modules/`
- `OpenCassava/*.log` → `*.log`
- `OpenCassava/target/` → `target/`
- `OpenCassava/OpenCassavaTauri/.npm-cache/` → `opencassava/.npm-cache/`
- Removed `OpenCassava/Cargo.lock` (now tracked at root)
- Removed `OpenCassava/package-lock.json` (now tracked at root)
- Removed `/OpenOats/.build` (stale entry from before rename)
- Added `.claude/worktrees/`

---

## Task 5: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/windows-release.yml`

- [ ] **Step 1: Update working-directory and all path references**

Replace the file contents with:

```yaml
name: Build Windows App

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build-windows:
    runs-on: windows-latest
    defaults:
      run:
        shell: powershell
        working-directory: opencassava

    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: opencassava/package-lock.json

      - name: Set up Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Restore Rust cache
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            . -> target
            opencassava/src-tauri -> target

      - name: Install frontend dependencies
        run: npm.cmd ci

      - name: Build Windows installers
        run: npx.cmd tauri build --bundles nsis,msi

      - name: Upload Windows bundle artifacts
        uses: actions/upload-artifact@v4
        with:
          name: opencassava-windows-bundles
          path: |
            opencassava/src-tauri/target/release/bundle/nsis/*.exe
            opencassava/src-tauri/target/release/bundle/msi/*.msi
          if-no-files-found: error

      - name: Publish GitHub release assets
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: |
            opencassava/src-tauri/target/release/bundle/nsis/*.exe
            opencassava/src-tauri/target/release/bundle/msi/*.msi
```

Changes from old file:
- `working-directory: OpenCassava/OpenCassavaTauri` → `opencassava`
- `cache-dependency-path: OpenCassava/OpenCassavaTauri/package-lock.json` → `opencassava/package-lock.json`
- rust-cache workspaces: `OpenCassava -> target` → `. -> target`; `OpenCassava/OpenCassavaTauri/src-tauri -> target` → `opencassava/src-tauri -> target`
- All four artifact/release path globs: `OpenCassava/OpenCassavaTauri/src-tauri/...` → `opencassava/src-tauri/...`

---

## Task 6: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Build from source" section**

Find the build instructions block (around line 68-84) and replace:

```markdown
```bash
# Clone the repo
git clone https://github.com/romeroej2/OpenCassava.git
cd OpenCassava

# Build the Tauri app
cd OpenCassavaTauri
npm install
npm run tauri -- build
```

This project uses the local Tauri CLI from `OpenCassavaTauri/node_modules`, so `cargo tauri build` is not required and will fail unless you separately install the `cargo-tauri` subcommand globally.

On Windows PowerShell, prefer `npm.cmd ci` and either `npm.cmd run tauri -- build` or `cmd.exe /d /s /c .\node_modules\.bin\tauri.cmd build` if your global `npm` or `npx` shim is misconfigured.

The installers are output to `OpenCassavaTauri/src-tauri/target/release/bundle/`.
```

with:

```markdown
```bash
# Clone the repo
git clone https://github.com/romeroej2/OpenCassava.git
cd OpenCassava

# Build the Tauri app
cd opencassava
npm install
npm run tauri -- build
```

This project uses the local Tauri CLI from `opencassava/node_modules`, so `cargo tauri build` is not required and will fail unless you separately install the `cargo-tauri` subcommand globally.

On Windows PowerShell, prefer `npm.cmd ci` and either `npm.cmd run tauri -- build` or `cmd.exe /d /s /c .\node_modules\.bin\tauri.cmd build` if your global `npm` or `npx` shim is misconfigured.

The installers are output to `opencassava/src-tauri/target/release/bundle/`.
```

- [ ] **Step 2: Replace the architecture diagram**

Find the full code block starting with `OpenCassava/                        # Cargo workspace root` (around line 124) and replace the entire tree with:

````markdown
```
repo-root/                          # Cargo workspace root
├── crates/
│   └── opencassava-core/           # Shared Rust library — all business logic
│       └── src/
│           ├── models.rs           # Utterance, Speaker, Session, Suggestion, ConversationState, etc.
│           ├── settings.rs         # AppSettings (JSON persistence)
│           ├── keychain.rs         # Secret storage (Windows Credential Manager / macOS Keychain)
│           ├── audio/              # Audio capture traits and implementations
│           ├── transcription/      # VAD + Whisper transcription pipeline
│           ├── storage/            # Session persistence (JSONL) + transcript logging
│           └── intelligence/       # LLM client, embedding client, knowledge base, suggestion engine
│
└── opencassava/                    # Tauri app (Windows + macOS)
    ├── src-tauri/
    │   ├── src/
    │   │   ├── lib.rs              # Tauri commands — thin bridge to opencassava-core
    │   │   ├── main.rs             # Entry point
    │   │   ├── engine.rs           # Session orchestration + Tauri event emission
    │   │   └── audio_windows.rs    # WASAPI loopback (system audio capture)
    │   └── tauri.conf.json
    └── src/                        # React/TypeScript UI
        ├── App.tsx
        └── components/
            ├── ControlBar.tsx
            ├── TranscriptView.tsx
            ├── SuggestionsView.tsx
            ├── NotesView.tsx
            └── SettingsView.tsx
```
````

---

## Task 7: Update `docs/lm-studio-setup.md`

**Files:**
- Modify: `docs/lm-studio-setup.md`

- [ ] **Step 1: Update the build instructions block**

Find lines 19-26 and replace:

```powershell
git clone https://github.com/romeroej2/OpenCassava.git
cd OpenCassava\OpenCassavaTauri
npm install
npm run tauri -- build
```

This repo builds through the local Tauri CLI in `OpenCassavaTauri\node_modules`, so `cargo tauri build` is not required unless you separately installed the global `cargo-tauri` subcommand.

with:

```powershell
git clone https://github.com/romeroej2/OpenCassava.git
cd OpenCassava\opencassava
npm install
npm run tauri -- build
```

This repo builds through the local Tauri CLI in `opencassava\node_modules`, so `cargo tauri build` is not required unless you separately installed the global `cargo-tauri` subcommand.

---

## Task 8: Commit and update remotes

- [ ] **Step 1: Stage all remaining changes**

```bash
git add -A
```

- [ ] **Step 2: Verify the staging area looks right**

```bash
git status
```

Expected: a large set of renames (A/D pairs or R entries), deletions of err.txt, OpenCassavaWindows.dll, .claude/worktrees/, and modifications to Cargo.toml, .gitignore, .github/workflows/windows-release.yml, README.md, docs/lm-studio-setup.md. No unexpected files.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor: flatten repo structure and remove fork artifacts

- Move OpenCassava/OpenCassavaTauri/ -> opencassava/
- Move OpenCassava/crates/ -> crates/
- Move workspace Cargo.toml and package.json to repo root (tracked)
- Copy Cargo.lock and package-lock.json to repo root (were gitignored, now tracked)
- Remove OpenCassava/ wrapper directory
- Remove err.txt build artifact and OpenCassavaWindows.dll binary from git
- Remove dead .claude/worktrees/ gitlink
- Remove empty output/ and scripts/ directories
- Update .gitignore, Cargo.toml workspace members, CI workflow paths
- Update README architecture diagram and build instructions
- Update docs/lm-studio-setup.md build instructions

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Remove the upstream fork remote**

```bash
git remote remove upstream
```

- [ ] **Step 5: Update origin to the renamed GitHub repo**

```bash
git remote set-url origin https://github.com/romeroej2/OpenCassava.git
```

- [ ] **Step 6: Verify remotes**

```bash
git remote -v
```

Expected: only `origin` pointing to `https://github.com/romeroej2/OpenCassava.git`.

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

## Post-restructure: first build

After pushing, the `.build/` directory (which contains the whisper-rs source) no longer exists at the new workspace root and must be regenerated before the next build:

```bash
cd opencassava
npm run tauri -- build
```

The `prepare-whisper.ps1` script runs automatically as part of the build and regenerates `.build/whisper-rs` at the repo root where `Cargo.toml` now expects it.

---

## Known follow-up tech debt

- `prepare-whisper.ps1` still uses `.openoats-patched-commit` as its cache stamp filename (stale from before the rename). Does not affect correctness, but should be renamed in a follow-up.
