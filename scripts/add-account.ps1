Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeEntry = Join-Path $bridgeRoot 'dist\src\main.js'
$bridgeRuntime = Join-Path $bridgeRoot '.runtime'
$bridgePage = Join-Path $bridgeRuntime 'login.html'
$bridgeLoginPid = Join-Path $bridgeRuntime 'login.pid'

try {
    if (-not (Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) {
        throw 'Run npm install and npm run build in the bridge folder first.'
    }
    New-Item -ItemType Directory -Path $bridgeRuntime -Force | Out-Null
    if (Test-Path -LiteralPath $bridgeLoginPid -PathType Leaf) {
        $loginProcessId = 0
        if ([int]::TryParse([System.IO.File]::ReadAllText($bridgeLoginPid).Trim(), [ref]$loginProcessId) -and $loginProcessId -gt 0) {
            $loginProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $loginProcessId"
            if ($null -ne $loginProcess) {
                $entryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($bridgeEntry) + '"?(?=\s|$)'
                if ($loginProcess.Name -ne 'node.exe' -or $loginProcess.CommandLine -notmatch $entryPattern -or $loginProcess.CommandLine -notmatch '(?i)\slogin(?:\s|$)') {
                    throw 'The login PID belongs to another process. Check .runtime/login.pid.'
                }
                if (Test-Path -LiteralPath $bridgePage) { Start-Process -FilePath $bridgePage }
                Write-Host 'An account pairing window is already running.'
                exit 0
            }
        }
    }
    $bridgeNode = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $launchTime = [DateTime]::UtcNow
    $loginArguments = '"{0}" login' -f $bridgeEntry
    $pairingProcess = Start-Process -FilePath $bridgeNode -ArgumentList $loginArguments -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $bridgeRuntime 'login.stdout.log') -RedirectStandardError (Join-Path $bridgeRuntime 'login.stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 200
        if ((Test-Path -LiteralPath $bridgePage) -and (Get-Item -LiteralPath $bridgePage).LastWriteTimeUtc -ge $launchTime) {
            # This page is the interactive QR control the user opened this launcher to see.
            Start-Process -FilePath $bridgePage
            Write-Host 'Scan the QR code in the opened page with the NEW user WeChat account.'
            Write-Host 'Existing accounts stay connected. New accounts load automatically.'
            exit 0
        }
        $pairingProcess.Refresh()
        if ($pairingProcess.HasExited) { throw 'Pairing could not start. See .runtime/login.stderr.log.' }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Pairing is still starting. Open .runtime/login.html when it is ready.'
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
