import assert from "node:assert/strict";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { EventTailer, MAX_NDJSON_LINE_CHARACTERS } from "../src/tailer.js";
import type { DiscordEvent } from "../src/types.js";
import { makeEvent, tempConfig } from "./helpers.js";

void test("tailer preserves partial UTF-8 lines and emits only completed events", async () => {
  const { config } = await tempConfig();
  const received: DiscordEvent[] = [];
  const tailer = new EventTailer({ eventPath: config.eventPath, pollMs: config.pollMs, onEvent: (event) => received.push(event) });
  await tailer.start();
  const line = `${JSON.stringify({ ...makeEvent("utf8"), message: { id: "utf8", channel_id: "c", content: "hello 🚀" } })}\n`;
  const bytes = Buffer.from(line, "utf8");
  const split = bytes.indexOf(Buffer.from("🚀", "utf8")) + 1;
  await appendFile(config.eventPath, bytes.subarray(0, split));
  await tailer.pollOnce();
  assert.equal(received.length, 0);
  await appendFile(config.eventPath, bytes.subarray(split));
  await tailer.pollOnce();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.message["content"], "hello 🚀");
  await tailer.stop();
});

void test("tailer discards an oversized line through newline and resumes parsing", async () => {
  const { config } = await tempConfig();
  const received: string[] = [];
  const errors: unknown[] = [];
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event) => received.push(event.message.id),
    onError: (error) => errors.push(error)
  });
  await tailer.start();
  try {
    await appendFile(config.eventPath, "x".repeat(MAX_NDJSON_LINE_CHARACTERS + 1), "utf8");
    await tailer.pollOnce();
    assert.deepEqual(received, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0] instanceof Error ? errors[0].message : null, "NDJSON line exceeds maximum length");

    await appendFile(config.eventPath, `discarded-tail\n${JSON.stringify(makeEvent("after-oversized"))}\n`, "utf8");
    await tailer.pollOnce();
    assert.deepEqual(received, ["after-oversized"]);
    assert.equal(errors.length, 1);
  } finally {
    await tailer.stop();
  }
});

void test("tailer drains unread rotated bytes before reading replacement active file", async () => {
  const { config } = await tempConfig();
  const received: string[] = [];
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event, broadcast) => { if (broadcast) received.push(event.message.id); }
  });
  await tailer.start();
  await appendFile(config.eventPath, `${JSON.stringify(makeEvent("old"))}\n`, "utf8");
  await rename(config.eventPath, `${config.eventPath}.1`);
  await writeFile(config.eventPath, `${JSON.stringify(makeEvent("new"))}\n`, "utf8");
  await tailer.pollOnce();
  assert.deepEqual(received, ["old", "new"]);
  await tailer.stop();
});

void test("startup preloads rotated then active events without broadcast", async () => {
  const { config } = await tempConfig();
  await writeFile(`${config.eventPath}.1`, `${JSON.stringify(makeEvent("rotated"))}\n`, "utf8");
  await writeFile(config.eventPath, `${JSON.stringify(makeEvent("active"))}\n`, "utf8");
  const received: { id: string; broadcast: boolean }[] = [];
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event, broadcast) => received.push({ id: event.message.id, broadcast })
  });
  await tailer.start();
  assert.deepEqual(received, [
    { id: "rotated", broadcast: false },
    { id: "active", broadcast: false }
  ]);
  await tailer.stop();
});

void test("startup preserves an incomplete active line until it is completed", async () => {
  const { config } = await tempConfig();
  const received: { id: string; broadcast: boolean }[] = [];
  const line = `${JSON.stringify(makeEvent("startup-partial"))}\n`;
  const split = Math.floor(line.length / 2);
  await writeFile(config.eventPath, line.slice(0, split), "utf8");

  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event, broadcast) => received.push({ id: event.message.id, broadcast })
  });
  await tailer.start();
  assert.deepEqual(received, []);

  await appendFile(config.eventPath, line.slice(split), "utf8");
  await tailer.pollOnce();
  assert.deepEqual(received, [{ id: "startup-partial", broadcast: true }]);
  await tailer.stop();
});

