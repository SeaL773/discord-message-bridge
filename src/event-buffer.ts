import { cursorForEvent } from "./cursor.js";
import type { DiscordEvent, EventEnvelope, ReplayPage } from "./types.js";

export type ReplayResult =
  | ({ ok: true } & ReplayPage)
  | { ok: false; error: "cursor_expired"; buffer_latest_cursor: string | null };

export class EventBuffer {
  readonly #capacity: number;
  readonly #events: EventEnvelope[] = [];
  readonly #cursors = new Set<string>();

  public constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.#capacity = capacity;
  }

  public add(event: DiscordEvent): EventEnvelope | null {
    const cursor = cursorForEvent(event);
    if (this.#cursors.has(cursor)) return null;

    const envelope: EventEnvelope = { type: "event", cursor, event };
    this.#events.push(envelope);
    this.#cursors.add(cursor);
    if (this.#events.length > this.#capacity) {
      const removed = this.#events.shift();
      if (removed !== undefined) this.#cursors.delete(removed.cursor);
    }
    return envelope;
  }

  public latestCursor(): string | null {
    return this.#events.at(-1)?.cursor ?? null;
  }

  public replay(after: string | null, limit: number): ReplayResult {
    const buffer_latest_cursor = this.latestCursor();
    if (after === null) {
      const events = this.#events.slice(-limit);
      return {
        ok: true,
        events,
        next_cursor: events.at(-1)?.cursor ?? null,
        has_more: false,
        buffer_latest_cursor
      };
    }

    const index = this.#events.findIndex((event) => event.cursor === after);
    if (index < 0) return { ok: false, error: "cursor_expired", buffer_latest_cursor };
    const start = index + 1;
    const events = this.#events.slice(start, start + limit);
    return {
      ok: true,
      events,
      next_cursor: events.at(-1)?.cursor ?? after,
      has_more: start + events.length < this.#events.length,
      buffer_latest_cursor
    };
  }
}
