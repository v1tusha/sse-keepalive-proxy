@echo off
cd /d "%~dp0"
title sse-keepalive-proxy
set LOG_FILE=%~dp0proxy.log

rem Модель, в которую ремапится haiku (должна быть доступна твоему токену).
rem Это СТАРТОВЫЙ дефолт: как только появится config.json (панель его пишет) —
rem значение отсюда игнорируется, всё крутится с пультика.
rem Выключить ремап целиком: set HAIKU_MODEL=off
set HAIKU_MODEL=claude-opus-4-8

rem Порог ожидания заголовков от шлюза: без ответа дольше -> обрыв + тихий повтор.
rem При перегрузе agentrouter первый байт приходит за 30-48с, поэтому низкий порог
rem (12-20с) РУБИТ живые запросы, которые дожили бы -> лишние попытки и 502 клиенту.
rem Дубль дефолта из proxy.js: панель стартует node напрямую, мимо этого .bat,
rem так что источник истины — proxy.js.
set UPSTREAM_TIMEOUT_MS=90000

rem Пультик: panel.bat
node proxy.js
pause
