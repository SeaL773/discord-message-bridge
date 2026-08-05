import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorForEvent } from "../src/cursor.js";
import { EventBuffer } from "../src/event-buffer.js";
import { parseEventLine, validateEvent } from "../src/event-parser.js";
import { makeEvent } from "./helpers.js";

void test("parser accepts valid events and rejects malformed input", () => {
  const event = makeEvent("1");
  assert.deepEqual(validateEvent(event), event);
  assert.deepEqual(parseEventLine(JSON.stringify(event)), event);
  assert.equal(parseEventLine("not-json"), null);
  assert.equal(validateEvent({ ...event, schema_version: 2 }), null);
  assert.equal(validateEvent({ ...event, captured_at: "yesterday" }), null);
  assert.equal(validateEvent({ ...event, message: { id: "1" } }), null);
});

void test("cursor is stable and buffer deduplicates and replays", () => {
  const first = makeEvent("1");
  const second = makeEvent("2", "2026-01-02T03:04:06.000Z");
  assert.equal(cursorForEvent(first), cursorForEvent({ ...first, message: { ...first.message, content: "changed" } }));

  const buffer = new EventBuffer(2);
  const firstEnvelope = buffer.add(first);
  assert.notEqual(firstEnvelope, null);
  assert.equal(buffer.add(first), null);
  const secondEnvelope = buffer.add(second);
  assert.notEqual(secondEnvelope, null);
  if (firstEnvelope === null || secondEnvelope === null) throw new Error("expected envelopes");
  assert.deepEqual(buffer.replay(firstEnvelope.cursor, 10), {
    ok: true,
    events: [secondEnvelope],
    next_cursor: secondEnvelope.cursor,
    has_more: false,
    buffer_latest_cursor: secondEnvelope.cursor
  });

  buffer.add(makeEvent("3", "2026-01-02T03:04:07.000Z"));
  assert.deepEqual(buffer.replay(firstEnvelope.cursor, 10), {
    ok: false,
    error: "cursor_expired",
    buffer_latest_cursor: buffer.latestCursor()
  });
});

void test("forward replay paginates 502 events without skipping", () => {
  const buffer = new EventBuffer(600);
  const envelopes = Array.from({ length: 502 }, (_, index) => {
    const capturedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const envelope = buffer.add(makeEvent(String(index), capturedAt));
    if (envelope === null) throw new Error("expected unique envelope");
    return envelope;
  });
  const firstCursor = envelopes[0]?.cursor;
  if (firstCursor === undefined) throw new Error("missing first cursor");

  const firstPage = buffer.replay(firstCursor, 500);
  assert.equal(firstPage.ok, true);
  assert.equal(firstPage.events.length, 500);
  assert.equal(firstPage.has_more, true);
  assert.equal(firstPage.next_cursor, firstPage.events.at(-1)?.cursor);
  assert.equal(firstPage.buffer_latest_cursor, envelopes.at(-1)?.cursor);

  const secondPage = buffer.replay(firstPage.next_cursor, 500);
  assert.equal(secondPage.ok, true);
  assert.deepEqual(secondPage.events.map((event) => event.event.message.id), ["501"]);
  assert.equal(secondPage.has_more, false);
  assert.equal(secondPage.next_cursor, envelopes.at(-1)?.cursor);
  assert.deepEqual(
    [...firstPage.events, ...secondPage.events].map((event) => event.event.message.id),
    Array.from({ length: 501 }, (_, index) => String(index + 1))
  );
});
