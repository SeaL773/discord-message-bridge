import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

if (!process.env.APPDATA && !process.env.DISCORD_BRIDGE_TOKEN_PATH) {
  throw new Error("APPDATA or DISCORD_BRIDGE_TOKEN_PATH is required");
}

const tokenPath = process.env.DISCORD_BRIDGE_TOKEN_PATH
  ?? join(process.env.APPDATA, "Vencord", "MessageLoggerData", "bridge-token.txt");
const token = (await readFile(tokenPath, "utf8")).trim();
const socket = new WebSocket("ws://127.0.0.1:17891/v1/events", {
  headers: { Authorization: `Bearer ${token}` }
});

const timeout = setTimeout(() => {
  console.error("No live event received within 30 seconds");
  socket.terminate();
  process.exitCode = 2;
}, 30_000);

socket.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type !== "event") return;

  clearTimeout(timeout);
  console.log(JSON.stringify({
    received: true,
    cursor: typeof frame.cursor === "string",
    event_type: frame.event?.event_type,
    message_id: frame.event?.message?.id,
    channel_id: frame.event?.message?.channel_id
  }));
  socket.close();
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
