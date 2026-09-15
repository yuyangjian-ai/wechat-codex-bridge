param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeEntry = Join-Path $bridgeRoot 'dist\src\main.js'
$bridgeRuntime = Join-Path $bridgeRoot '.runtime'
$bridgePidFile = Join-Path $bridgeRuntime 'bridge.pid'
$bridgeStatusFile = Join-Path $bridgeRuntime 'status.json'
$bridgeStopFile = Join-Path $bridgeRuntime 'stop.request'

function Get-BridgeProcessById {
    param([int]$BridgeProcessId)

    $bridgeProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $bridgeProcessId" -ErrorAction Stop
    if ($null -eq $bridgeProcess) {
        return @{ State = 'stale'; ProcessId = $bridgeProcessId }
    }

    # Inspect the command line for ownership only; never print it.
    $bridgeEntryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($bridgeEntry) + '"?(?=\s|$)'
    if ($bridgeProcess.Name -ne 'node.exe' -or
        [string]::IsNullOrWhiteSpace($bridgeProcess.CommandLine) -or
        $bridgeProcess.CommandLine -notmatch $bridgeEntryPattern) {
        return @{ State = 'foreign'; ProcessId = $bridgeProcessId }
    }

    return @{ State = 'running'; ProcessId = $bridgeProcessId }
}

function Get-BridgeProcess {
    if (-not (Test-Path -LiteralPath $bridgePidFile -PathType Leaf)) {
        return @{ State = 'missing'; ProcessId = $null }
    }

    $bridgePidText = [System.IO.File]::ReadAllText($bridgePidFile).Trim()
    $bridgeProcessId = 0
    if (-not [int]::TryParse($bridgePidText, [ref]$bridgeProcessId) -or $bridgeProcessId -le 0) {
        return @{ State = 'invalid'; ProcessId = $null }
    }

    return Get-BridgeProcessById -BridgeProcessId $bridgeProcessId
}

function Write-BridgeStatus {
    param([hashtable]$BridgeProcess)

    switch ($BridgeProcess.State) {
        'running' { Write-Host ('微信 Codex 桥接正在运行，PID：{0}' -f $BridgeProcess.ProcessId) }
        'foreign' { Write-Host 'PID 文件指向其他进程，无法确认桥接状态，未操作该进程。'; return }
        'invalid' { Write-Host 'PID 文件格式无效，无法确认桥接状态。'; return }
        default { Write-Host '微信 Codex 桥接未运行。'; return }
    }

    if (Test-Path -LiteralPath $bridgeStatusFile -PathType Leaf) {
        try {
            $bridgeStatus = [System.IO.File]::ReadAllText($bridgeStatusFile) | ConvertFrom-Json
            if ($bridgeStatus.PSObject.Properties.Name -contains 'state') {
                Write-Host ('状态：{0}' -f $bridgeStatus.state)
            }
            if ($bridgeStatus.PSObject.Properties.Name -contains 'updatedAt') {
                Write-Host ('最近心跳：{0}' -f $bridgeStatus.updatedAt)
            }
            if ($bridgeStatus.PSObject.Properties.Name -contains 'pendingJobs') {
                Write-Host ('排队任务：{0}' -f $bridgeStatus.pendingJobs)
            }
            if ($bridgeStatus.PSObject.Properties.Name -contains 'accessControlEnabled') {
                $bridgeAccessText = if ($bridgeStatus.accessControlEnabled) { '已启用' } else { '未启用' }
                Write-Host ('用户白名单：{0}' -f $bridgeAccessText)
            }
        }
        catch {
            Write-Host '状态文件暂不可读，请稍后再次查看。'
        }
    }
}

