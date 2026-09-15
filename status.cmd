@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action status
exit /b %errorlevel%
