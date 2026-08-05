import { EVENT_TYPES, type DiscordEvent, type EventType } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPES.some((eventType) => eventType === value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.includes("T");
}

export function validateEvent(value: unknown): DiscordEvent | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value["schema_version"];
  const eventType = value["event_type"];
  const capturedAt = value["captured_at"];
  const message = value["message"];
  if (schemaVersion !== 1 || !isEventType(eventType) || !isIsoTimestamp(capturedAt)) {
    return null;
  }
  if (!isRecord(message)) return null;
  const messageId = message["id"];
  const channelId = message["channel_id"];
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (typeof channelId !== "string" || channelId.length === 0) return null;

  return {
    ...value,
    schema_version: 1,
    event_type: eventType,
    captured_at: capturedAt,
    message: {
      ...message,
      id: messageId,
      channel_id: channelId
    }
  };
}

export function parseEventLine(line: string): DiscordEvent | null {
  if (line.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(line);
    return validateEvent(value);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
