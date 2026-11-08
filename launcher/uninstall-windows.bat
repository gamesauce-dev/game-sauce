@echo off
rem Removes the gamesauce:// link registration made by install-windows.bat. Your launcher.json is left alone.
reg delete "HKCU\Software\Classes\gamesauce" /f >nul 2>nul
echo The gamesauce:// link is no longer registered.
pause
