param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$PreviousInstallerPath,
  [switch]$AllowMachineChanges
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Windows installer verification requires Windows." }
if (-not $AllowMachineChanges) {
  throw "Pass -AllowMachineChanges only on a disposable Windows test machine."
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($installer) -ne ".exe") {
  throw "The automated lifecycle rehearsal currently requires the unsigned NSIS .exe."
}
$previous = if ($PreviousInstallerPath) { (Resolve-Path -LiteralPath $PreviousInstallerPath).Path } else { $null }
$dataDirectory = Join-Path $env:APPDATA "com.fable.workspace"
if (Test-Path -LiteralPath $dataDirectory) {
  throw "Mivlet data already exists on this machine. Use a clean disposable runner."
}

function Invoke-Nsis([string]$Path) {
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
}

function Find-MivletUninstall {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($attempt in 1..20) {
    $record = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -in @("Mivlet", "Fable") } |
      Select-Object -First 1
    if ($record) { return $record }
    Start-Sleep -Milliseconds 250
  }
  throw "The Mivlet uninstall registration was not found."
}

function Assert-MivletUnregistered {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($attempt in 1..20) {
    $record = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -in @("Mivlet", "Fable") } |
      Select-Object -First 1
    if (-not $record) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Mivlet remained registered after uninstall."
}

function Resolve-Uninstaller([string]$Command) {
  if (-not $Command) { throw "The Mivlet uninstall command is missing." }
  if ($Command -match '^"([^"]+)"') { return $Matches[1] }
  return ($Command -split "\s+")[0]
}

try {
  if ($previous) { Invoke-Nsis $previous }
  else { Invoke-Nsis $installer }

  $firstRegistration = Find-MivletUninstall
  $uninstaller = Resolve-Uninstaller $firstRegistration.UninstallString
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "The registered Mivlet uninstaller does not exist."
  }

  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  $sentinel = Join-Path $dataDirectory "installer-lifecycle-sentinel.txt"
  Set-Content -LiteralPath $sentinel -Value "preserve" -NoNewline

  # With PreviousInstallerPath this is a real version-to-version upgrade. With
  # one installer it is an idempotent repair rehearsal.
  Invoke-Nsis $installer
  if ((Get-Content -LiteralPath $sentinel -Raw) -ne "preserve") {
    throw "The installer did not preserve the local data sentinel."
  }

  $registration = Find-MivletUninstall
  if ($registration.DisplayName -ne "Mivlet") { throw "The upgraded product name is not Mivlet." }
  $uninstaller = Resolve-Uninstaller $registration.UninstallString
  $process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Uninstaller exited with code $($process.ExitCode)." }
  Assert-MivletUnregistered
  if ((Get-Content -LiteralPath $sentinel -Raw) -ne "preserve") {
    throw "Uninstall removed or changed local Mivlet data."
  }
  Write-Output "Mivlet installer lifecycle verification passed; local data was preserved."
}
finally {
  if (Test-Path -LiteralPath $dataDirectory) {
    $resolvedData = (Resolve-Path -LiteralPath $dataDirectory).Path
    $expectedData = [IO.Path]::GetFullPath((Join-Path $env:APPDATA "com.fable.workspace"))
    if ($resolvedData -eq $expectedData) {
      Remove-Item -LiteralPath $resolvedData -Recurse -Force
    }
  }
}
