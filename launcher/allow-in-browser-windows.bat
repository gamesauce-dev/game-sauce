@echo off
rem Stops Chrome and Edge asking "Open game-sauce launcher?" every time you press Play locally, for ONE game-sauce address.
rem Needs administrator rights (it sets a browser policy for this PC). Undo:  allow-in-browser-windows.bat remove
rem See docs\LOCAL-LAUNCH.md ("Skip the browser's question").
setlocal
net session >nul 2>nul
if errorlevel 1 (
  echo This needs administrator rights. Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
set "MODE="
if /i "%~1"=="remove" set "MODE=-Remove"

echo Type your game-sauce address exactly as it appears in the browser's address bar,
echo for example  http://192.168.1.50:8765   (nothing after the port).
set "ORIGIN="
set /p ORIGIN=Address: 
if "%ORIGIN%"=="" exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-in-browser-windows.ps1" -Origin "%ORIGIN%" %MODE%
if errorlevel 1 (
  echo.
  echo Something went wrong - see the message above. Nothing was left half done for that browser.
  pause
  exit /b 1
)
echo.
echo Done. Close and reopen Chrome / Edge for it to take effect.
pause
