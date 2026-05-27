@echo off
setlocal
cd /d "%~dp0"

python --version >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Please install Python or add it to PATH.
  pause
  exit /b 1
)

echo Starting LAN Sync Audio...
echo.
echo If port 3000 is already in use, close the old server window first.
echo Use the 192.168.x.x address on your phone when possible.
echo.

python app.py

echo.
echo Server stopped.
pause
