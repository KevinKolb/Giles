#!/bin/zsh
eval "$(/opt/homebrew/bin/brew shellenv)"
cd "$(dirname "$0")"

# Kill any existing GILES server
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# Start Ollama if not already running
if ! pgrep -x ollama > /dev/null; then
  echo "Starting Ollama..."
  ollama serve &
  sleep 2
fi

npm install --silent

# Open browser after server has had time to start
(sleep 3 && open http://localhost:3000) &

npm start
