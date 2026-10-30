@echo off
rem Start game-sauce on this computer (Windows). Double-click this file.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo game-sauce needs Node.js version 20 or newer, and it is not installed.
  echo Download the LTS version from https://nodejs.org, install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 pause
