@echo off
rem Double-click: record every replay under replays\ that has no complete recording yet. Run it again to continue.
rem Drop .rec files or folders onto this file to record those instead. Needs Steam running and logged in.
cd /d "%~dp0"
if "%~1"=="" goto all
python\python.exe tools\record_replay.py %*
goto end
:all
python\python.exe tools\record_replay.py replays
:end
pause
