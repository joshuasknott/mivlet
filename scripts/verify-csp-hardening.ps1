param(
    [string]$ScratchDir
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not $ScratchDir) {
    if ($env:GROK_GOAL_SCRATCH) {
        $ScratchDir = Join-Path $env:GROK_GOAL_SCRATCH 'implementer'
    } else {
        $ScratchDir = 'C:\Users\Josh\AppData\Local\Temp\grok-goal-9abb2017f897\implementer'
    }
}
$scratch = $ScratchDir
New-Item -ItemType Directory -Path $scratch -Force | Out-Null

# Step 1 ONLY (per strategy restructure): run the EXACT plan command, write ONLY csp-test.log
$cspLog = Join-Path $scratch 'csp-test.log'
Write-Host "=== CSP tests (exact plan command) ==="
$cmd = 'pnpm --filter @fable/desktop test -- --run src/lib/tauri-csp.test.ts'
$output = & cmd.exe /c "$cmd 2>&1"
$exitCode = $LASTEXITCODE
$output | Out-File -FilePath $cspLog -Encoding UTF8
"=== EXIT_CODE: $exitCode ===" | Out-File -FilePath $cspLog -Append -Encoding UTF8
Write-Host "CSP test exit: $exitCode (log: $cspLog)"

if ($exitCode -ne 0) {
    Write-Host "Step 1 failed (see $cspLog)"
    exit $exitCode
}

Write-Host "Verifier step 1 complete. Only csp-test.log written."
exit 0
