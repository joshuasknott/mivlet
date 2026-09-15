param(
  [string[]]$ProcessName = @("mivlet-desktop", "msedgewebview2", "node", "cargo"),
  [int]$DurationSeconds = 60,
  [int]$IntervalMilliseconds = 1000,
  [string]$Output
)

$samples = New-Object System.Collections.Generic.List[object]
$deadline = (Get-Date).AddSeconds($DurationSeconds)

while ((Get-Date) -lt $deadline) {
  foreach ($name in $ProcessName) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
      $samples.Add([pscustomobject]@{
        Timestamp = (Get-Date).ToString("o")
        ProcessName = $_.ProcessName
        Id = $_.Id
        WorkingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
        PrivateMemoryMB = [math]::Round($_.PrivateMemorySize64 / 1MB, 1)
      })
    }
  }
  Start-Sleep -Milliseconds $IntervalMilliseconds
}

$summary = $samples |
  Group-Object ProcessName, Id |
  ForEach-Object {
    $peakWorkingSet = ($_.Group | Measure-Object WorkingSetMB -Maximum).Maximum
    $peakPrivate = ($_.Group | Measure-Object PrivateMemoryMB -Maximum).Maximum
    $last = $_.Group[-1]
    [pscustomobject]@{
      ProcessName = $last.ProcessName
      Id = $last.Id
      Samples = $_.Count
      PeakWorkingSetMB = $peakWorkingSet
      PeakPrivateMemoryMB = $peakPrivate
    }
  } |
  Sort-Object ProcessName, Id

if ($Output) {
  $lines = @(
    "# Mivlet Memory Observation"
    ""
    "Generated: $((Get-Date).ToString("o"))"
    ""
    "Duration: ${DurationSeconds}s"
    ""
    "| Process | PID | Samples | Peak working set | Peak private memory |"
    "| --- | ---: | ---: | ---: | ---: |"
  )
  foreach ($row in $summary) {
    $lines += "| $($row.ProcessName) | $($row.Id) | $($row.Samples) | $($row.PeakWorkingSetMB) MB | $($row.PeakPrivateMemoryMB) MB |"
  }
  $lines += ""
  $lines += "This is an observation helper, not a precise allocator benchmark. Compare repeated runs on the same machine."
  Set-Content -Path $Output -Value $lines -Encoding UTF8
}

$summary
