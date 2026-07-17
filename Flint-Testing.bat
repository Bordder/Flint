@echo off
rem ============================================================
rem  Flint (Testing) launcher
rem  Runs Flint straight from the source files, so it always
rem  shows the latest changes. It uses a SEPARATE data folder
rem  (%APPDATA%\Flint-Dev) and never touches your real journal.
rem  Change a UI file and the window reloads by itself.
rem ============================================================
title Flint (Testing)

rem %~dp0 ends with a backslash; strip it so quoted paths don't break.
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
cd /d "%APPDIR%"

if not exist "%APPDIR%\node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies. This can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo Could not install dependencies. Install Node.js from https://nodejs.org and try again.
    pause
    exit /b 1
  )
)

start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
