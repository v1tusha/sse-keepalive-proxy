@echo off
REM CLI PROXY :: пульт. UTF-8 в консоли + обход ExecutionPolicy для PS 5.1.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel.ps1" %*
