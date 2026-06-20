#Requires -Version 5.1
<#
Освобождает порты локальной разработки перед dotnet watch / next dev.

  ./Scripts/stop-dev-localhost.ps1 -Api
  ./Scripts/stop-dev-localhost.ps1 -Web
  ./Scripts/stop-dev-localhost.ps1 -Mobile
  ./Scripts/stop-dev-localhost.ps1 -Api -Web

Вызывается из .vscode/tasks.json и Scripts/mobile-debug-android.ps1.
#>
param(
    [switch] $Api,
    [switch] $Web,
    [switch] $Mobile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

if (-not $Api -and -not $Web -and -not $Mobile) {
    $Api = $true
    $Web = $true
}

function Stop-ProcessSafe {
    param(
        [int] $ProcessId,
        [string] $Reason
    )
    if ($ProcessId -le 0) { return }
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        Write-Host "Stopping $($proc.ProcessName) (PID $ProcessId) - $Reason"
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
    catch {
        # Процесс уже завершился.
    }
}

function Stop-ListenersOnPort {
    param([int] $Port)

    $pids = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    ) | Where-Object { $_ -gt 0 } | Select-Object -Unique

    foreach ($procId in $pids) {
        Stop-ProcessSafe -ProcessId $procId -Reason "port $Port"
    }
}

function Stop-FloraApiProcesses {
    Get-Process -Name "Flora.API" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ProcessSafe -ProcessId $_.Id -Reason "Flora.API.exe"
    }

    $dotnet = Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $dotnet) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if ($cmd -notmatch 'Flora\.API') { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "dotnet Flora.API"
    }
}

function Stop-NextDevProcesses {
    foreach ($port in 3000, 3001) {
        Stop-ListenersOnPort -Port $port
    }

    $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $node) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if ($cmd -notmatch 'next(\.cmd)?\s+dev' -and $cmd -notmatch '\\next\\dist\\bin\\next') { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "next dev"
    }
}

function Stop-MetroProcesses {
    foreach ($port in 8081, 8082, 8083) {
        Stop-ListenersOnPort -Port $port
    }

    $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $node) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if ($cmd -notmatch 'expo\\bin\\cli\s+start' -and $cmd -notmatch '@expo\\cli') { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "expo metro"
    }

    Start-Sleep -Milliseconds 400

    foreach ($port in 8081, 8082, 8083) {
        Stop-ListenersOnPort -Port $port
    }
}

if ($Api) {
    Write-Host "Flora dev: freeing API port 5284..."
    Stop-ListenersOnPort -Port 5284
    Stop-FloraApiProcesses
    Start-Sleep -Milliseconds 400
    Stop-ListenersOnPort -Port 5284
}

if ($Web) {
    Write-Host "Flora dev: freeing Next.js ports 3000/3001..."
    Stop-NextDevProcesses
    Start-Sleep -Milliseconds 200
}

if ($Mobile) {
    Write-Host "Flora dev: freeing Metro ports 8081-8083..."
    Stop-MetroProcesses
}

Write-Host "Flora dev: ports ready."
