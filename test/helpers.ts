import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.js";
import type { DiscordEvent } from "../src/types.js";

export function makeEvent(id: string, capturedAt = "2026-01-02T03:04:05.000Z"): DiscordEvent {
  return {
    schema_version: 1,
    event_type: "CREATED",
    captured_at: capturedAt,
    message: { id, channel_id: "channel-1", content: `message-${id}` }
  };
}

export async function tempConfig(): Promise<{ directory: string; config: BridgeConfig }> {
  const directory = await mkdtemp(join(tmpdir(), "discord-bridge-"));
  const eventPath = join(directory, "message-events.ndjson");
  await writeFile(eventPath, "", "utf8");
  return {
    directory,
    config: {
      eventPath,
      host: "127.0.0.1",
      port: 0,
      tokenPath: join(directory, "bridge-token.txt"),
      bufferSize: 100,
      pollMs: 60_000
    }
  };
}
