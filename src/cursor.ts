import { createHash } from "node:crypto";
import type { DiscordEvent } from "./types.js";

export function cursorForEvent(event: DiscordEvent): string {
  const stableKey = [event.schema_version, event.event_type, event.captured_at, event.message.id].join("\0");
  return createHash("sha256").update(stableKey, "utf8").digest("base64url");
}
