import axios, { AxiosInstance } from "axios";

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

export class WahaClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey?: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-Api-Key": apiKey } : {}),
      },
      timeout: 30_000,
    });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(): Promise<WahaSession[]> {
    const res = await this.http.get("/api/sessions");
    return res.data;
  }

  async getSession(session = "default"): Promise<WahaSession> {
    const res = await this.http.get(`/api/sessions/${session}`);
    return res.data;
  }

  async startSession(session = "default"): Promise<WahaSession> {
    const res = await this.http.post("/api/sessions/start", { name: session });
    return res.data;
  }

  async stopSession(session = "default"): Promise<void> {
    await this.http.post("/api/sessions/stop", { name: session });
  }

  async getQR(session = "default"): Promise<{ imageBase64: string }> {
    const res = await this.http.get(`/api/${session}/auth/qr`);
    return res.data;
  }

  async getScreenshot(session = "default"): Promise<string> {
    const res = await this.http.get(`/api/screenshot`, {
      params: { session },
    });
    return res.data;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async sendText(payload: SendTextPayload): Promise<WahaMessage> {
    const res = await this.http.post("/api/sendText", payload);
    return res.data;
  }

  async sendImage(payload: SendImagePayload): Promise<WahaMessage> {
    const res = await this.http.post("/api/sendImage", payload);
    return res.data;
  }

  async sendFile(payload: SendFilePayload): Promise<WahaMessage> {
    const res = await this.http.post("/api/sendFile", payload);
    return res.data;
  }

  async sendSeen(session: string, chatId: string, messageId: string): Promise<void> {
    await this.http.post("/api/sendSeen", { session, chatId, messageId });
  }

  async getMessages(
    session: string,
    chatId: string,
    limit = 20
  ): Promise<WahaMessage[]> {
    const res = await this.http.get(`/api/messages`, {
      params: { session, chatId, limit },
    });
    return res.data;
  }

  // ── Chats ─────────────────────────────────────────────────────────────────

  async getChats(session = "default", limit = 20): Promise<WahaChat[]> {
    const res = await this.http.get("/api/chats", {
      params: { session, limit },
    });
    return res.data;
  }

  async getChat(session: string, chatId: string): Promise<WahaChat> {
    const res = await this.http.get(`/api/chats/${chatId}`, {
      params: { session },
    });
    return res.data;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async getContacts(session = "default"): Promise<WahaContact[]> {
    const res = await this.http.get("/api/contacts", { params: { session } });
    return res.data;
  }

  async getContact(session: string, contactId: string): Promise<WahaContact> {
    const res = await this.http.get("/api/contacts/check-exists", {
      params: { session, phone: contactId },
    });
    return res.data;
  }

  async checkNumberStatus(
    session: string,
    phone: string
  ): Promise<{ numberExists: boolean; chatId?: string }> {
    const res = await this.http.get("/api/contacts/check-exists", {
      params: { session, phone },
    });
    return res.data;
  }

  // ── Presence ──────────────────────────────────────────────────────────────

  async setPresence(
    session: string,
    presence: "online" | "offline",
    chatId?: string
  ): Promise<void> {
    await this.http.post("/api/presence", { session, presence, chatId });
  }
}
