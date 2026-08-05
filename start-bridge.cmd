@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" call pnpm install --frozen-lockfile
if errorlevel 1 exit /b %errorlevel%
call pnpm build
if errorlevel 1 exit /b %errorlevel%
call pnpm start
