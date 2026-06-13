import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { WahaClient } from "./waha-client.js";
import { registerTools } from "./tools.js";

// ── Env validation — fail fast with clear errors ───────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[fatal] Missing required environment variable: ${name}`);
    console.error(`        Set it in Railway → Service → Variables`);
    process.exit(1);
  }
  return val;
}

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const MCP_API_KEY = requireEnv("MCP_API_KEY");
const WAHA_BASE_URL = requireEnv("WAHA_BASE_URL");
const WAHA_API_KEY = requireEnv("WAHA_API_KEY");
const WAHA_DEFAULT_SESSION = process.env.WAHA_DEFAULT_SESSION ?? "default";

// ── WAHA client ─────────────────────────────────────────────────────────────

const waha = new WahaClient(WAHA_BASE_URL, WAHA_API_KEY);

// ── Session store for stateful MCP connections ─────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Auth middleware ─────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-api-key"] !== MCP_API_KEY) {
    res.status(401).json({
      error: "Unauthorized",
      hint: "Provide your MCP_API_KEY in the x-api-key request header",
    });
    return;
  }
  next();
}

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] ?? req.query["key"];
  if (key !== MCP_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  // Always return 200 — Railway uses this to determine if the MCP server
  // process is healthy, not whether WAHA is reachable. WAHA connectivity
  // is reported in the body for observability but never blocks deployment.
  const wahaStatus = await waha.ping();
  res.status(200).json({
    status: wahaStatus.ok ? "ok" : "degraded",
    waha: {
      url: WAHA_BASE_URL,
      reachable: wahaStatus.ok,
      ...(wahaStatus.error ? { error: wahaStatus.error } : {}),
    },
    sessions: transports.size,
  });
});

// ── QR setup endpoint ───────────────────────────────────────────────────────
// Open in browser after deploy to scan WhatsApp QR

app.get("/setup/qr", requireAdminKey, async (req, res) => {
  const session = (req.query.session as string) ?? WAHA_DEFAULT_SESSION;
  try {
    // Ensure session is started before asking for QR
    const sessions = await waha.listSessions();
    const existing = sessions.find((s) => s.name === session);
    if (!existing) {
      console.log(`[setup] Starting session '${session}' for QR…`);
      await waha.startSession(session);
      // Give WAHA a moment to initialise
      await new Promise((r) => setTimeout(r, 2000));
    }

    const qr = await waha.getQR(session);
    const imgSrc =
      typeof qr.imageBase64 === "string"
        ? qr.imageBase64.startsWith("data:")
          ? qr.imageBase64
          : `data:image/png;base64,${qr.imageBase64}`
        : String(qr);

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>WAHA QR — ${session}</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body { background:#0f172a; display:flex; align-items:center; justify-content:center;
           height:100vh; margin:0; font-family:system-ui,sans-serif; color:#e2e8f0; }
    .card { text-align:center; background:#1e293b; padding:2rem; border-radius:1rem; max-width:380px; }
    h2 { margin:0 0 0.5rem; font-size:1.25rem; }
    p  { margin:0.5rem 0; color:#94a3b8; font-size:0.875rem; }
    img { width:280px; height:280px; display:block; margin:1.25rem auto;
          border-radius:0.5rem; background:#fff; padding:8px; }
    code { background:#0f172a; padding:0.2rem 0.5rem; border-radius:0.25rem;
           font-size:0.8rem; color:#38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Scan with WhatsApp</h2>
    <p>Settings → Linked Devices → Link a Device</p>
    <img src="${imgSrc}" alt="QR code"/>
    <p>Session: <code>${session}</code></p>
    <p>Page auto-refreshes every 15s if QR expires</p>
  </div>
</body>
</html>`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[setup/qr] error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── Session status endpoint ─────────────────────────────────────────────────

app.get("/setup/status", requireAdminKey, async (_req, res) => {
  try {
    const sessions = await waha.listSessions();
    res.json({ sessions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── MCP endpoint (Streamable HTTP — 2025-03-26 spec) ───────────────────────

app.post("/mcp", requireApiKey, async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

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

app.get("/mcp", requireApiKey, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing mcp-session-id" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
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

// ── Startup: verify WAHA connectivity + auto-start session ─────────────────

async function startupChecks(): Promise<void> {
  console.log("[startup] Checking WAHA connectivity…");

  // Retry up to 10 times (Railway services may start in parallel)
  let attempt = 0;
  while (attempt < 10) {
    const { ok, error } = await waha.ping();
    if (ok) {
      console.log("[startup] WAHA reachable ✓");
      break;
    }
    attempt++;
    console.warn(`[startup] WAHA not ready (attempt ${attempt}/10): ${error}`);
    if (attempt === 10) {
      console.error(
        "[startup] Could not reach WAHA after 10 attempts.\n" +
          "          → Is WAHA_BASE_URL correct? On Railway use: http://waha.railway.internal:3000\n" +
          "          → Is the WAHA service running in the same project?\n" +
          "          Server will continue but WhatsApp tools will fail until WAHA is reachable."
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Auto-start the default session if it doesn't exist yet
  try {
    const sessions = await waha.listSessions();
    const existing = sessions.find((s) => s.name === WAHA_DEFAULT_SESSION);

    if (!existing) {
      console.log(`[startup] Starting default session '${WAHA_DEFAULT_SESSION}'…`);
      await waha.startSession(WAHA_DEFAULT_SESSION);
      console.log(
        `[startup] Session started. If this is a fresh WhatsApp link, scan QR at:\n` +
          `          GET /setup/qr?key=<MCP_API_KEY>`
      );
    } else {
      console.log(
        `[startup] Session '${WAHA_DEFAULT_SESSION}' status: ${existing.status}`
      );
      if (existing.status === "SCAN_QR_CODE") {
        console.log(
          `[startup] ⚠ WhatsApp not authenticated — scan QR at: GET /setup/qr?key=<MCP_API_KEY>`
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[startup] Session auto-start failed:", msg);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n[waha-mcp] Server started on :${PORT}`);
  console.log(`  MCP endpoint : POST /mcp  (x-api-key: <MCP_API_KEY>)`);
  console.log(`  QR setup     : GET  /setup/qr?key=<MCP_API_KEY>`);
  console.log(`  Session info : GET  /setup/status?key=<MCP_API_KEY>`);
  console.log(`  Health       : GET  /health`);
  console.log(`  WAHA backend : ${WAHA_BASE_URL}\n`);

  await startupChecks();
});
