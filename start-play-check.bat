@echo off
rem Start the play check window (Windows). Double-click this file.
rem First time it installs the test tools it needs; after that it just opens the window.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo The play check needs Node.js version 20 or newer, and it is not installed.
  echo Download the LTS version from https://nodejs.org, install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules\playwright\cli.js (
  echo.
  echo First time: installing the test tools. This can take a minute.
  echo.
  rem --ignore-scripts skips building the database library, which the play check does not use
  rem and which fails to build on very new Node versions.
  call npm ci --ignore-scripts
  if errorlevel 1 (
    echo.
    echo Could not install the test tools. Check your internet connection and read the message above.
    echo.
    pause
    exit /b 1
  )
)
rem Downloads the test browser the first time ^(about 150 MB^) and does nothing once it is there.
call npx playwright install chromium
if errorlevel 1 (
  echo.
  echo Could not download the test browser. Check your internet connection and read the message above.
  echo.
  pause
  exit /b 1
)
node scripts\check-play-gui.mjs %*
if errorlevel 1 pause
