@echo off
setlocal
rem %1 = SSH host, %2 = key path (may be empty — Cursor передаёт пустой argv)
set "FLORA_SSH_KEY=%~2"
cd /d "%~dp0.."
echo [Flora Web] publish FULL  host=[%~1]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-from-task.ps1" -SshHost "%~1"
exit /b %ERRORLEVEL%
