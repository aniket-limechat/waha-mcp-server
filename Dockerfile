# ── Stage 1: Build MCP server TypeScript ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /mcp
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Stage 2: WAHA base + MCP server ───────────────────────────────────────
# Uses devlikeapro/waha as the base — WAHA runs on :3000,
# our MCP server runs on :${PORT} (Railway injects this).
FROM devlikeapro/waha

# Copy compiled MCP server and its production node_modules
COPY --from=builder /mcp/dist /mcp/dist
COPY --from=builder /mcp/node_modules /mcp/node_modules

# Startup script that launches both processes
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
