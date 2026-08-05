import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const verifier = new URL("../scripts/verify-collector-patch.mjs", import.meta.url);

void test("verifier requires explicit fixture inputs with actionable errors", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [verifier.pathname], {
      env: { ...process.env, MLE_FIXTURE_PATH: "", VENCORD_PATH: "" }
    }),
    error => error instanceof Error && error.message.includes("MessageLoggerEnhanced source repository is required")
  );
});

void test("verifier rejects unknown and duplicate arguments", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [verifier.pathname, "--unknown"], {
      env: { ...process.env, MLE_FIXTURE_PATH: "", VENCORD_PATH: "" }
    }),
    error => error instanceof Error && error.message.includes("Unknown verifier argument")
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      verifier.pathname,
      "--mle-fixture", "/one",
      "--mle-fixture", "/two",
      "--vencord", "/three"
    ]),
    error => error instanceof Error && error.message.includes("may be specified only once")
  );
});

void test("verifier validates an explicitly supplied reviewed fixture", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      verifier.pathname,
      "--mle-fixture", "/definitely/missing/mle",
      "--vencord", "/definitely/missing/vencord",
      "--reviewed-fixture", "/definitely/missing/reviewed"
    ]),
    error => error instanceof Error && error.message.includes("directory does not exist")
  );
});

void test("verifier accepts a clean pinned source without a reviewed fixture when local fixtures are available", async context => {
  const source = process.env["TEST_MLE_SOURCE_PATH"];
  const vencord = process.env["TEST_VENCORD_PATH"];
  if (!source || !vencord) {
    context.skip("Set TEST_MLE_SOURCE_PATH and TEST_VENCORD_PATH to run the local fixture test");
    return;
  }
  const available = await Promise.all([source, vencord].map(async directory => stat(directory).then(details => details.isDirectory(), () => false)));
  if (available.includes(false)) {
    context.skip("Pinned local verifier fixtures are unavailable");
    return;
  }
  const { stdout } = await execFileAsync(process.execPath, [
    verifier.pathname,
    "--mle-fixture", source,
    "--vencord", vencord
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.match(stdout, /Verified collector patch against clean source/);
});

void test("verifier reports missing explicit directories", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      verifier.pathname,
      "--mle-fixture", "/definitely/missing/mle",
      "--vencord", "/definitely/missing/vencord"
    ]),
    error => error instanceof Error && error.message.includes("directory does not exist")
  );
});
