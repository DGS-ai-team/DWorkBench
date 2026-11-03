@echo off
setlocal
title DWorkBench installation
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Install.ps1"
set "result=%ERRORLEVEL%"
if not "%result%"=="0" (
  echo.
  echo Installation did not complete. Review the message above and QUICKSTART.zh-CN.md.
  pause
)
exit /b %result%
