#!/bin/bash
set -e
echo "=== OSUEP API startup ==="
echo "Node: $(node --version)"
echo "NPM:  $(npm --version)"
echo "PWD:  $(pwd)"
echo "ENV:  NODE_ENV=$NODE_ENV PORT=$PORT"
echo "Files: $(ls dist/server.js 2>&1)"
echo "=== Starting server ==="
exec node dist/server.js