function Move-BridgeLogs {
    # Keep startup failures before Start-Process truncates its redirection files.
    $bridgeRuntimeFull = [System.IO.Path]::GetFullPath($bridgeRuntime).TrimEnd('\', '/')
    $bridgeRuntimePrefix = $bridgeRuntimeFull + [System.IO.Path]::DirectorySeparatorChar
    $bridgeArchiveDirectory = [System.IO.Path]::GetFullPath((Join-Path $bridgeRuntimeFull 'logs'))
    $bridgeLogPaths = @(
        (Join-Path $bridgeRuntimeFull 'bridge.stdout.log'),
        (Join-Path $bridgeRuntimeFull 'bridge.stderr.log')
    )
    $bridgePreviousLogs = @()
    foreach ($bridgeLogPath in $bridgeLogPaths) {
        if (Test-Path -LiteralPath $bridgeLogPath -PathType Leaf) {
            $bridgeLogItem = Get-Item -LiteralPath $bridgeLogPath -Force
            if ($bridgeLogItem.Length -gt 0) { $bridgePreviousLogs += $bridgeLogItem }
        }
    }
    if ($bridgePreviousLogs.Count -eq 0) { return }

    # Reject junctions/symlinks and check every source/destination before moving anything.
    foreach ($bridgeCheckPath in @($bridgeRuntimeFull, $bridgeArchiveDirectory) + $bridgeLogPaths) {
        $bridgeCheckFull = [System.IO.Path]::GetFullPath($bridgeCheckPath)
        if ($bridgeCheckFull -ne $bridgeRuntimeFull -and
            -not $bridgeCheckFull.StartsWith($bridgeRuntimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw '日志归档路径必须位于 .runtime 目录内。'
        }
        if (Test-Path -LiteralPath $bridgeCheckFull) {
            $bridgeCheckItem = Get-Item -LiteralPath $bridgeCheckFull -Force
            if (($bridgeCheckItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '日志路径包含目录联接或符号链接，已取消启动以保留日志。'
            }
            $bridgeResolvedFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $bridgeCheckFull).ProviderPath).TrimEnd('\', '/')
            if ($bridgeResolvedFull -ne $bridgeRuntimeFull -and
                -not $bridgeResolvedFull.StartsWith($bridgeRuntimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw '日志归档解析路径超出 .runtime 目录，已取消启动。'
            }
        }
    }
    if (-not (Test-Path -LiteralPath $bridgeArchiveDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $bridgeArchiveDirectory -ErrorAction Stop | Out-Null
    }
    $bridgeLogStamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss.fffffff'Z'")
    $bridgeLogSuffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    foreach ($bridgePreviousLog in $bridgePreviousLogs) {
        $bridgeArchiveName = '{0}.{1}.{2}.log' -f $bridgePreviousLog.BaseName, $bridgeLogStamp, $bridgeLogSuffix
        $bridgeArchivePath = [System.IO.Path]::GetFullPath((Join-Path $bridgeArchiveDirectory $bridgeArchiveName))
        if (-not $bridgeArchivePath.StartsWith($bridgeRuntimePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
            (Test-Path -LiteralPath $bridgeArchivePath)) {
            throw '日志归档目标无效或已存在，已取消启动以保留日志。'
        }
        Move-Item -LiteralPath $bridgePreviousLog.FullName -Destination $bridgeArchivePath -ErrorAction Stop
    }
    Write-Host '上次后台日志已保存到 .runtime\logs。'
}

try {
    $bridgeCurrent = Get-BridgeProcess

    if ($Action -eq 'status') {
        Write-BridgeStatus -BridgeProcess $bridgeCurrent
        if ($bridgeCurrent.State -in @('invalid', 'foreign')) { exit 1 }
        exit 0
    }

    if ($bridgeCurrent.State -in @('invalid', 'foreign')) {
        Write-BridgeStatus -BridgeProcess $bridgeCurrent
        Write-Host '请先检查 .runtime\bridge.pid；为避免重复启动或误停进程，本次操作已取消。'
        exit 1
    }

    if ($Action -eq 'stop') {
        if ($bridgeCurrent.State -ne 'running') {
            Write-Host '微信 Codex 桥接未运行。'
            exit 0
        }

        $bridgeStoppingId = $bridgeCurrent.ProcessId
        [System.IO.File]::WriteAllText($bridgeStopFile, [DateTime]::UtcNow.ToString('o'))
        $bridgeStopDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 500
            $bridgeCurrent = Get-BridgeProcessById -BridgeProcessId $bridgeStoppingId
            if ($bridgeCurrent.State -eq 'stale') {
                Write-Host '微信 Codex 桥接已停止。'
                exit 0
            }
            if ($bridgeCurrent.State -ne 'running') {
                Write-Host '停止期间进程信息发生变化，请运行 status.cmd 检查；未强制结束任何进程。'
                exit 1
            }
        } while ([DateTime]::UtcNow -lt $bridgeStopDeadline)

        Write-Host '已发送停止请求，15 秒内尚未退出。请稍后运行 status.cmd 查看状态。'
        exit 1
    }

    if ($bridgeCurrent.State -eq 'running') {
        Write-BridgeStatus -BridgeProcess $bridgeCurrent
        exit 0
    }
    if (-not (Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) {
        throw '未找到编译产物，请先在项目目录运行 npm install 和 npm run build。'
    }
    $bridgeNode = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not (Test-Path -LiteralPath $bridgeRuntime -PathType Container)) {
        New-Item -ItemType Directory -Path $bridgeRuntime -Force | Out-Null
    }
    # Recheck after startup preparation so another confirmed bridge is never rotated here.
    $bridgeCurrent = Get-BridgeProcess
    if ($bridgeCurrent.State -eq 'running') {
        Write-BridgeStatus -BridgeProcess $bridgeCurrent
        exit 0
    }
    if ($bridgeCurrent.State -in @('invalid', 'foreign')) {
        throw '启动前 PID 状态发生变化，已取消启动并保留现有日志。'
    }
    Move-BridgeLogs
    if (Test-Path -LiteralPath $bridgeStopFile -PathType Leaf) {
        Remove-Item -LiteralPath $bridgeStopFile -Force
    }
    $bridgeStartArguments = '"{0}" start' -f $bridgeEntry
    $bridgeStarted = Start-Process -FilePath $bridgeNode.Source -ArgumentList $bridgeStartArguments `
        -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $bridgeRuntime 'bridge.stdout.log') `
        -RedirectStandardError (Join-Path $bridgeRuntime 'bridge.stderr.log')

    $bridgeStartDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $bridgeStarted.Refresh()
        if ($bridgeStarted.HasExited) {
            throw '桥接进程启动后退出，请查看 .runtime\bridge.stderr.log 和 bridge.stdout.log。'
        }
        $bridgeCurrent = Get-BridgeProcess
        if ($bridgeCurrent.State -eq 'running') {
            Write-BridgeStatus -BridgeProcess $bridgeCurrent
            Write-Host '后台日志：.runtime\bridge.stdout.log 和 bridge.stderr.log'
            exit 0
        }
    } while ([DateTime]::UtcNow -lt $bridgeStartDeadline)

    Write-Host '已启动后台进程，但尚未确认 PID 文件。请稍后运行 status.cmd 并检查 .runtime 日志。'
    exit 1
}
catch {
    Write-Host ('操作失败：{0}' -f $_.Exception.Message)
    exit 1
}
