@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PLA_BROWSER=1"
set "PLA_NO_BROWSER=1"
set "PLA_PORT=5000"

start "" "PLA-MMO-Seed-Path.exe"
timeout /t 4 /nobreak >nul

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Microsoft Edge was not found.
  pause
  exit /b 1
)

set "PROFILE=%LOCALAPPDATA%\PLA-MMO-Path-Finder\edge-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

start "" /wait "%EDGE%" --app=http://127.0.0.1:5000 --window-size=1440,900 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-background-mode
taskkill /IM PLA-MMO-Seed-Path.exe /F >nul 2>nul
exit /b 0
