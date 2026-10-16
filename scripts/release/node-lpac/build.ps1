#requires -Version 7.2
[CmdletBinding()]
param(
  [switch]$Build,
  [string]$Directory,
  [string]$Python,
  [string]$Nasm
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$candidateScript = Join-Path $PSScriptRoot 'candidate.mjs'
$recipePath = Join-Path $PSScriptRoot 'recipe.json'
$recipe = Get-Content -LiteralPath $recipePath -Raw | ConvertFrom-Json
$node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source

if (-not $Build) {
  & $node $candidateScript --plan
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the candidate plan.' }
  Write-Output 'No download or compilation. Use -Build -Directory FRESH_ASCII_PATH after a native build grant.'
  return
}
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') { throw 'Use Windows x64 PowerShell 7.2+.' }
if (-not $Directory) { throw '-Directory is required and must not exist.' }
if (-not $Python) { $Python = Get-Command python.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source }
if (-not $Nasm) { $Nasm = Get-Command nasm.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source }
if ($Python -match '\\WindowsApps\\' -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw 'Supply an existing full Python installation; the Windows Store alias is not a build prerequisite.'
}
if ((Split-Path -Leaf $Python) -ne 'python.exe' -or (Split-Path -Leaf $Nasm) -ne 'nasm.exe') {
  throw 'Supply the existing python.exe and nasm.exe paths, not shims or installers.'
}
$git = Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = @(& $vswhere -latest -prerelease -products '*' -version '[17.6,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $vs.Count -ne 1) { throw 'Visual Studio 2022 17.6+ with the x64 C++ build tools is required.' }
$pythonVersion = & $Python --version 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $pythonVersion -notmatch '^Python 3\.') { throw 'Python 3 prerequisite failed.' }
$nasmVersion = & $Nasm -v 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $nasmVersion -notmatch '^NASM version ') { throw 'NASM prerequisite failed; no tool will be installed automatically.' }
$toolsetVersionPath = Join-Path $vs[0].installationPath 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
$toolsetVersion = (Get-Content -LiteralPath $toolsetVersionPath -Raw).Trim()
$sdkRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$sdkVersions = @(Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Select-Object -ExpandProperty Name)
if ($sdkVersions.Count -eq 0) { throw 'A Windows 10/11 SDK is required.' }
$toolchain = [ordered]@{
  bootstrapNode = (& $node --version)
  python = $pythonVersion.Trim()
  nasm = $nasmVersion.Trim()
  visualStudio = $vs[0].installationVersion
  defaultMsvcToolset = $toolsetVersion
  installedWindowsSdkVersions = $sdkVersions
  windows = [Environment]::OSVersion.Version.ToString()
  powershell = $PSVersionTable.PSVersion.ToString()
}
if ([int]($toolchain.bootstrapNode.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node 22+ is required for recipe tooling.' }
if ($recipe.build.command -ne 'vcbuild.bat' -or
    ($recipe.build.arguments -join ' ') -ne 'x64 vs2022 ltcg nosign no-cctest' -or
    $recipe.build.msbuildArguments -ne '/nr:false' -or
    $recipe.build.numberOfProcessors -ne 1 -or $recipe.build.priority -ne 'BelowNormal') {
  throw 'Recipe build flags must match this reviewed build driver.'
}

# All mutation is confined to a new build root; no tool installation or OS setup.
& $node $candidateScript --prepare $Directory
if ($LASTEXITCODE -ne 0) { throw 'Candidate preparation failed; no compiler started.' }
$source = Join-Path $Directory $recipe.source.directory
$temporary = Join-Path $Directory 'temp'
New-Item -ItemType Directory -Path $temporary | Out-Null
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
$start.Arguments = '/d /s /c "vcbuild.bat x64 vs2022 ltcg nosign no-cctest"'
$start.WorkingDirectory = $source
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment.Clear()
foreach ($key in @('SystemRoot', 'WINDIR', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($value) { $start.Environment[$key] = $value }
}
$start.Environment['PATH'] = @((Split-Path $Python), (Split-Path $Nasm), (Split-Path $git), (Split-Path $node), (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot) -join ';'
$start.Environment['TEMP'] = $temporary
$start.Environment['TMP'] = $temporary
$start.Environment['NUMBER_OF_PROCESSORS'] = '1'
$start.Environment['msbuild_args'] = '/nr:false'
$start.Environment['PYTHON'] = $Python
$start.Environment['NODE_OPTIONS'] = ''
$start.Environment['NODE_PATH'] = ''
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $start
$owner = [System.Diagnostics.Process]::GetCurrentProcess()
$previousPriority = $owner.PriorityClass
$stdout = [System.IO.File]::Open((Join-Path $Directory 'build-stdout.log'), 'CreateNew', 'Write')
$stderr = [System.IO.File]::Open((Join-Path $Directory 'build-stderr.log'), 'CreateNew', 'Write')
$started = $false
$beganAt = [DateTimeOffset]::UtcNow.ToString('o')
try {
  $owner.PriorityClass = 'BelowNormal'
  $started = $process.Start()
  if (-not $started) { throw 'Could not start the owned Node build.' }
  $process.PriorityClass = 'BelowNormal'
  Write-Output "Owned compiler root PID $($process.Id); one worker; logs in $Directory."
  $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
  $errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
  $process.WaitForExit()
  $outCopy.GetAwaiter().GetResult()
  $errCopy.GetAwaiter().GetResult()
  $buildRecord = [ordered]@{
    recipeSha256 = (Get-FileHash -LiteralPath $recipePath -Algorithm SHA256).Hash.ToLowerInvariant()
    command = 'vcbuild.bat x64 vs2022 ltcg nosign no-cctest'
    msbuildArguments = '/nr:false'
    numberOfProcessors = 1
    priority = 'BelowNormal'
    toolchain = $toolchain
    startedAt = $beganAt
    endedAt = [DateTimeOffset]::UtcNow.ToString('o')
    exitCode = $process.ExitCode
  }
  $buildRecord | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Directory 'build.json') -Encoding utf8NoBOM
  if ($process.ExitCode -ne 0) { throw "Node compilation failed ($($process.ExitCode)); preserve the logs and build root." }
} finally {
  if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  $stdout.Dispose()
  $stderr.Dispose()
  $process.Dispose()
  $owner.PriorityClass = $previousPriority
  $owner.Dispose()
}
& $node $candidateScript --package $Directory
if ($LASTEXITCODE -ne 0) { throw 'Candidate packaging failed; production runtime was not changed.' }
