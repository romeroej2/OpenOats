#Requires -Version 5.1
<#
.SYNOPSIS
    Build and launch OpenCassava for testing, the way it runs when installed.

.DESCRIPTION
    Checks build prerequisites (Rust, Node.js/npm), installs JS dependencies when
    missing, compiles the app through the Tauri CLI (frontend embedded in the
    binary, no installer bundle), then launches the compiled executable detached
    — exactly like running the installed app.

    Stray llama-server.exe processes from a previous crashed session are
    terminated first so the managed Gemma server can rebind its port.

.PARAMETER Debug
    Build with the debug profile (faster compile, slower app, devtools enabled).
    Default is release.

.PARAMETER SkipBuild
    Skip building; launch the last compiled binary.

.PARAMETER Dev
    Run `npm run tauri dev` instead (hot reload, logs in this terminal).

.PARAMETER VerboseLogs
    Set RUST_LOG=debug for the launched app.

.PARAMETER KeepLlama
    Do not kill leftover llama-server.exe processes before launching.

.EXAMPLE
    .\dev.ps1                   # release build + launch compiled app
    .\dev.ps1 -Debug            # debug-profile build + launch
    .\dev.ps1 -SkipBuild        # launch last compiled binary
    .\dev.ps1 -Dev              # hot-reload development mode
#>

param(
    [switch]$Debug,
    [switch]$SkipBuild,
    [switch]$Dev,
    [switch]$VerboseLogs,
    [switch]$KeepLlama
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$AppDir = Join-Path $RepoRoot "opencassava"
$TargetDir = Join-Path $RepoRoot "target"
$BinaryName = "app.exe"

# ── Ensure known tool paths are in current session PATH ─────────────────────

$knownPaths = @("$env:USERPROFILE\.cargo\bin")
foreach ($p in $knownPaths) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

# ── Check prerequisites ─────────────────────────────────────────────────────

$missing = @()
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += "cargo (Rust — https://rustup.rs)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue))  { $missing += "node (Node.js — https://nodejs.org)" }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $missing += "npm" }

if ($missing.Count -gt 0) {
    Write-Host "Missing prerequisites:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
    Write-Host "node_modules missing — running npm install..." -ForegroundColor Cyan
    Push-Location $AppDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

# ── Clean up stray managed llama-server processes ───────────────────────────

if (-not $KeepLlama) {
    $stray = Get-Process llama-server -ErrorAction SilentlyContinue
    if ($stray) {
        Write-Host "Terminating $(@($stray).Count) leftover llama-server process(es) so the app can rebind its port..." -ForegroundColor Yellow
        $stray | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

# ── Logging env ──────────────────────────────────────────────────────────────

if ($VerboseLogs -and -not $env:RUST_LOG) {
    $env:RUST_LOG = "debug"
    Write-Host "Verbose logging enabled (RUST_LOG=debug)" -ForegroundColor Cyan
}

# ── Optional: hot-reload dev mode ────────────────────────────────────────────

if ($Dev) {
    Write-Host "Starting OpenCassava in dev mode (hot reload, backend logs below)..." -ForegroundColor Green
    Push-Location $AppDir
    try {
        npm run tauri dev
        exit $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

# ── Build compiled binary (frontend embedded, no installer bundle) ──────────

if (-not $SkipBuild) {
    $modeLabel = if ($Debug) { "debug" } else { "release" }
    Write-Host "Building OpenCassava ($modeLabel, no bundle)..." -ForegroundColor Cyan
    Push-Location $AppDir
    try {
        # Call run-tauri.mjs directly: it forwards argv verbatim to the Tauri CLI
        # and runs the whisper prepare/cleanup hooks. Going through `npm run`
        # mangles the extra flags (--debug/--no-bundle get dropped).
        $buildArgs = @("./scripts/run-tauri.mjs", "build", "--no-bundle")
        if ($Debug) { $buildArgs += "--debug" }
        node @buildArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

# ── Launch the compiled app, detached, like the installed app ────────────────

$buildProfile = if ($Debug) { "debug" } else { "release" }
$binary = Join-Path $TargetDir "$buildProfile\$BinaryName"

if (-not (Test-Path $binary)) {
    Write-Host "ERROR: Binary not found at $binary" -ForegroundColor Red
    Write-Host "Run without -SkipBuild to build first." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Launching OpenCassava ($buildProfile) — $binary" -ForegroundColor Green
Start-Process -FilePath $binary -WorkingDirectory (Split-Path $binary)
