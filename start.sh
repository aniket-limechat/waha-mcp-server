#!/bin/bash
set -e

# ── Diagnostics — print env so we can debug port issues in Railway logs ───────
echo "[start] === waha-mcp-server starting ==="
echo "[start] PORT=${PORT:-<unset>}  (Railway injects this; MCP will serve on it)"
echo "[start] MCP_API_KEY=${MCP_API_KEY:+set}${MCP_API_KEY:-MISSING}"
echo "[start] WAHA_API_KEY=${WAHA_API_KEY:+set}${WAHA_API_KEY:-MISSING}"
echo "[start] WAHA_BASE_URL will be http://localhost:3000 (hardcoded)"

# ── Bridge env vars ─────────────────────────────────────────────────────────
# WAHA expects WHATSAPP_API_KEY; we expose WAHA_API_KEY to keep things simple.
export WHATSAPP_API_KEY="${WHATSAPP_API_KEY:-$WAHA_API_KEY}"

# MCP server connects to WAHA on localhost (same container)
export WAHA_BASE_URL="http://localhost:3000"

# ── Graceful shutdown ───────────────────────────────────────────────────────
cleanup() {
  echo "[start] Shutting down MCP server (pid $MCP_PID) and WAHA (pid $WAHA_PID)..."
  kill "$MCP_PID" "$WAHA_PID" 2>/dev/null || true
  wait "$MCP_PID" "$WAHA_PID" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# ── Start MCP server FIRST — must grab Railway's $PORT before WAHA ──────────
# WAHA is pinned to port 3000 below. Starting MCP first ensures it owns $PORT
# (Railway's public-facing port) even if there is any timing race.
echo "[start] Starting MCP server on :${PORT:-8080}..."
# Merge stderr into stdout so Railway captures crash messages
node /mcp/dist/index.js 2>&1 &
MCP_PID=$!
echo "[start] MCP server PID=$MCP_PID"

# Give MCP a moment to bind before WAHA tries to start
sleep 1

# ── Start WAHA on a fixed internal port ────────────────────────────────────
# Pin WAHA to port 3000 so it never competes with the MCP server for $PORT.
# The free devlikeapro/waha image uses dist/index.js; waha-plus uses dist/main.js.
cd /app
if [ -f dist/index.js ]; then
  WAHA_ENTRY="dist/index.js"
else
  WAHA_ENTRY="dist/main.js"
fi
echo "[start] Starting WAHA ($WAHA_ENTRY) on :3000..."
PORT=3000 node "$WAHA_ENTRY" 2>&1 &
WAHA_PID=$!
echo "[start] WAHA PID=$WAHA_PID"

# ── Monitor: log if either process dies unexpectedly ───────────────────────
monitor() {
  wait "$MCP_PID"
  echo "[start] ⚠ MCP server (PID $MCP_PID) exited — container will keep running until WAHA exits"
}
monitor &

# ── Wait — exit if WAHA dies (that is the primary failure signal) ───────────
wait "$WAHA_PID" "$MCP_PID"
