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
const WAHA_API_KEY = requireEnv("WAHA_API_KEY");
// In single-container mode start.sh sets WAHA_BASE_URL=http://localhost:3001
const WAHA_BASE_URL = process.env.WAHA_BASE_URL ?? "http://localhost:3001";
const WAHA_DEFAULT_SESSION = process.env.WAHA_DEFAULT_SESSION ?? "default";

// ── WAHA client ─────────────────────────────────────────────────────────────

const waha = new WahaClient(WAHA_BASE_URL, WAHA_API_KEY);

// ── Session store for stateful MCP connections ─────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Request logger — logs EVERY incoming request so we can see Railway health
//    checks and Hikari proxy hits in Railway logs ──────────────────────────
app.use((req, _res, next) => {
  const xff = req.headers["x-forwarded-for"] ?? "-";
  const key = req.headers["x-api-key"] ? "key:present" : "no-key";
  process.stdout.write(
    `[http] ${req.method} ${req.path} (${key}, xff=${xff}, ip=${req.ip})\n`
  );
  next();
});

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

// ── QR raw PNG proxy ────────────────────────────────────────────────────────
// Returns raw PNG bytes — used as <img src> by the /setup/qr page

app.get("/setup/qr.png", requireAdminKey, async (req, res) => {
  const session = (req.query.session as string) ?? WAHA_DEFAULT_SESSION;
  try {
    const pngBuf = await waha.getQRRaw(session);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(pngBuf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[setup/qr.png] error:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── QR setup endpoint ───────────────────────────────────────────────────────
// Open in browser after deploy to scan WhatsApp QR

app.get("/setup/qr", requireAdminKey, async (req, res) => {
  const session = (req.query.session as string) ?? WAHA_DEFAULT_SESSION;
  const key = (req.headers["x-api-key"] ?? req.query["key"]) as string;
  try {
    // Ensure session is started before asking for QR
    const sessions = await waha.listSessions();
    const existing = sessions.find((s) => s.name === session);
    if (!existing) {
      console.log(`[setup] Starting session '${session}' for QR…`);
      await waha.startSession(session);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Image loaded via separate /setup/qr.png route (avoids binary-in-HTML encoding issues)
    const imgSrc = `/setup/qr.png?key=${encodeURIComponent(key)}&session=${encodeURIComponent(session)}&_t=${Date.now()}`;

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>WAHA QR — ${session}</title>
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
    button { margin-top:1rem; padding:0.5rem 1.25rem; background:#38bdf8; color:#0f172a;
             border:none; border-radius:0.5rem; font-size:0.9rem; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Scan with WhatsApp</h2>
    <p>Settings → Linked Devices → Link a Device</p>
    <img id="qr" src="${imgSrc}" alt="QR code"/>
    <p>Session: <code>${session}</code></p>
    <p id="ts">Loaded at ${new Date().toISOString()}</p>
    <button onclick="refresh()">Refresh QR</button>
  </div>
  <script>
    function refresh() {
      const img = document.getElementById('qr');
      img.src = '/setup/qr.png?key=${encodeURIComponent(key)}&session=${encodeURIComponent(session)}&_t=' + Date.now();
      document.getElementById('ts').textContent = 'Refreshed at ' + new Date().toISOString();
    }
    setInterval(refresh, 20000);
  </script>
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

// ── Session restart endpoint ────────────────────────────────────────────────
// POST /setup/restart?key=<MCP_API_KEY>&session=default
// Stops + deletes + restarts the session so NOWEB engine kicks in cleanly.

app.post("/setup/restart", requireAdminKey, async (req, res) => {
  const session = (req.query.session as string) ?? WAHA_DEFAULT_SESSION;
  try {
    console.log(`[setup/restart] Hard-restarting session '${session}' with NOWEB engine...`);
    // Stop first (ignore errors)
    try { await waha.stopSession(session); } catch (_) { /* ok */ }
    await new Promise((r) => setTimeout(r, 1000));
    // Hard-delete so old WEBJS auth state is wiped from disk
    try { await waha.deleteSession(session); } catch (_) { /* ok if not found */ }
    await new Promise((r) => setTimeout(r, 2000));
    // Start fresh — now also passes engine:"NOWEB" explicitly in the payload
    const started = await waha.startSession(session);
    console.log(`[setup/restart] Session '${session}' restarted with NOWEB:`, started.status);
    res.json({ ok: true, session, status: started.status, engine: "NOWEB" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[setup/restart] error:", msg);
    res.status(500).json({ error: msg });
  }
});


// ── Debug endpoint — proxies WAHA version + session detail ─────────────────
// Lets us verify which engine is active without Railway logs.

app.get("/setup/debug", requireAdminKey, async (_req, res) => {
  try {
    const [version, sessions] = await Promise.all([
      waha.getVersion(),
      waha.listSessions(),
    ]);
    res.json({ version, sessions });
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

// ── Global crash handlers — make crashes visible in Railway logs ──────────────

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

// ── Boot ─────────────────────────────────────────────────────────────────────

// Bind to 0.0.0.0 — Railway's recommended binding for container services.
// Railway containers have IPv6 egress disabled; binding to :: can produce a socket
// that only responds on loopback when IPv6 is not fully configured in the network
// namespace, causing ECONNREFUSED from Hikari proxy despite localhost 200.
const httpServer = app.listen(PORT, "0.0.0.0", async () => {
  // Flush synchronously so Railway captures this even if we crash right after
  process.stdout.write(`\n[waha-mcp] Server started on 0.0.0.0:${PORT}\n`);
  process.stdout.write(`  MCP endpoint : POST /mcp  (x-api-key: <MCP_API_KEY>)\n`);
  process.stdout.write(`  QR setup     : GET  /setup/qr?key=<MCP_API_KEY>\n`);
  process.stdout.write(`  Session info : GET  /setup/status?key=<MCP_API_KEY>\n`);
  process.stdout.write(`  Health       : GET  /health\n`);
  process.stdout.write(`  WAHA backend : ${WAHA_BASE_URL}\n`);
  process.stdout.write(`  Bound on     : 0.0.0.0:${PORT}\n\n`);

  await startupChecks();
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[fatal] Cannot bind to port ${PORT}:`, err.code, err.message);
  process.exit(1);
});
