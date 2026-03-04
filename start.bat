@echo off
cd /d C:\projects\kube-commander
call npx vite build >nul 2>&1
start "" "node_modules\electron\dist\electron.exe" .
