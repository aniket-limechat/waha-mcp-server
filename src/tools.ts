import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WahaClient } from "./waha-client.js";

export function registerTools(server: McpServer, waha: WahaClient): void {
  // ── Sessions ──────────────────────────────────────────────────────────────

  server.tool(
    "list_sessions",
    "List all WhatsApp sessions and their connection status",
    {},
    async () => {
      const sessions = await waha.listSessions();
      return {
        content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
      };
    }
  );

  server.tool(
    "get_session_status",
    "Get the status of a specific WhatsApp session",
    { session: z.string().default("default").describe("Session name") },
    async ({ session }) => {
      const status = await waha.getSession(session);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  server.tool(
    "start_session",
    "Start a WhatsApp session (will require QR scan if not authenticated)",
    { session: z.string().default("default").describe("Session name") },
    async ({ session }) => {
      const result = await waha.startSession(session);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_qr_code",
    "Get the QR code for authenticating a session. Returns base64 image data.",
    { session: z.string().default("default").describe("Session name") },
    async ({ session }) => {
      const qr = await waha.getQR(session);
      return {
        content: [{ type: "text", text: JSON.stringify(qr, null, 2) }],
      };
    }
  );

  // ── Messages ──────────────────────────────────────────────────────────────

  server.tool(
    "send_message",
    "Send a WhatsApp text message to a phone number or group",
    {
      to: z
        .string()
        .describe(
          "Recipient phone number with country code (e.g. 919876543210) or group ID (e.g. 120363xxxxxx@g.us)"
        ),
      text: z.string().describe("Message text to send"),
      session: z.string().default("default").describe("Session name"),
      reply_to: z
        .string()
        .optional()
        .describe("Message ID to reply to (optional)"),
    },
    async ({ to, text, session, reply_to }) => {
      // Normalise phone numbers to WhatsApp chatId format
      const chatId = to.includes("@") ? to : `${to}@c.us`;
      const msg = await waha.sendText({ session, chatId, text, reply_to });
      return {
        content: [
          {
            type: "text",
            text: `Message sent. ID: ${msg.id}`,
          },
        ],
      };
    }
  );

  server.tool(
    "send_image",
    "Send an image to a WhatsApp contact via URL",
    {
      to: z.string().describe("Recipient phone or group ID"),
      image_url: z.string().url().describe("Publicly accessible image URL"),
      caption: z.string().optional().describe("Optional caption"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ to, image_url, caption, session }) => {
      const chatId = to.includes("@") ? to : `${to}@c.us`;
      const msg = await waha.sendImage({
        session,
        chatId,
        caption,
        file: { url: image_url },
      });
      return {
        content: [{ type: "text", text: `Image sent. ID: ${msg.id}` }],
      };
    }
  );

  server.tool(
    "send_file",
    "Send a file to a WhatsApp contact via URL",
    {
      to: z.string().describe("Recipient phone or group ID"),
      file_url: z.string().url().describe("Publicly accessible file URL"),
      caption: z.string().optional().describe("Optional caption"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ to, file_url, caption, session }) => {
      const chatId = to.includes("@") ? to : `${to}@c.us`;
      const msg = await waha.sendFile({
        session,
        chatId,
        caption,
        file: { url: file_url },
      });
      return {
        content: [{ type: "text", text: `File sent. ID: ${msg.id}` }],
      };
    }
  );

  server.tool(
    "get_messages",
    "Fetch recent messages from a WhatsApp chat",
    {
      chat_id: z
        .string()
        .describe("Chat ID (e.g. 919876543210@c.us or group@g.us)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Number of messages to fetch"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ chat_id, limit, session }) => {
      const messages = await waha.getMessages(session, chat_id, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    }
  );

  server.tool(
    "mark_as_seen",
    "Mark a message as read (sends blue ticks)",
    {
      chat_id: z.string().describe("Chat ID"),
      message_id: z.string().describe("Message ID to mark as seen"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ chat_id, message_id, session }) => {
      await waha.sendSeen(session, chat_id, message_id);
      return {
        content: [{ type: "text", text: "Marked as seen." }],
      };
    }
  );

  // ── Chats ─────────────────────────────────────────────────────────────────

  server.tool(
    "get_chats",
    "List recent WhatsApp chats",
    {
      limit: z.number().int().min(1).max(100).default(20).describe("Number of chats to return"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ limit, session }) => {
      const chats = await waha.getChats(session, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(chats, null, 2) }],
      };
    }
  );

  server.tool(
    "get_chat",
    "Get details for a specific chat",
    {
      chat_id: z.string().describe("Chat ID"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ chat_id, session }) => {
      const chat = await waha.getChat(session, chat_id);
      return {
        content: [{ type: "text", text: JSON.stringify(chat, null, 2) }],
      };
    }
  );

  // ── Contacts ──────────────────────────────────────────────────────────────

  server.tool(
    "get_contacts",
    "List all WhatsApp contacts",
    {
      session: z.string().default("default").describe("Session name"),
    },
    async ({ session }) => {
      const contacts = await waha.getContacts(session);
      return {
        content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }],
      };
    }
  );

  server.tool(
    "check_number",
    "Check if a phone number has WhatsApp and get their chat ID",
    {
      phone: z
        .string()
        .describe("Phone number with country code (e.g. 919876543210)"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ phone, session }) => {
      const result = await waha.checkNumberStatus(session, phone);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── Presence ──────────────────────────────────────────────────────────────

  server.tool(
    "set_presence",
    "Set online/offline presence for a session",
    {
      presence: z.enum(["online", "offline"]).describe("Presence state"),
      chat_id: z
        .string()
        .optional()
        .describe("Limit presence to a specific chat (optional)"),
      session: z.string().default("default").describe("Session name"),
    },
    async ({ presence, chat_id, session }) => {
      await waha.setPresence(session, presence, chat_id);
      return {
        content: [{ type: "text", text: `Presence set to ${presence}.` }],
      };
    }
  );
}
