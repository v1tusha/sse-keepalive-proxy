@echo off
REM CLI PROXY :: panel. UTF-8 in the console + ExecutionPolicy workaround for PS 5.1.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel.ps1" %*
