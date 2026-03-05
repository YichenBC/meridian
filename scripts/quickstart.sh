#!/usr/bin/env bash
set -euo pipefail

echo "=== Meridian Quick Start ==="
echo

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (v20+). Install from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found v$(node -v))"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Check Claude CLI (optional)
if command -v claude &>/dev/null; then
  echo "✓ Claude Code CLI found"
else
  echo "⚠ Claude Code CLI not found (optional — needed for code tasks)"
fi

# Install dependencies
echo
echo "Installing dependencies..."
npm install

# Create config if missing
if [ ! -f meridian.json ]; then
  echo
  echo "Creating meridian.json from template..."
  cp meridian.example.json meridian.json
  echo
  echo "⚠ IMPORTANT: Edit meridian.json and add your API key:"
  echo "  vi meridian.json"
  echo
  echo "  Required: provider.apiKey"
  echo "  Optional: telegram.botToken, telegram.chatId, proxy"
  echo
  exit 0
fi

echo "✓ meridian.json found"

# Build
echo
echo "Building..."
npm run build

# Run
echo
echo "Starting Meridian..."
echo "  CLI:       Type in this terminal"
echo "  Dashboard: http://localhost:3333"
echo "  API:       POST http://localhost:3333/api/tasks"
echo
npm start
