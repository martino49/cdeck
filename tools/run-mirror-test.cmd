@echo off
REM Runs the embedded-mirror test against the already-running CDeck instance.
REM Usage: tools\run-mirror-test.cmd
cd /d "%~dp0\.."
node tools\mirror-test.mjs "%~dp0mirror-test-result.json"
echo.
echo === RESULT ===
type "%~dp0mirror-test-result.json"