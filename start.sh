#!/bin/bash
set -e

# ── Port strategy ───────────────────────────────────────────────────────────
#
# Railway's serviceDomains config shows port:8080, so Railway routes external
# traffic to container:8080. We hard-code MCP on 8080 and WAHA on 3001.
#
# We CANNOT rely on $PORT env var because:
#   (a) WAHA's NestJS uses PORT internally; if $PORT=3000 WAHA and MCP compete.
#   (b) WAHA might use WAHA_PORT (not PORT) and ignore our PORT=3000 override.
#
# Solution: hard-code both ports so they are always separate.
#
MCP_PORT=8080   # Railway routes serviceDomains port:8080 here
WAHA_PORT=3001  # WAHA internal-only port (never exposed)

# ── Bridge env vars ─────────────────────────────────────────────────────────
export WHATSAPP_API_KEY="${WHATSAPP_API_KEY:-$WAHA_API_KEY}"
export WAHA_BASE_URL="http://localhost:${WAHA_PORT}"

echo "[start] PORT env from Railway : ${PORT:-<unset>}"
echo "[start] MCP_PORT (hard-coded) : $MCP_PORT"
echo "[start] WAHA_PORT (hard-coded): $WAHA_PORT"
echo "[start] WAHA_BASE_URL         : $WAHA_BASE_URL"
echo "[start] MCP_API_KEY           : ${MCP_API_KEY:+set}${MCP_API_KEY:-MISSING}"

# ── Graceful shutdown ───────────────────────────────────────────────────────
cleanup() {
  echo "[start] Shutting down MCP server (pid ${MCP_PID:-?}) and WAHA (pid ${WAHA_PID:-?})..."
  kill "${MCP_PID:-0}" "${WAHA_PID:-0}" 2>/dev/null || true
  wait "${MCP_PID:-0}" "${WAHA_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# ── Start MCP server FIRST on hard-coded port 8080 ─────────────────────────
echo "[start] Starting MCP server on :${MCP_PORT}..."
PORT=${MCP_PORT} node /mcp/dist/index.js 2>&1 &
MCP_PID=$!
echo "[start] MCP server PID=$MCP_PID"

# Give MCP a moment to bind before WAHA starts
sleep 2

# ── Start WAHA on hard-coded port 3001 ─────────────────────────────────────
cd /app
if [ -f dist/index.js ]; then
  WAHA_ENTRY="dist/index.js"
else
  WAHA_ENTRY="dist/main.js"
fi
echo "[start] Starting WAHA ($WAHA_ENTRY) on :${WAHA_PORT}..."
# Set BOTH PORT and WAHA_PORT so WAHA uses 3001 regardless of which env var it reads
PORT=${WAHA_PORT} WAHA_PORT=${WAHA_PORT} node "$WAHA_ENTRY" 2>&1 &
WAHA_PID=$!
echo "[start] WAHA PID=$WAHA_PID"

# ── Wait — container exits when either process dies ─────────────────────────
wait "${MCP_PID}" "${WAHA_PID}"
