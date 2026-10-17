@echo off
setlocal
cd /d "%~dp0"

echo Starting Linkstash at http://127.0.0.1:3000
start "Linkstash server" /D "%~dp0" cmd /k "npm run build && npm start"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:3000

echo.
echo The server is running in a separate window. Close that window to stop it.
pause
