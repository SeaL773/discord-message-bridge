import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.DISCORD_BRIDGE_URL ?? "http://127.0.0.1:17891";
const tokenPath = process.env.DISCORD_BRIDGE_TOKEN_PATH
  ?? (process.env.APPDATA ? join(process.env.APPDATA, "Vencord", "MessageLoggerData", "bridge-token.txt") : new URL("../bridge-token.txt", import.meta.url));
const token = (await readFile(tokenPath, "utf8")).trim();
let cursor = null;

async function replay() {
  do {
    const url = new URL("/v1/events", baseUrl);
    url.searchParams.set("limit", "500");
    if (cursor !== null) url.searchParams.set("after", cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 409) {
      cursor = null;
      continue;
    }
    if (!response.ok) throw new Error(`Replay failed: HTTP ${response.status}`);
    const body = await response.json();
    for (const envelope of body.events) {
      console.log({
        cursor: envelope.cursor,
        event_type: envelope.event.event_type,
        message_id: envelope.event.message.id,
        channel_id: envelope.event.message.channel_id
      });
    }
    cursor = body.next_cursor;
    if (!body.has_more) return;
  } while (true);
}

function connect() {
  const url = new URL("/v1/events", baseUrl.replace(/^http/, "ws"));
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  socket.on("open", () => void replay().catch(console.error));
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "event") {
      console.log({
        cursor: frame.cursor,
        event_type: frame.event.event_type,
        message_id: frame.event.message.id,
        channel_id: frame.event.message.channel_id
      });
      cursor = frame.cursor;
    }
  });
  socket.on("close", () => setTimeout(connect, 1000));
  socket.on("error", (error) => console.error(error.message));
}

connect();
