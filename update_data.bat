@echo off
chcp 65001 >nul
setlocal
rem ---- A-Share Statistical Laboratory - update data only ----
set "PY=C:\Users\Lenovo\.dsh\mcp-servers\china-stock-mcp\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
cd /d "%~dp0"
echo [update] Fetching latest trading-day data and recomputing statistics ...
"%PY%" update_data.py
echo.
echo [done] Update finished. Press any key to close.
pause >nul
