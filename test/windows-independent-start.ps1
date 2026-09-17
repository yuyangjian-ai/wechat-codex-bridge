Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Real Windows integration test. Copies only launch scripts into an isolated fixture;
# the fake Node program never calls Codex, Weixin, or any network endpoint.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeLaunchTestNative {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
}
'@
function Test-InJob {
    param([System.Diagnostics.Process]$Process)
    $result = $false
    if (-not [BridgeLaunchTestNative]::IsProcessInJob($Process.Handle, [IntPtr]::Zero, [ref]$result)) { throw 'Cannot query process Job.' }
    return $result
}
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Wait-Until {
    param([scriptblock]$Condition, [string]$Message)
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while (-not (& $Condition)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw $Message }
        Start-Sleep -Milliseconds 100
    }
}

$testSourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testFixtureRoot = Join-Path $testTempRoot ("bridge startup `$cash & single'quote-" + [Guid]::NewGuid().ToString('N'))
$testRuntime = Join-Path $testFixtureRoot '.runtime'
$testEntry = Join-Path $testFixtureRoot 'dist\src\main.js'
$testPidFile = Join-Path $testRuntime 'bridge.pid'
$testStopFile = Join-Path $testRuntime 'stop.request'
$testPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$testLauncherOutput = Join-Path $testFixtureRoot 'launcher.stdout.log'
$testLauncherError = Join-Path $testFixtureRoot 'launcher.stderr.log'
$testOriginalEnvironment = @{}
foreach ($name in @('CODEX_HOME', 'BRIDGE_TEST_EXPECTED_HOME', 'BRIDGE_TEST_EXPECTED_LOCAL', 'BRIDGE_TEST_EXPECTED_PATH')) {
    $testOriginalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$testBridge = $null

function Invoke-FixtureAction {
    param([string]$Action, [int]$ExpectedExitCode = 0)
    $arguments = ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action {1}' -f (Join-Path $testFixtureRoot 'scripts\manage.ps1'), $Action
    $launcher = Start-Process -FilePath $testPowerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $testLauncherOutput -RedirectStandardError $testLauncherError
    try {
        Assert-True (Test-InJob $launcher) 'Fixture launcher must start inside the caller Windows Job.'
        if (-not $launcher.WaitForExit(25000)) { $launcher.Kill(); throw 'Fixture launcher timed out.' }
        # Ensure asynchronous stdout/stderr redirection has drained.
        $launcher.WaitForExit()
        if ($launcher.ExitCode -ne $ExpectedExitCode) {
            $output = [System.IO.File]::ReadAllText($testLauncherOutput)
            throw ('Fixture action {0} failed: {1}' -f $Action, $output)
        }
    }
    finally { $launcher.Dispose() }
}

try {
    Assert-True (Test-InJob ([System.Diagnostics.Process]::GetCurrentProcess())) 'Run this test from a Job-managed shell to verify breakaway.'
    New-Item -ItemType Directory -Path (Join-Path $testFixtureRoot 'scripts'), (Join-Path $testFixtureRoot 'dist\src'), $testRuntime -Force | Out-Null
    foreach ($script in @('manage.ps1', 'start-independent.ps1')) {
        Copy-Item -LiteralPath (Join-Path $testSourceRoot ('scripts\' + $script)) -Destination (Join-Path $testFixtureRoot ('scripts\' + $script))
    }
    $fakeProgram = @'
const fs = require('node:fs');
const path = require('node:path');
const runtime = path.join(process.cwd(), '.runtime');
const pidFile = path.join(runtime, 'bridge.pid');
const stopFile = path.join(runtime, 'stop.request');
fs.writeFileSync(pidFile, String(process.pid));
fs.appendFileSync(path.join(runtime, 'fake-start-count'), 'started\n');
fs.writeFileSync(path.join(runtime, 'fixture-env.json'), JSON.stringify({
  codexHomeMatches: process.env.CODEX_HOME === process.env.BRIDGE_TEST_EXPECTED_HOME,
  localAppDataMatches: process.env.LOCALAPPDATA === process.env.BRIDGE_TEST_EXPECTED_LOCAL,
  pathMatches: process.env.PATH === process.env.BRIDGE_TEST_EXPECTED_PATH
}));
const status = () => fs.writeFileSync(path.join(runtime, 'status.json'), JSON.stringify({
  state: 'running', updatedAt: new Date().toISOString(), pendingJobs: 0, pid: process.pid
}));
status();
console.log('fixture bridge started');
setInterval(() => {
  if (fs.existsSync(stopFile)) {
    if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile);
    fs.unlinkSync(stopFile);
    console.log('fixture bridge stopped');
    process.exit(0);
  }
  status();
}, 100);
'@
    [System.IO.File]::WriteAllText($testEntry, $fakeProgram, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText((Join-Path $testRuntime 'bridge.stdout.log'), 'original stdout evidence')
    [System.IO.File]::WriteAllText((Join-Path $testRuntime 'bridge.stderr.log'), 'original stderr evidence')
    [Environment]::SetEnvironmentVariable('CODEX_HOME', (Join-Path $testFixtureRoot '中文 test profile $ & value'), 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_TEST_EXPECTED_HOME', $env:CODEX_HOME, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_TEST_EXPECTED_LOCAL', $env:LOCALAPPDATA, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_TEST_EXPECTED_PATH', $env:PATH, 'Process')

    Invoke-FixtureAction start
    $testBridgeId = [int][System.IO.File]::ReadAllText($testPidFile)
    $testBridge = [System.Diagnostics.Process]::GetProcessById($testBridgeId)
    Assert-True (-not (Test-InJob $testBridge)) 'Bridge still belongs to a Windows Job.'
    Assert-True ($testBridge.SessionId -eq [System.Diagnostics.Process]::GetCurrentProcess().SessionId) 'Bridge session changed.'
    $testOwner = Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId = $testBridgeId") -MethodName GetOwnerSid
    Assert-True ($testOwner.ReturnValue -eq 0 -and $testOwner.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Bridge user changed.'
    $testEnvironment = [System.IO.File]::ReadAllText((Join-Path $testRuntime 'fixture-env.json')) | ConvertFrom-Json
    Assert-True ($testEnvironment.codexHomeMatches -and $testEnvironment.localAppDataMatches -and $testEnvironment.pathMatches) 'Caller environment was not preserved.'
    $testHeartbeat = ([System.IO.File]::ReadAllText((Join-Path $testRuntime 'status.json')) | ConvertFrom-Json).updatedAt
    Wait-Until { ([System.IO.File]::ReadAllText((Join-Path $testRuntime 'status.json')) | ConvertFrom-Json).updatedAt -ne $testHeartbeat } 'Bridge stopped when its launcher exited.'
    $testArchives = @(Get-ChildItem -LiteralPath (Join-Path $testRuntime 'logs') -File)
    Assert-True ($testArchives.Count -eq 2) 'Previous logs were not both archived.'
    $testEvidence = @($testArchives | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) })
    Assert-True ('original stdout evidence' -in $testEvidence -and 'original stderr evidence' -in $testEvidence) 'Log evidence changed.'

    Invoke-FixtureAction start
    Assert-True ([int][System.IO.File]::ReadAllText($testPidFile) -eq $testBridgeId) 'Duplicate start replaced the bridge PID.'
    Assert-True ([System.IO.File]::ReadAllLines((Join-Path $testRuntime 'fake-start-count')).Length -eq 1) 'Duplicate start created a second Node process.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRuntime 'logs') -File).Count -eq 2) 'Duplicate start rotated active logs.'
    Invoke-FixtureAction stop
    Wait-Until { -not (Test-Path -LiteralPath $testPidFile) } 'Normal stop failed to clean its PID file.'
    Assert-True ($testBridge.WaitForExit(5000)) 'Normal stop did not exit the fake Node process.'

    # A PID pointing at this test shell is foreign to the fixture entry and must not be touched.
    [System.IO.File]::WriteAllText($testPidFile, [string]$PID)
    Invoke-FixtureAction start 1
    Assert-True ([int][System.IO.File]::ReadAllText($testPidFile) -eq $PID) 'Foreign PID protection changed the PID file.'
    Assert-True ([System.IO.File]::ReadAllLines((Join-Path $testRuntime 'fake-start-count')).Length -eq 1) 'Foreign PID protection launched a new bridge.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRuntime 'logs') -File).Count -eq 2) 'Foreign PID protection rotated logs.'
    Remove-Item -LiteralPath $testPidFile
    Write-Output 'PASS: Job-managed launcher -> independent Node; same user/session/environment; survives launcher exit; special-character paths; log preservation; duplicate start; normal stop; foreign PID protection.'
}
finally {
    if (Test-Path -LiteralPath $testPidFile) {
        $testCleanupId = 0
        if ([int]::TryParse([System.IO.File]::ReadAllText($testPidFile), [ref]$testCleanupId) -and $testCleanupId -gt 0) {
            $testCleanupProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $testCleanupId"
            if ($null -ne $testCleanupProcess -and $testCleanupProcess.Name -eq 'node.exe' -and
                $testCleanupProcess.CommandLine -match [regex]::Escape($testEntry)) {
                [System.IO.File]::WriteAllText($testStopFile, 'test cleanup')
                $testCleanupNode = [System.Diagnostics.Process]::GetProcessById($testCleanupId)
                if (-not $testCleanupNode.WaitForExit(5000)) { $testCleanupNode.Kill(); $testCleanupNode.WaitForExit(3000) | Out-Null }
                $testCleanupNode.Dispose()
            }
        }
    }
    if ($null -ne $testBridge) { $testBridge.Dispose() }
    foreach ($name in $testOriginalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $testOriginalEnvironment[$name], 'Process') }
    if (Test-Path -LiteralPath $testFixtureRoot) {
        $testResolvedRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $testFixtureRoot).ProviderPath)
        if ($testResolvedRoot -ne [System.IO.Path]::GetFullPath($testFixtureRoot) -or
            [System.IO.Path]::GetDirectoryName($testResolvedRoot) -ne $testTempRoot -or
            [System.IO.Path]::GetFileName($testResolvedRoot) -notmatch '^bridge startup \$cash & single''quote-[0-9a-f]{32}$') {
            throw 'Refusing to clean an unexpected fixture path.'
        }
        Remove-Item -LiteralPath $testResolvedRoot -Recurse -Force
    }
}
