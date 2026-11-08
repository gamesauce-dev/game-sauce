@echo off
rem Registers the gamesauce:// link for the current Windows user, so the "Play locally" button in game-sauce
rem can start the launcher. No administrator rights needed (it only writes under HKEY_CURRENT_USER).
rem Undo it with uninstall-windows.bat.
setlocal
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is needed and was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

reg add "HKCU\Software\Classes\gamesauce" /ve /d "URL:game-sauce launcher" /f >nul
reg add "HKCU\Software\Classes\gamesauce" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\gamesauce\shell\open\command" /ve /d "wscript.exe \"%HERE%gamesauce-launcher.vbs\" \"%%1\"" /f >nul
if errorlevel 1 (
  echo Could not write the registry entry.
  pause
  exit /b 1
)

echo.
echo Done. The gamesauce:// link now starts: %HERE%gamesauce-launcher.vbs
echo.
echo Next: create "%USERPROFILE%\.gamesauce\launcher.json" (the first Play locally click makes a template for you),
echo list your game-sauce address under "servers" and your emulators under "emulators".
echo See docs\LOCAL-LAUNCH.md.
echo.
pause
