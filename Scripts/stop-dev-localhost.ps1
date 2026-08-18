#Requires -Version 5.1
<#
Освобождает порты локальной разработки перед flora-api / next dev.

  ./Scripts/stop-dev-localhost.ps1 -Api
  ./Scripts/stop-dev-localhost.ps1 -Web
  ./Scripts/stop-dev-localhost.ps1 -Gov
  ./Scripts/stop-dev-localhost.ps1 -Mobile
  ./Scripts/stop-dev-localhost.ps1 -Api -Web

Вызывается из .vscode/tasks.json и Scripts/mobile-debug-android.ps1.
-Web освобождает только 3000 (Social) и не трогает Gov на 3001.
-Gov освобождает только 3001 и не трогает Social на 3000.
#>
param(
    [switch] $Api,
    [switch] $Web,
    [switch] $Gov,
    [switch] $Mobile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

if (-not $Api -and -not $Web -and -not $Gov -and -not $Mobile) {
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

    Get-Process -Name "flora-api" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ProcessSafe -ProcessId $_.Id -Reason "flora-api.exe"
    }

    $dotnet = Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $dotnet) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if ($cmd -notmatch 'Flora\.API') { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "dotnet Flora.API"
    }

    # cargo run -p flora-api / run-rust-gateway-localhost.ps1
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^(cargo|rustc|pwsh|powershell|cmd)\.exe$' -and
            $_.CommandLine -and
            ($_.CommandLine -match 'flora-api' -or $_.CommandLine -match 'run-rust-gateway-localhost')
        }
    foreach ($proc in $procs) {
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "gateway launcher ($($proc.Name))"
    }
}

function Test-NextDevCommand {
    param([string] $CommandLine)
    return (
        $CommandLine -match 'next(\.cmd)?\s+dev' -or
        $CommandLine -match '\\next\\dist\\bin\\next'
    )
}

function Test-GovNextCommand {
    param([string] $CommandLine)
    return (
        $CommandLine -match 'Apps[\\/]Gov' -or
        $CommandLine -match '--port\s+3001'
    )
}

function Stop-SocialNextProcesses {
    Stop-ListenersOnPort -Port 3000

    $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $node) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if (-not (Test-NextDevCommand -CommandLine $cmd)) { continue }
        if (Test-GovNextCommand -CommandLine $cmd) { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "next dev (Social :3000)"
    }
}

function Stop-GovNextProcesses {
    Stop-ListenersOnPort -Port 3001

    $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $node) {
        $cmd = $proc.CommandLine
        if ($null -eq $cmd) { continue }
        if (-not (Test-NextDevCommand -CommandLine $cmd)) { continue }
        if (-not (Test-GovNextCommand -CommandLine $cmd)) { continue }
        Stop-ProcessSafe -ProcessId $proc.ProcessId -Reason "next dev (Gov :3001)"
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
    Write-Host "Flora dev: freeing API ports 5284 (.NET) + 5290 (Rust gateway)..."
    Stop-ListenersOnPort -Port 5284
    Stop-ListenersOnPort -Port 5290
    Stop-FloraApiProcesses
    Start-Sleep -Milliseconds 400
    Stop-ListenersOnPort -Port 5284
    Stop-ListenersOnPort -Port 5290
}

if ($Web) {
    Write-Host "Flora dev: freeing Next.js port 3000 (Social)..."
    Stop-SocialNextProcesses
    Start-Sleep -Milliseconds 200
}

if ($Gov) {
    Write-Host "Flora dev: freeing Next.js port 3001 (Gov)..."
    Stop-GovNextProcesses
    Start-Sleep -Milliseconds 200
}

if ($Mobile) {
    Write-Host "Flora dev: freeing Metro ports 8081-8083..."
    Stop-MetroProcesses
}

Write-Host "Flora dev: ports ready."
