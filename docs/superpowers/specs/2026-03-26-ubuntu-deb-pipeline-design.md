# Ubuntu / .deb Build Pipeline — Design Spec

**Date:** 2026-03-26
**Status:** Approved

---

## Goal

Ship OpenCassava as a `.deb` package for Ubuntu 22.04 LTS, built and published automatically via GitHub Actions on every version tag — matching the existing `windows-release.yml` pattern.

---

## Scope

- Fix two `npm.cmd` references in `tauri.conf.json` so the Tauri build command works on Linux.
- Add `.github/workflows/ubuntu-release.yml` that builds a `.deb` on `ubuntu-22.04` and publishes it to GitHub Releases.
- No APT repo, no AppImage, no ARM target in this iteration.

---

## Code Fixes

### `opencassava/src-tauri/tauri.conf.json`

`beforeBuildCommand` and `beforeDevCommand` currently use `npm.cmd` (a Windows batch wrapper). Change both to `npm`, which resolves correctly on all platforms including Windows.

```diff
- "beforeDevCommand": "npm.cmd run dev",
- "beforeBuildCommand": "npm.cmd run build",
+ "beforeDevCommand": "npm run dev",
+ "beforeBuildCommand": "npm run build",
```

No other code changes are required:
- `audio_windows.rs` already has a no-op Linux stub (`#[cfg(not(target_os = "windows"))]` branch) — compiles and returns empty on Linux without crashing.
- `engine.rs::list_sys_audio_devices` calls `audio_windows::list_render_devices()` which returns `vec![]` on Linux via that same stub.

---

## GitHub Actions Workflow

**File:** `.github/workflows/ubuntu-release.yml`

**Triggers:**
- `workflow_dispatch` (manual)
- `push` to tags matching `v*`

**Runner:** `ubuntu-22.04`

**Working directory default:** `opencassava/`

### Steps

| # | Step | Detail |
|---|------|--------|
| 1 | Checkout | `actions/checkout@v4`, `submodules: false` (whisper-rs cloned by script) |
| 2 | Node.js 20 | `actions/setup-node@v4`, cache npm, lock path `opencassava/package-lock.json` |
| 3 | Rust stable | `dtolnay/rust-toolchain@stable` |
| 4 | Rust cache | `Swatinem/rust-cache@v2`, same workspace paths as Windows workflow |
| 5 | System deps | `apt-get install` — see list below |
| 6 | Prepare whisper-rs | `pwsh opencassava/scripts/prepare-whisper.ps1` |
| 7 | Install frontend deps | `npm ci` |
| 8 | Build .deb | `npm run tauri -- build --bundles deb` |
| 9 | Upload artifact | `actions/upload-artifact@v4`, path `target/release/bundle/deb/*.deb` |
| 10 | Publish release | `softprops/action-gh-release@v2` on tag push only |

### Linux system dependencies (apt)

**Tauri 2 / WebKitGTK:**
- `libwebkit2gtk-4.1-dev`
- `libgtk-3-dev`
- `librsvg2-dev`
- `libayatana-appindicator3-dev`

**TLS / networking:**
- `libssl-dev`
- `pkg-config`

**Keyring (dbus-based secret service on Linux):**
- `libdbus-1-dev`

**whisper-rs (C++ build via cmake + bindgen):**
- `cmake`
- `clang`
- `libclang-dev`

---

## What works on Ubuntu vs. Windows/macOS

| Feature | Ubuntu | Notes |
|---------|--------|-------|
| Mic transcription (whisper-rs) | Yes | No platform-specific code |
| Mic transcription (Parakeet / faster-whisper) | Yes | Python path uses `bin/python3` on non-Windows |
| System audio ("THEM" channel) | No | No-op stub — WASAPI/CoreAudio only |
| Secret storage (keyring) | Yes | Uses secret-service via dbus |
| Overlay window | Yes | Tauri WebKitGTK renders it |

System audio is a known limitation on Linux and is acceptable for this iteration.

---

## Out of Scope

- AppImage / RPM bundles
- ARM64 (aarch64) builds
- APT repository / PPA
- Ubuntu versions other than 22.04 LTS
- Automated Linux smoke tests
