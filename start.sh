#!/bin/bash
set -e

# ── Bridge env vars ─────────────────────────────────────────────────────────
# WAHA expects WHATSAPP_API_KEY; we expose WAHA_API_KEY to keep things simple.
# In single-container mode these are the same secret.
export WHATSAPP_API_KEY="${WHATSAPP_API_KEY:-$WAHA_API_KEY}"

# MCP server connects to WAHA on localhost (same container)
export WAHA_BASE_URL="http://localhost:3000"

# ── Graceful shutdown ───────────────────────────────────────────────────────
cleanup() {
  echo "[start] Shutting down WAHA (pid $WAHA_PID) and MCP server (pid $MCP_PID)..."
  kill "$WAHA_PID" "$MCP_PID" 2>/dev/null || true
  wait "$WAHA_PID" "$MCP_PID" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# ── Start WAHA ──────────────────────────────────────────────────────────────
# The free devlikeapro/waha image uses dist/index.js as the entrypoint.
# (waha-plus uses dist/main.js — detect which exists to be safe)
cd /app
if [ -f dist/index.js ]; then
  WAHA_ENTRY="dist/index.js"
else
  WAHA_ENTRY="dist/main.js"
fi
echo "[start] Starting WAHA ($WAHA_ENTRY) on :3000..."
node "$WAHA_ENTRY" &
WAHA_PID=$!

# ── Start MCP server ────────────────────────────────────────────────────────
echo "[start] Starting MCP server on :${PORT:-8080}..."
node /mcp/dist/index.js &
MCP_PID=$!

# ── Wait — exit if either process dies ─────────────────────────────────────
wait "$WAHA_PID" "$MCP_PID"