void test("startup drains retained active handle when path rotates after open", async () => {
  const { config } = await tempConfig();
  await writeFile(config.eventPath, `${JSON.stringify(makeEvent("startup-old"))}\n`, "utf8");
  let rotated = false;
  const received: { id: string; broadcast: boolean }[] = [];
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event, broadcast) => received.push({ id: event.message.id, broadcast }),
    testHooks: {
      afterActiveOpen: async (phase) => {
        if (phase !== "startup" || rotated) return;
        rotated = true;
        await appendFile(config.eventPath, `${JSON.stringify(makeEvent("startup-appended"))}\n`, "utf8");
        await rename(config.eventPath, `${config.eventPath}.1`);
        await writeFile(config.eventPath, `${JSON.stringify(makeEvent("startup-new"))}\n`, "utf8");
      }
    }
  });
  await tailer.start();
  assert.deepEqual(received, [
    { id: "startup-old", broadcast: false },
    { id: "startup-appended", broadcast: true },
    { id: "startup-new", broadcast: true }
  ]);
  await tailer.stop();
});

void test("runtime replacement after active open drains only retained old handle", async () => {
  const { config } = await tempConfig();
  const received: string[] = [];
  let replaceOnPoll = false;
  let replaced = false;
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: (event, broadcast) => { if (broadcast) received.push(event.message.id); },
    testHooks: {
      afterActiveOpen: async (phase) => {
        if (phase !== "poll" || !replaceOnPoll || replaced) return;
        replaced = true;
        await appendFile(config.eventPath, `${JSON.stringify(makeEvent("runtime-old"))}\n`, "utf8");
        await rename(config.eventPath, `${config.eventPath}.1`);
        await writeFile(config.eventPath, `${JSON.stringify(makeEvent("runtime-new"))}\n`, "utf8");
      }
    }
  });
  await tailer.start();
  replaceOnPoll = true;
  await tailer.pollOnce();
  assert.deepEqual(received, ["runtime-old", "runtime-new"]);
  await tailer.stop();
});

void test("tailer health tracks successful idle polls and recovers after an error", async () => {
  const { config } = await tempConfig();
  let failPoll = false;
  const errors: unknown[] = [];
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: () => undefined,
    onError: (error) => errors.push(error),
    testHooks: {
      afterActiveOpen: () => {
        if (failPoll) throw new Error("poll failed");
      }
    }
  });
  await tailer.start();
  const initial = tailer.health();
  assert.equal(initial.running, true);
  assert.equal(initial.consecutive_poll_errors, 0);
  assert.equal(typeof initial.last_successful_poll_at, "number");

  failPoll = true;
  await tailer.pollOnce();
  assert.equal(errors.length, 1);
  assert.equal(tailer.health().consecutive_poll_errors, 1);

  failPoll = false;
  await tailer.pollOnce();
  assert.equal(tailer.health().consecutive_poll_errors, 0);
  await tailer.stop();
  assert.equal(tailer.health().running, false);
});

void test("stop during startup prevents the tailer from becoming running later", async () => {
  const { config } = await tempConfig();
  let releaseStartup: (() => void) | undefined;
  const startupBlocked = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  let startupOpened: (() => void) | undefined;
  const startupReached = new Promise<void>((resolve) => {
    startupOpened = resolve;
  });
  const tailer = new EventTailer({
    eventPath: config.eventPath,
    pollMs: config.pollMs,
    onEvent: () => undefined,
    testHooks: {
      afterActiveOpen: async (phase) => {
        if (phase !== "startup") return;
        startupOpened?.();
        await startupBlocked;
      }
    }
  });

  const starting = tailer.start();
  await startupReached;
  const stopping = tailer.stop();
  releaseStartup?.();
  await Promise.all([starting, stopping]);

  assert.equal(tailer.health().running, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tailer.health().running, false);
});
