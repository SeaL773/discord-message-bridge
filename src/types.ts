export const EVENT_TYPES = ["CREATED", "EDITED", "DELETED", "GHOST_PINGED"] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DiscordMessage {
  id: string;
  channel_id: string;
  [key: string]: unknown;
}

export interface DiscordEvent {
  schema_version: 1;
  event_type: EventType;
  captured_at: string;
  message: DiscordMessage;
  [key: string]: unknown;
}

export interface EventEnvelope {
  type: "event";
  cursor: string;
  event: DiscordEvent;
}

export interface ReadyFrame {
  type: "ready";
  latest_cursor: string | null;
}

export interface ReplayPage {
  events: EventEnvelope[];
  next_cursor: string | null;
  has_more: boolean;
  buffer_latest_cursor: string | null;
}
