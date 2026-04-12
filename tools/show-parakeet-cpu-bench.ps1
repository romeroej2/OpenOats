param(
    [Parameter(Mandatory = $true)]
    [string]$Report
)

$ErrorActionPreference = "Stop"

$reportPath = (Resolve-Path $Report).Path
$json = Get-Content $reportPath -Raw | ConvertFrom-Json -Depth 10

$runs = @($json.runs)
if ($runs.Count -eq 0) {
    Write-Host "No benchmark runs found in $reportPath"
    exit 0
}

$summaryRows = $runs |
    Sort-Object firstTranscriptMs |
    ForEach-Object {
        [pscustomobject]@{
            Model            = $_.model
            Device           = $_.resolvedDevice
            ColdStartMs      = $_.coldStartMs
            WarmStartMs      = $_.warmStartMs
            FirstTranscriptMs= $_.firstTranscriptMs
            Throughput       = [math]::Round($_.steadyStateThroughputAudioSecondsPerWallSecond, 2)
            AvgCpuPct        = [math]::Round($_.averageCpuPercent, 2)
            PeakRSSMiB       = [math]::Round($_.peakRssBytes / 1MB, 1)
            IdleRSSMiB       = [math]::Round($_.warmedIdleRssBytes / 1MB, 1)
        }
    }

Write-Host "Model Summary"
$summaryRows | Format-Table -AutoSize

$werRows = foreach ($run in $runs) {
    foreach ($corpus in @($run.corpusResults)) {
        [pscustomobject]@{
            Model   = $run.model
            Corpus  = $corpus.corpus
            Samples = $corpus.samples
            WER     = [math]::Round($corpus.wordErrorRate * 100, 2)
        }
    }
}

if ($werRows.Count -gt 0) {
    Write-Host ""
    Write-Host "WER By Corpus"
    $werRows | Sort-Object Corpus, Model | Format-Table -AutoSize
}
