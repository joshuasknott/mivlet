# CI-only harness. Production execution continues to reject elevated tokens.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This harness requires a disposable GitHub-hosted Windows runner.'
}

$artifacts = @(cargo test --manifest-path packages/windows-executor/Cargo.toml --no-run --message-format=json)
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native acceptance executable.' }
$executables = @($artifacts | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
  $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable -and $_.target.name -eq 'mivlet_windows_executor'
} | ForEach-Object { $_.executable })
if ($executables.Count -ne 1) { throw 'Expected exactly one native acceptance executable.' }

$name = 'MivletAcceptance'
$password = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$created = $false
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
try {
  $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
  $created = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  $env:MIVLET_CI_EXECUTION_OWNER = $user.SID.Value
  $setup = @(& $executables[0] acceptance::native_ci_setup_acceptance --ignored --exact --nocapture --test-threads=1 2>&1)
  $setupExit = $LASTEXITCODE
  $setup | Write-Output
  if ($setupExit -ne 0 -or -not ($setup -match 'test result: ok\. 1 passed;')) { throw 'Native CI setup failed or no test ran.' }

  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $logRoot = Join-Path $env:RUNNER_TEMP 'mivlet-native-acceptance'
  New-Item -ItemType Directory -Path $logRoot | Out-Null
  # The test executable/runtime are read-only to the test identity. Only the
  # fresh diagnostic directory and its own Windows profile are writable.
  & icacls.exe $env:GITHUB_WORKSPACE /grant "*$($user.SID.Value):(OI)(CI)RX" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant acceptance read access.' }
  & icacls.exe $logRoot /grant "*$($user.SID.Value):(OI)(CI)M" /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant diagnostic access.' }
  $env:TEMP = $logRoot
  $env:TMP = $logRoot
  foreach ($test in @('acceptance::native_pipe_namespace_acceptance', 'lifecycle_acceptance::native_live_build_and_test_acceptance', 'acceptance::native_execution_acceptance', 'lifecycle_acceptance::native_live_persistent_process_acceptance', 'lifecycle_acceptance::native_loopback_isolation_acceptance')) {
    $stem = $test.Replace('::', '-')
    $stdout = Join-Path $logRoot "$stem.out.log"
    $stderr = Join-Path $logRoot "$stem.err.log"
    $process = Start-Process -FilePath $executables[0] -ArgumentList @($test, '--ignored', '--exact', '--nocapture', '--test-threads=1') -Credential $credential -LoadUserProfile -WorkingDirectory $env:GITHUB_WORKSPACE -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    if (-not $process.WaitForExit(180000)) {
      $process.Kill($true)
      throw "Native acceptance exceeded three minutes: $test"
    }
    $process.WaitForExit()
    $result = @(Get-Content -LiteralPath $stdout; Get-Content -LiteralPath $stderr)
    $result | Write-Output
    if ($process.ExitCode -ne 0 -or -not ($result -match 'test result: ok\. 1 passed;')) { throw "Native acceptance failed or no test ran: $test" }
  }
} finally {
  $env:TEMP = $originalTemp
  $env:TMP = $originalTmp
  Remove-Item Env:\MIVLET_CI_EXECUTION_OWNER -ErrorAction SilentlyContinue
  if ($created) { Remove-LocalUser -Name $name }
}

$receipt = Get-Content -LiteralPath C:\mivlet-node-lpac\artifact-receipt.json -Raw | ConvertFrom-Json
@{ sourceCommit = $env:GITHUB_SHA; artifactSha256 = $receipt.sha256; executableSha256 = $receipt.executableSha256; win32PipeProbe = 'passed'; restrictedNodeTestRunner = 'passed'; credentialIsolation = 'passed'; descendantStop = 'passed'; loopbackIsolation = 'passed'; packagedApp = 'not-tested'; liveProvider = 'not-tested' } | ConvertTo-Json | Set-Content -LiteralPath C:\mivlet-node-lpac\acceptance.json -Encoding utf8NoBOM
