@echo off
setlocal
set "FLORA_SSH_KEY=%~2"
cd /d "%~dp0.."
echo [Flora Web] publish UPLOAD  host=[%~1]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-from-task.ps1" -SshHost "%~1" -SkipBuild
exit /b %ERRORLEVEL%
