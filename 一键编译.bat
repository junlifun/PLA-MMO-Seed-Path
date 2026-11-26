@echo off
setlocal EnableExtensions
chcp 65001 >nul
title PLA MMO Seed ^& Path - Build
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\build_python_release.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" (
  echo [ERROR] 构建失败，退出码 %RESULT%。
) else (
  echo [OK] 构建完成，输出在 release 文件夹。
)
pause
exit /b %RESULT%
