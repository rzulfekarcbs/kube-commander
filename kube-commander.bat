@echo off
cd /d C:\projects\kube-commander
call npx vite build >nul 2>&1
start "" npx electron .
