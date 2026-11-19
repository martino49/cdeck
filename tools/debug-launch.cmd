@echo off
REM Starts CDeck with a remote debugging port so tests can drive the UI.
REM Run this yourself; opencode will not spawn it.
cd /d "%~dp0\.."
start "" node_modules\electron\dist\electron.exe --remote-debugging-port=9333 . > "%TEMP%\cdeck-debug.log" 2>&1
echo CDeck started with debug port 9333 (log: %TEMP%\cdeck-debug.log)