@echo off
cd /d "%~dp0"
git push -u origin main > push-result.txt 2>&1
type push-result.txt
timeout /t 8
