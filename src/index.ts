import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { WahaClient } from "./waha-client.js";
import { registerTools } from "./tools.js";

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const MCP_API_KEY = process.env.MCP_API_KEY;
const WAHA_BASE_URL = process.env.WAHA_BASE_URL ?? "http://localhost:3000";
const WAHA_API_KEY = process.env.WAHA_API_KEY;

if (!MCP_API_KEY) {
  console.warn(
    "[warn] MCP_API_KEY is not set — server is unauthenticated. Set it in production!"
  );
}

// ── WAHA client (shared, stateless) ────────────────────────────────────────

const waha = new WahaClient(WAHA_BASE_URL, WAHA_API_KEY);

// ── Session store for stateful MCP connections ─────────────────────────────
// Keeps transports alive across requests from the same MCP client session

const transports = new Map<string, StreamableHTTPServerTransport>();

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check — Railway uses this
app.get("/health", (_req, res) => {
  res.json({ status: "ok", waha: WAHA_BASE_URL });
});

// QR helper — one-time setup, requires MCP_API_KEY (or admin key)
app.get("/setup/qr", requireAdminKey, async (req, res) => {
  try {
    const session = (req.query.session as string) ?? "default";
    const qr = await waha.getQR(session);
    // Return HTML page with embedded QR so you can open in browser
    res.send(`
      <html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;color:white;">
          <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
          <p>Session: <code>${session}</code></p>
          <img src="${qr.imageBase64 ?? `data:image/png;base64,${qr}`}" style="width:300px;height:300px;" />
          <p><small>Refresh if expired</small></p>
        </div>
      </body></html>
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Auth middleware ─────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (MCP_API_KEY && req.headers["x-api-key"] !== MCP_API_KEY) {
    res.status(401).json({ error: "Unauthorized — provide x-api-key header" });
    return;
  }
  next();
}

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] ?? req.query["key"];
  if (MCP_API_KEY && key !== MCP_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── MCP endpoint (Streamable HTTP — 2025-03-26 spec) ───────────────────────

app.post("/mcp", requireApiKey, async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Reuse existing transport for known sessions
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ error: "Expected initialize request for new session" });
      return;
    }

    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });

    // Clean up when the session ends
    transport.onclose = () => {
      transports.delete(newSessionId);
    };

    const server = new McpServer({
      name: "waha-whatsapp",
      version: "1.0.0",
    });

    registerTools(server, waha);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mcp] error:", msg);
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  }
});

// Handle GET/DELETE for session management (SSE streaming + session termination)
app.get("/mcp", requireApiKey, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing mcp-session-id" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireApiKey, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing mcp-session-id" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
  transports.delete(sessionId);
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[waha-mcp] listening on :${PORT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  QR setup     : http://localhost:${PORT}/setup/qr`);
  console.log(`  Health       : http://localhost:${PORT}/health`);
  console.log(`  WAHA backend : ${WAHA_BASE_URL}`);
  console.log(`  Auth         : ${MCP_API_KEY ? "enabled" : "DISABLED"}`);
});
