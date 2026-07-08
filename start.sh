#!/bin/bash
# Render startup wrapper - captures all output and POSTs to webhook for debugging
exec > >(tee /tmp/boot.log) 2>&1

WH="7ed9fb05-3152-4574-9471-939474082365"

echo "=== BOOT START $(date -u) ==="
echo "Node: $(node --version)"
echo "PWD: $(pwd)"
echo "PORT: $PORT"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo yes || echo no)"
echo "RESEND_API_KEY set: $([ -n "$RESEND_API_KEY" ] && echo yes || echo no)"
echo "--- listing dist ---"
ls -la dist/ 2>&1 || echo "NO dist"
echo "--- attempting server start ---"

# Run server in background, give it 3 sec to crash if it will
node dist/server.js 2>&1 &
SERVER_PID=$!
echo "server pid: $SERVER_PID"

sleep 4
echo "--- after 4s, process status ---"
if kill -0 $SERVER_PID 2>/dev/null; then
  echo "STILL ALIVE"
else
  echo "PROCESS DEAD - it crashed"
fi

# POST logs to webhook
LOGS=$(cat /tmp/boot.log 2>&1 | head -c 8000)
curl -s -X POST "https://webhook.site/$WH" \
  -H "Content-Type: text/plain" \
  --data-binary "$LOGS" > /dev/null 2>&1
echo "--- posted logs to webhook ---"

# Wait for server (or it to die) before exiting container
wait $SERVER_PID