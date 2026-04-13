param(
    [Parameter(Mandatory = $true)]
    [string]$BaseReport,

    [Parameter(Mandatory = $true)]
    [string]$HeadReport
)

$ErrorActionPreference = "Stop"

$base = Get-Content (Resolve-Path $BaseReport) -Raw | ConvertFrom-Json
$head = Get-Content (Resolve-Path $HeadReport) -Raw | ConvertFrom-Json

$baseRuns = @{}
foreach ($run in @($base.runs)) {
    $baseRuns[$run.model] = $run
}

$rows = foreach ($run in @($head.runs)) {
    $prev = $baseRuns[$run.model]
    if ($null -eq $prev) {
        continue
    }

    [pscustomobject]@{
        Model                    = $run.model
        DeltaColdStartMs         = $run.coldStartMs - $prev.coldStartMs
        DeltaWarmStartMs         = $run.warmStartMs - $prev.warmStartMs
        DeltaFirstTranscriptMs   = $run.firstTranscriptMs - $prev.firstTranscriptMs
        DeltaThroughput          = [math]::Round(
            $run.steadyStateThroughputAudioSecondsPerWallSecond -
            $prev.steadyStateThroughputAudioSecondsPerWallSecond,
            2
        )
        DeltaAvgCpuPct           = [math]::Round($run.averageCpuPercent - $prev.averageCpuPercent, 2)
        DeltaPeakRSSMiB          = [math]::Round(($run.peakRssBytes - $prev.peakRssBytes) / 1MB, 1)
        DeltaIdleRSSMiB          = [math]::Round(($run.warmedIdleRssBytes - $prev.warmedIdleRssBytes) / 1MB, 1)
    }
}

if ($rows.Count -eq 0) {
    Write-Host "No overlapping model names found between the two reports."
    exit 0
}

Write-Host "Delta Summary (negative is better for latency/CPU/RSS; positive is better for throughput)"
$rows | Sort-Object Model | Format-Table -AutoSize
