@echo off
setlocal
rem Foreground, offline by default. No environment variable can silently enable live mode.
node "%~dp0nightly.mjs" %*
exit /b %errorlevel%
