@echo off
rem Job Agent launcher: double-click (or use the desktop shortcut). Closing this window stops the app.
cd /d "%~dp0"
title Job Agent
where node >nul 2>nul || (echo Node.js is not installed. Run install.cmd first. & goto :fail)
if not exist node_modules (echo First run: installing dependencies... & call npm ci || goto :fail)
if not exist .env (call npm run setup || goto :fail)
call npm run ui
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Job Agent stopped with an error. Read the message above.
pause
exit /b 1
