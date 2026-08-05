import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import WebSocket from "ws";
import { createServer } from "node:net";
import { BridgeServer, webSocketBufferExceeded } from "../src/server.js";
import type { EventTailerTestHooks } from "../src/tailer.js";
import { makeEvent, tempConfig } from "./helpers.js";

const TOKEN = "test-token-that-is-not-stored-in-real-files";

async function startServer(options: { maxWebSocketBufferedBytes?: number; onError?: (error: unknown) => void; tailerTestHooks?: EventTailerTestHooks } = {}): Promise<{ server: BridgeServer; baseUrl: string; wsUrl: string; eventPath: string }> {
  const { config } = await tempConfig();
  const server = new BridgeServer({
    config,
    token: TOKEN,
    onError: options.onError ?? ((error) => { throw error; }),
    ...(options.maxWebSocketBufferedBytes === undefined ? {} : { maxWebSocketBufferedBytes: options.maxWebSocketBufferedBytes }),
    ...(options.tailerTestHooks === undefined ? {} : { tailerTestHooks: options.tailerTestHooks })
  });
  await server.start();
  const address = server.address();
  if (address === null) throw new Error("server has no address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    wsUrl: `ws://127.0.0.1:${String(address.port)}`,
    eventPath: config.eventPath
  };
}

void test("health is public while event replay requires bearer auth", async () => {
  const instance = await startServer();
  try {
    const health = await fetch(`${instance.baseUrl}/v1/health`);
    assert.equal(health.status, 200);
    const healthPayload: unknown = await health.json();
    assert.equal(typeof healthPayload === "object" && healthPayload !== null && "status" in healthPayload ? healthPayload.status : null, "ok");
    assert.equal((await fetch(`${instance.baseUrl}/v1/events`)).status, 401);
    assert.equal((await fetch(`${instance.baseUrl}/v1/events?limit=501`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);

    await appendFile(instance.eventPath, `${JSON.stringify(makeEvent("http"))}\n`, "utf8");
    await instance.server.pollOnce();
    const response = await fetch(`${instance.baseUrl}/v1/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    assert.equal(typeof payload, "object");
    const expired = await fetch(`${instance.baseUrl}/v1/events?after=unknown`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(expired.status, 409);
    const expiredPayload: unknown = await expired.json();
    assert.equal(
      typeof expiredPayload === "object" && expiredPayload !== null && "error" in expiredPayload
        ? expiredPayload.error
        : null,
      "cursor_expired"
    );
  } finally {
    await instance.server.stop();
  }
});

void test("WebSocket buffer guard rejects clients over the byte limit", () => {
  assert.equal(webSocketBufferExceeded(1024 * 1024, 0), false);
  assert.equal(webSocketBufferExceeded(1024 * 1024, 1), true);
  assert.equal(webSocketBufferExceeded(0, 1024 * 1024 + 1), true);
});

void test("broadcast terminates a client whose send buffer exceeds the limit", async () => {
  const instance = await startServer({ maxWebSocketBufferedBytes: 0 });
  try {
    const socket = new WebSocket(`${instance.wsUrl}/v1/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await appendFile(instance.eventPath, `${JSON.stringify(makeEvent("slow-client"))}\n`, "utf8");
    await instance.server.pollOnce();
    await closed;
    assert.notEqual(socket.readyState, WebSocket.OPEN);
  } finally {
    await instance.server.stop();
  }
});

void test("health becomes unhealthy after a poll error and recovers after a successful idle poll", async () => {
  let failPoll = false;
  const errors: unknown[] = [];
  const instance = await startServer({
    onError: (error) => errors.push(error),
    tailerTestHooks: {
      afterActiveOpen: (phase) => {
        if (phase === "poll" && failPoll) throw new Error("poll failed");
      }
    }
  });
  try {
    failPoll = true;
    await instance.server.pollOnce();
    const unhealthy = await fetch(`${instance.baseUrl}/v1/health`);
    assert.equal(unhealthy.status, 503);
    const unhealthyBody: unknown = await unhealthy.json();
    assert.equal(typeof unhealthyBody === "object" && unhealthyBody !== null && "status" in unhealthyBody ? unhealthyBody.status : null, "unhealthy");
    assert.equal(errors.length, 1);

    failPoll = false;
    await instance.server.pollOnce();
    const healthy = await fetch(`${instance.baseUrl}/v1/health`);
    assert.equal(healthy.status, 200);
    const healthyBody: unknown = await healthy.json();
    assert.equal(typeof healthyBody === "object" && healthyBody !== null && "status" in healthyBody ? healthyBody.status : null, "ok");
  } finally {
    await instance.server.stop();
  }
});

void test("listen failure stops the tailer", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  if (address === null || typeof address === "string") throw new Error("blocker has no address");
  const { config } = await tempConfig();
  const server = new BridgeServer({ config: { ...config, port: address.port }, token: TOKEN });
  try {
    await assert.rejects(server.start(), /EADDRINUSE/);
    await server.stop();
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

void test("WebSocket authenticates before upgrade, sends ready, and broadcasts events", async () => {
  const instance = await startServer();
  try {
    const unauthorizedStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${instance.wsUrl}/v1/events`);
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", reject);
    });
    assert.equal(unauthorizedStatus, 401);

    const socket = new WebSocket(`${instance.wsUrl}/v1/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const frames: unknown[] = [];
    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : Buffer.concat(data).toString("utf8");
      const frame: unknown = JSON.parse(text);
      frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(frames[0], { type: "ready", latest_cursor: null });
    await appendFile(instance.eventPath, `${JSON.stringify(makeEvent("ws"))}\n`, "utf8");
    await instance.server.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof frames[1], "object");
    socket.close();
  } finally {
    await instance.server.stop();
  }
});
