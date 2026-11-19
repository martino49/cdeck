@echo off
REM CDeck front-door command. Add this repo's bin to PATH, or run it from anywhere via:
REM   powershell -Command "& 'C:\Users\USER\Documents\droidlink\bin\cdeck.cmd' %*"
node "%~dp0\..\cli\cdeck.mjs" %*