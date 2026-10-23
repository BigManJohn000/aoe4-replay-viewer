@echo off
rem Double-click: opens the Replay Recorder page in your browser. Paste aoe4world match links there; each replay is
rem downloaded and recorded in the game. Keep this window open while it records; close it to quit.
cd /d "%~dp0"
python\python.exe tools\recorder_app.py
pause
