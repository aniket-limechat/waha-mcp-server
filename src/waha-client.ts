import axios, { AxiosInstance, AxiosError } from "axios";

export interface WahaSession {
  name: string;
  status: string;
  config?: Record<string, unknown>;
}

export interface WahaMessage {
  id: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  body: string;
  hasMedia: boolean;
  ack?: number;
}

export interface WahaChat {
  id: string;
  name: string;
  isGroup: boolean;
  timestamp: number;
  unreadCount: number;
  lastMessage?: WahaMessage;
}

export interface WahaContact {
  id: string;
  name: string;
  pushname?: string;
  isGroup: boolean;
  isMyContact: boolean;
  number: string;
}

export interface SendTextPayload {
  session: string;
  chatId: string;
  text: string;
  reply_to?: string;
}

export interface SendImagePayload {
  session: string;
  chatId: string;
  caption?: string;
  file: { url: string } | { mimetype: string; data: string };
}

export interface SendFilePayload {
  session: string;
  chatId: string;
  caption?: string;
  file: { url: string } | { mimetype: string; filename: string; data: string };
}

// ── Error helpers ──────────────────────────────────────────────────────────

function friendlyError(err: unknown, context: string): Error {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const url = err.config?.url ?? "";

    if (status === 401 || status === 403) {
      return new Error(
        `[WAHA auth failed] ${context}: HTTP ${status} from ${url}. ` +
          `Check that WAHA_API_KEY in this service matches WHATSAPP_API_KEY set on the WAHA service.`
      );
    }
    if (status === 404) {
      return new Error(
        `[WAHA not found] ${context}: HTTP 404 from ${url}. ` +
          `Check WAHA_BASE_URL — for Railway internal networking use http://waha.railway.internal:3000`
      );
    }
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      return new Error(
        `[WAHA unreachable] ${context}: Cannot connect to WAHA at ${err.config?.baseURL ?? "unknown"}. ` +
          `Check WAHA_BASE_URL and ensure the WAHA service is running.`
      );
    }
    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
      return new Error(
        `[WAHA timeout] ${context}: Request timed out. WAHA may be starting up — retry in a few seconds.`
      );
    }

    const body = JSON.stringify(err.response?.data ?? {});
    return new Error(
      `[WAHA error] ${context}: HTTP ${status ?? "unknown"} — ${body}`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ── Client ──────────────────────────────────────────────────────────────────

export class WahaClient {
  private http: AxiosInstance;
  readonly baseUrl: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-Api-Key": apiKey } : {}),
      },
      timeout: 30_000,
    });
  }

  /** Ping WAHA and return true if reachable and authenticated. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.http.get("/api/version");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err, "ping").message };
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(): Promise<WahaSession[]> {
    try {
      const res = await this.http.get("/api/sessions");
      return res.data;
    } catch (err) {
      throw friendlyError(err, "listSessions");
    }
  }

  async getSession(session = "default"): Promise<WahaSession> {
    try {
      const res = await this.http.get(`/api/sessions/${session}`);
      return res.data;
    } catch (err) {
      throw friendlyError(err, `getSession(${session})`);
    }
  }

  async startSession(session = "default"): Promise<WahaSession> {
    try {
      const res = await this.http.post("/api/sessions/start", { name: session });
      return res.data;
    } catch (err) {
      throw friendlyError(err, `startSession(${session})`);
    }
  }

  async stopSession(session = "default"): Promise<void> {
    try {
      await this.http.post("/api/sessions/stop", { name: session });
    } catch (err) {
      throw friendlyError(err, `stopSession(${session})`);
    }
  }

  async getQR(session = "default"): Promise<{ imageBase64: string }> {
    try {
      const res = await this.http.get(`/api/${session}/auth/qr`);
      return res.data;
    } catch (err) {
      throw friendlyError(err, `getQR(${session})`);
    }
  }

  /** Fetch QR as raw PNG buffer — works regardless of whether WAHA returns
   *  JSON {imageBase64} or a raw image/png response. */
  async getQRRaw(session = "default"): Promise<Buffer> {
    try {
      const res = await this.http.get(`/api/${session}/auth/qr`, {
        params: { format: "image" },
        responseType: "arraybuffer",
      });
      return Buffer.from(res.data);
    } catch (err) {
      throw friendlyError(err, `getQRRaw(${session})`);
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async sendText(payload: SendTextPayload): Promise<WahaMessage> {
    try {
      const res = await this.http.post("/api/sendText", payload);
      return res.data;
    } catch (err) {
      throw friendlyError(err, `sendText to ${payload.chatId}`);
    }
  }

  async sendImage(payload: SendImagePayload): Promise<WahaMessage> {
    try {
      const res = await this.http.post("/api/sendImage", payload);
      return res.data;
    } catch (err) {
      throw friendlyError(err, `sendImage to ${payload.chatId}`);
    }
  }

  async sendFile(payload: SendFilePayload): Promise<WahaMessage> {
    try {
      const res = await this.http.post("/api/sendFile", payload);
      return res.data;
    } catch (err) {
      throw friendlyError(err, `sendFile to ${payload.chatId}`);
    }
  }

  async sendSeen(session: string, chatId: string, messageId: string): Promise<void> {
    try {
      await this.http.post("/api/sendSeen", { session, chatId, messageId });
    } catch (err) {
      throw friendlyError(err, `sendSeen(${chatId}, ${messageId})`);
    }
  }

  async getMessages(session: string, chatId: string, limit = 20): Promise<WahaMessage[]> {
    try {
      const res = await this.http.get(`/api/messages`, {
        params: { session, chatId, limit },
      });
      return res.data;
    } catch (err) {
      throw friendlyError(err, `getMessages(${chatId})`);
    }
  }

  // ── Chats ─────────────────────────────────────────────────────────────────

  async getChats(session = "default", limit = 20): Promise<WahaChat[]> {
    try {
      const res = await this.http.get("/api/chats", {
        params: { session, limit },
      });
      return res.data;
    } catch (err) {
      throw friendlyError(err, "getChats");
    }
  }

  async getChat(session: string, chatId: string): Promise<WahaChat> {
    try {
      const res = await this.http.get(`/api/chats/${chatId}`, {
        params: { session },
      });
      return res.data;
    } catch (err) {
      throw friendlyError(err, `getChat(${chatId})`);
    }
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async getContacts(session = "default"): Promise<WahaContact[]> {
    try {
      const res = await this.http.get("/api/contacts", { params: { session } });
      return res.data;
    } catch (err) {
      throw friendlyError(err, "getContacts");
    }
  }

  async checkNumberStatus(
    session: string,
    phone: string
  ): Promise<{ numberExists: boolean; chatId?: string }> {
    try {
      const res = await this.http.get("/api/contacts/check-exists", {
        params: { session, phone },
      });
      return res.data;
    } catch (err) {
      throw friendlyError(err, `checkNumberStatus(${phone})`);
    }
  }

  // ── Presence ──────────────────────────────────────────────────────────────

  async setPresence(
    session: string,
    presence: "online" | "offline",
    chatId?: string
  ): Promise<void> {
    try {
      await this.http.post("/api/presence", { session, presence, chatId });
    } catch (err) {
      throw friendlyError(err, `setPresence(${presence})`);
    }
  }
}
