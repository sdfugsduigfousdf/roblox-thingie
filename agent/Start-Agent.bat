@echo off
:: Run as Administrator
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RobloxAgent.ps1"
pause