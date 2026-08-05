import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createCatalogRequest,
  parseCatalogRequestArgs,
  writeCatalogRequestAtomic
} from "../scripts/create-channel-catalog-request.mjs";

const guildId = "12345678901234567";
const channelOne = "22345678901234567";
const channelTwo = "32345678901234567";

void test("creates an exact selected_channels schema", () => {
  const options = parseCatalogRequestArgs([
    "--guild", guildId,
    "--channel", channelOne,
    "--channel", channelTwo,
    "--output", "request.json"
  ]);
  assert.deepEqual(createCatalogRequest(options, "00000000-0000-4000-8000-000000000001"), {
    schema_version: 1,
    request_id: "00000000-0000-4000-8000-000000000001",
    guild_id: guildId,
    mode: "selected_channels",
    channel_ids: [channelOne, channelTwo]
  });
});

void test("creates an exact guild_text_channels schema", () => {
  const options = parseCatalogRequestArgs([
    "--guild", guildId,
    "--all-text-channels",
    "--output", "request.json"
  ]);
  assert.deepEqual(createCatalogRequest(options, "00000000-0000-4000-8000-000000000002"), {
    schema_version: 1,
    request_id: "00000000-0000-4000-8000-000000000002",
    guild_id: guildId,
    mode: "guild_text_channels"
  });
});

void test("rejects duplicate, invalid, missing, and mutually exclusive scope arguments", () => {
  const output = ["--output", "request.json"];
  assert.throws(() => parseCatalogRequestArgs(["--guild", "abc", "--channel", channelOne, ...output]), /Guild ID/);
  assert.throws(() => parseCatalogRequestArgs(["--guild", guildId, "--channel", "1", ...output]), /channel ID/);
  assert.throws(() => parseCatalogRequestArgs(["--guild", guildId, "--channel", channelOne, "--channel", channelOne, ...output]), /Duplicate/);
  assert.throws(() => parseCatalogRequestArgs(["--guild", guildId, "--channel", channelOne, "--all-text-channels", ...output]), /mutually exclusive/);
  assert.throws(() => parseCatalogRequestArgs(["--guild", guildId, ...output]), /Specify 1-64/);
  assert.throws(() => parseCatalogRequestArgs(["--guild", guildId, "--all-text-channels"]), /--output/);
});

void test("atomically writes valid JSON that replaces the requested path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-request-"));
  const output = join(directory, "channel-catalog.request.json");
  const request = {
    schema_version: 1 as const,
    request_id: "00000000-0000-4000-8000-000000000003",
    guild_id: guildId,
    mode: "selected_channels" as const,
    channel_ids: [channelOne]
  };
  try {
    await writeCatalogRequestAtomic(output, request);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), request);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
