@echo off
cd /d "%~dp0"
title SSE-Proxy
set LOG_FILE=%~dp0proxy.log
node proxy.js
pause
