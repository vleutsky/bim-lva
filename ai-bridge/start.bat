@echo off
setlocal
cd /d "%~dp0\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите LTS с https://nodejs.org и перезапустите терминал.
  pause
  exit /b 1
)
echo Starting BIM.LVA AI bridge...
node ai-bridge\server.mjs
pause
