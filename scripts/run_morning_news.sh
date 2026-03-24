#!/bin/zsh
# Wrapper for launchd — loads .env then runs morning_news.py
eval "$(/opt/homebrew/bin/brew shellenv)"

set -a
source /Users/kevinkolb/Code/Giles/.env
set +a

exec /opt/homebrew/bin/python3 /Users/kevinkolb/Code/Giles/scripts/morning_news.py "$@"
