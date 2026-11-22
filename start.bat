@echo off
chcp 65001 >nul
setlocal
rem ---- A-Share Statistical Laboratory - one-click start ----
set "PY=C:\Users\Lenovo\.dsh\mcp-servers\china-stock-mcp\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
if not exist "%PY%" (
  where python >nul 2>nul && set "PY=python"
)
cd /d "%~dp0"
echo [start] Launching A-Share Statistical Laboratory ...
"%PY%" app.py
echo.
echo [stop] Server exited. Press any key to close.
pause >nul
