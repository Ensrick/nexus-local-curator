<#
.SYNOPSIS
  Keep the Nexus curation relay always on, as a Scheduled Task named
  NexusCurationRelay. Idempotent: run it from any shell, any assistant, any
  time. Never starts curation-relay.py as a child of the caller.

.USAGE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File relay-ensure.ps1            # ensure (register if missing, start if down)
  ... relay-ensure.ps1 -Status     # report only, change nothing
  ... relay-ensure.ps1 -Register   # (re)register the task with current settings, then ensure
  ... relay-ensure.ps1 -Stop       # stop the relay and DISABLE the task (watchdog will not restart it)

.OUTPUT
  One line: "relay: listening on 127.0.0.1:38492 (pid N, task <State>)" and exit 0,
  or "relay: NOT listening ..." and exit 1. Probes /health only; never /decisions
  (that endpoint consumes the queued decisions).

.TASK
  Action   pyw.exe -3 "<scripts>\curation-relay.py" "<%TEMP%>\nlc-relay"
  Triggers AtLogOn (current user) + every 5 minutes (watchdog; the relay exits 0
           at once when the port is already served, so this is cheap)
  Settings MultipleInstances IgnoreNew, no time limit, restart 3x at 1 min,
           hidden, start when available, runs on battery
  Principal current user, Interactive, Limited
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Register,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NexusCurationRelay'
$Port = 38492
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Relay = Join-Path $Here 'curation-relay.py'
$Spool = Join-Path $env:TEMP 'nlc-relay'
$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Get-Pyw {
    $c = Get-Command pyw.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher\pyw.exe'
    if (Test-Path $p) { return $p }
    throw 'pyw.exe (Python launcher, windowless) not found'
}

function Test-Port {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(1000) -and $client.Connected
        return [bool]$ok
    } catch { return $false }
    finally { $client.Close() }
}

function Get-Health {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 }
    catch { return $null }
}

function Get-RelayProcs {
    Get-CimInstance Win32_Process -Filter "Name LIKE 'py%' OR Name LIKE 'python%'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'curation-relay\.py' }
}

function Get-Task {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Register-Relay {
    $pyw = Get-Pyw
    $action = New-ScheduledTaskAction -Execute $pyw -Argument ('-3 "{0}" "{1}"' -f $Relay, $Spool) -WorkingDirectory $Here
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $watch) `
        -Settings $settings -Principal $principal -Description 'Nexus Local Curator loopback relay (127.0.0.1:38492). Managed by scripts/relay-ensure.ps1.' -Force | Out-Null
    Write-Output "task: registered $TaskName (pyw -3 curation-relay.py, logon + 5 min watchdog)"
}

function Report {
    param([bool]$Listening)
    $task = Get-Task
    $state = if ($task) { [string]$task.State } else { 'MISSING' }
    if ($Listening) {
        $h = Get-Health
        $rpid = if ($h) { $h.pid } else { '?' }
        $line = "relay: listening on 127.0.0.1:$Port (pid $rpid, task $state)"
        if ($h -and $h.page_latest) {
            $line += "; last page $($h.page_latest.reportedAt) ($($h.page_latest.mods) mods)"
        }
        if ($h -and $h.pending) { $line += '; decisions PENDING pickup' }
        if (-not $h) { $line += '; WARNING: port open but /health failed (old relay build or foreign process)' }
        Write-Host $line
        return 0
    }
    Write-Host "relay: NOT listening on 127.0.0.1:$Port (task $state); see $Spool\relay.log"
    return 1
}

if ($Stop) {
    $task = Get-Task
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        Write-Output "task: $TaskName stopped and DISABLED (run without -Stop to re-enable)"
    }
    foreach ($p in Get-RelayProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "killed relay pid $($p.ProcessId)"
    }
    Start-Sleep -Milliseconds 500
    $code = Report -Listening (Test-Port)
    exit 0
}

if ($Status) {
    exit (Report -Listening (Test-Port))
}

$task = Get-Task
if ($Register -or -not $task) {
    Register-Relay
    $task = Get-Task
}
if ($task.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output "task: $TaskName re-enabled"
}

if (-not (Test-Port)) {
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
exit (Report -Listening (Test-Port))
