#!/bin/zsh
# Double-click this file to start Kids Check-In on this Mac.
# It opens the kiosk in your browser; keep this window open while checking in.
cd "$(dirname "$0")"
echo "Starting Kids Check-In…  (close this window to stop)"
( sleep 2; open "http://localhost:8000" ) &
python3 run_local.py --port 8000
