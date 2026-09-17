param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{32}$')][string]$LaunchId,
    [Parameter(Mandatory = $true)][ValidatePattern('^S-1-[0-9-]+$')][string]$ExpectedUserSid,
    [Parameter(Mandatory = $true)][int]$ExpectedSessionId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeRuntime = Join-Path $bridgeRoot '.runtime'
$bridgeEntry = Join-Path $bridgeRoot 'dist\src\main.js'
$bridgeLaunchResult = Join-Path $bridgeRuntime ('start-{0}.json' -f $LaunchId)
$bridgeLaunchTemporary = $bridgeLaunchResult + '.tmp'
$bridgeStarted = $null

function Test-BridgeProcessInJob {
    param([System.Diagnostics.Process]$BridgeProcess)
    $bridgeInJob = $false
    if (-not [WeChatBridgeNativeProcess]::IsProcessInJob($BridgeProcess.Handle, [IntPtr]::Zero, [ref]$bridgeInJob)) {
        throw '无法验证 Windows Job 状态。'
    }
    return $bridgeInJob
}

function Write-BridgeLaunchResult {
    param([hashtable]$Result)
    $bridgeResultJson = $Result | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($bridgeLaunchTemporary, $bridgeResultJson, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::Move($bridgeLaunchTemporary, $bridgeLaunchResult)
}

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeChatBridgeNativeProcess {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
}
'@
    $bridgeSelf = [System.Diagnostics.Process]::GetCurrentProcess()
    if ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $ExpectedUserSid -or
        $bridgeSelf.SessionId -ne $ExpectedSessionId -or (Test-BridgeProcessInJob -BridgeProcess $bridgeSelf)) {
        throw '启动器未与调用进程隔离，或用户会话不一致。'
    }
    if (-not [System.IO.Path]::IsPathRooted($NodeExecutable) -or
        -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf) -or
        [System.IO.Path]::GetFileName($NodeExecutable) -ne 'node.exe' -or
        -not (Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) {
        throw '启动文件无效。'
    }
    # The only command argument is this script's own fixed, absolute JS entry path.
    $bridgeStarted = Start-Process -FilePath $NodeExecutable -ArgumentList ('"{0}" start' -f $bridgeEntry) `
        -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $bridgeRuntime 'bridge.stdout.log') `
        -RedirectStandardError (Join-Path $bridgeRuntime 'bridge.stderr.log')
    if ((Test-BridgeProcessInJob -BridgeProcess $bridgeStarted) -or $bridgeStarted.SessionId -ne $ExpectedSessionId) {
        throw '桥接进程仍受 Windows Job 管理，或用户会话不一致。'
    }
    $bridgeChild = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $bridgeStarted.Id)
    $bridgeOwner = Invoke-CimMethod -InputObject $bridgeChild -MethodName GetOwnerSid
    if ($bridgeOwner.ReturnValue -ne 0 -or $bridgeOwner.Sid -ne $ExpectedUserSid) {
        throw '桥接进程用户不一致。'
    }
    Write-BridgeLaunchResult -Result @{ success = $true; processId = $bridgeStarted.Id; independent = $true }
}
catch {
    # Only terminate the exact child this bootstrap created, never a PID from a file.
    if ($null -ne $bridgeStarted) {
        try { if (-not $bridgeStarted.HasExited) { $bridgeStarted.Kill(); $bridgeStarted.WaitForExit(3000) | Out-Null } } catch {}
    }
    try {
        Write-BridgeLaunchResult -Result @{ success = $false; error = '独立启动验证失败，请检查本机启动环境；未回退到依附 Codex 的启动方式。' }
    } catch {}
    exit 1
}
