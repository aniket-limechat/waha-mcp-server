#!/bin/bash
# ── Port strategy ───────────────────────────────────────────────────────────
#
# Railway routes external traffic to container:8080 (confirmed via serviceDomains).
# MCP server (Express) runs in FOREGROUND on :8080.
# WAHA runs in BACKGROUND on :3001 (internal only).
#
# MCP in foreground = its stdout/stderr go directly to container stdout
# so Railway always captures crash messages. When MCP exits, bash exits
# too (cleanup kills WAHA), Railway restarts the container.
#
MCP_PORT=8080
WAHA_PORT=3001

# ── Bridge env vars ─────────────────────────────────────────────────────────
export WHATSAPP_API_KEY="${WHATSAPP_API_KEY:-$WAHA_API_KEY}"
export WAHA_BASE_URL="http://localhost:${WAHA_PORT}"

# ── Graceful shutdown (kills WAHA when MCP exits) ──────────────────────────
cleanup() {
  echo "[start] MCP exited — killing WAHA (pid ${WAHA_PID:-?})..."
  kill "${WAHA_PID:-0}" 2>/dev/null || true
  wait "${WAHA_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# ── Brief pause so Railway log capture is ready before we print anything ───
sleep 5

echo "[start] ============================================"
echo "[start] Railway PORT=${PORT:-<unset>}"
echo "[start] MCP_PORT=${MCP_PORT}  WAHA_PORT=${WAHA_PORT}"
echo "[start] MCP_API_KEY=${MCP_API_KEY:+set}${MCP_API_KEY:-MISSING}"
echo "[start] WAHA_API_KEY=${WAHA_API_KEY:+set}${WAHA_API_KEY:-MISSING}"
echo "[start] Node: $(node --version 2>&1)"
echo "[start] MCP dist: $(ls /mcp/dist/index.js 2>/dev/null && echo 'found' || echo 'MISSING')"
echo "[start] ============================================"

# ── Start WAHA in background on :3001 ──────────────────────────────────────
cd /app
if [ -f dist/index.js ]; then
  WAHA_ENTRY="dist/index.js"
else
  WAHA_ENTRY="dist/main.js"
fi
echo "[start] Starting WAHA (${WAHA_ENTRY}) on :${WAHA_PORT}..."
PORT=${WAHA_PORT} WAHA_PORT=${WAHA_PORT} node "$WAHA_ENTRY" &
WAHA_PID=$!
echo "[start] WAHA PID=${WAHA_PID}"

# ── Start MCP in FOREGROUND on :8080 ───────────────────────────────────────
# Running in foreground means all MCP output goes to container stdout and
# is always visible in Railway logs. If MCP crashes, cleanup kills WAHA.
echo "[start] Starting MCP server on :${MCP_PORT} (foreground)..."
PORT=${MCP_PORT} node /mcp/dist/index.js

# If node exits (MCP crashed or stopped), cleanup trap fires automatically.
