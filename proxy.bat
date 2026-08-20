@echo off
cd /d "%~dp0"
title life-support
set LOG_FILE=%~dp0proxy.log

rem The model that haiku is remapped to (must be available to your token).
rem This is only the STARTUP default: once config.json exists (the panel writes it)
rem the value here is ignored and everything is driven from the panel.
rem To disable the remap entirely: set HAIKU_MODEL=off
set HAIKU_MODEL=claude-opus-4-8

rem How long to wait for response headers from the gateway: longer than this and
rem the attempt is torn down and quietly retried. When agentrouter is overloaded the
rem first byte arrives after 30-48s, so a low threshold (12-20s) KILLS live requests
rem that would have made it -> wasted attempts and a 502 for the client.
rem Duplicates the default in proxy.js: the panel starts node directly, bypassing
rem this .bat, so proxy.js is the source of truth.
set UPSTREAM_TIMEOUT_MS=90000

rem Panel: panel.bat
node proxy.js
pause
