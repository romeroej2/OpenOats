param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,

    [string]$RuntimeRoot = ".local/parakeet-bench",

    [string]$Output = "parakeet-cpu-benchmark-report.json",

    [string[]]$Models = @(),

    [string]$Device = "cpu",

    [string]$Language = "auto",

    [int]$PollIntervalMs = 250,

    [switch]$DiarizationEnabled
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = (Resolve-Path $Manifest).Path
$runtimeRootPath = Join-Path $repoRoot $RuntimeRoot
$outputPath = Join-Path $repoRoot $Output

New-Item -ItemType Directory -Force -Path $runtimeRootPath | Out-Null

$cargoArgs = @(
    "run",
    "-p",
    "opencassava-core",
    "--bin",
    "parakeet_cpu_bench",
    "--",
    "--manifest",
    $manifestPath,
    "--runtime-root",
    $runtimeRootPath,
    "--output",
    $outputPath,
    "--device",
    $Device,
    "--language",
    $Language,
    "--poll-interval-ms",
    $PollIntervalMs.ToString()
)

foreach ($model in $Models) {
    if (-not [string]::IsNullOrWhiteSpace($model)) {
        $cargoArgs += @("--model", $model)
    }
}

if ($DiarizationEnabled) {
    $cargoArgs += "--diarization-enabled"
}

Push-Location $repoRoot
try {
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Host ""
    Write-Host "Summary:"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "show-parakeet-cpu-bench.ps1") -Report $outputPath
} finally {
    Pop-Location
}
