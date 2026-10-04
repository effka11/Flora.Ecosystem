@echo off
setlocal
cd /d "%~dp0.."
echo [Flora Web] cwd: %CD%
call npm run publish:build
exit /b %ERRORLEVEL%
