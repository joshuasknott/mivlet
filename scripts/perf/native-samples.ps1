param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [ValidateRange(5, 300)][int]$DurationSeconds = 60,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
$launchDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$launchedAt = [datetime]::UtcNow.ToString('o')
$watch = [System.Diagnostics.Stopwatch]::StartNew()
# This is the interactive app under observation, not a background helper.
# Preserve its ordinary visible startup and WebView activation behavior.
$rootProcess = Start-Process -FilePath $Executable -WorkingDirectory $launchDirectory -WindowStyle Normal -PassThru
# Retain the original kernel process handle throughout observation. Looking up
# its PID again could attach to an unrelated process after Windows reuses it.
$null = $rootProcess.Handle
@{event='launched';pid=$rootProcess.Id;launchedAt=$launchedAt} | ConvertTo-Json -Compress
$nextSample = 0
$windowObserved = $false
while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
  $rootProcess.Refresh()
  $elapsed = [math]::Round($watch.Elapsed.TotalMilliseconds, 1)
  if ($rootProcess.HasExited) {
    @{event='exit';elapsedMs=$elapsed} | ConvertTo-Json -Compress
    break
  }
  if (-not $windowObserved -and $rootProcess.MainWindowHandle -ne 0 -and
      $rootProcess.MainWindowTitle -eq 'Mivlet' -and $rootProcess.Responding) {
    @{event='window';elapsedMs=$elapsed} | ConvertTo-Json -Compress
    $windowObserved = $true
  }
  if ($watch.ElapsedMilliseconds -ge $nextSample) {
    $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -Property ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize,PrivatePageCount | ForEach-Object {
      if ($_.CreationDate) {
        @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;
          createdAt=$_.CreationDate.ToUniversalTime().ToString('o');
          workingSetBytes=[long]$_.WorkingSetSize;privateBytes=[long]$_.PrivatePageCount}
      }
    })
    if ($rootProcess.HasExited) {
      @{event='exit';elapsedMs=[math]::Round($watch.Elapsed.TotalMilliseconds, 1)} | ConvertTo-Json -Compress
      break
    }
    @{event='sample';elapsedMs=[math]::Round($watch.Elapsed.TotalMilliseconds, 1);processes=$rows} |
      ConvertTo-Json -Depth 4 -Compress
    $nextSample = $watch.ElapsedMilliseconds + 1000
  }
  Start-Sleep -Milliseconds 50
}
