import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface BridgeConfig {
  eventPath: string;
  host: string;
  port: number;
  tokenPath: string;
  bufferSize: number;
  pollMs: number;
}

function parseInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeConfig {
  const appData = env["APPDATA"];
  const defaultDataDirectory = appData === undefined
    ? cwd
    : join(appData, "Vencord", "MessageLoggerData");
  const defaultEventPath = join(defaultDataDirectory, "message-events.ndjson");
  return {
    eventPath: resolve(env["DISCORD_BRIDGE_EVENT_PATH"] ?? defaultEventPath),
    host: env["DISCORD_BRIDGE_HOST"] ?? "127.0.0.1",
    port: parseInteger("DISCORD_BRIDGE_PORT", env["DISCORD_BRIDGE_PORT"], 17891, 1, 65_535),
    tokenPath: resolve(env["DISCORD_BRIDGE_TOKEN_PATH"] ?? join(defaultDataDirectory, "bridge-token.txt")),
    bufferSize: parseInteger("DISCORD_BRIDGE_BUFFER_SIZE", env["DISCORD_BRIDGE_BUFFER_SIZE"], 10_000, 1, 1_000_000),
    pollMs: parseInteger("DISCORD_BRIDGE_POLL_MS", env["DISCORD_BRIDGE_POLL_MS"], 250, 25, 60_000)
  };
}

export async function loadOrCreateToken(tokenPath: string): Promise<string> {
  await mkdir(dirname(tokenPath), { recursive: true });
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (!isValidToken(existing)) throw new Error("existing bridge token is invalid");
    return existing;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    const file = await open(tokenPath, "wx", 0o600);
    await file.writeFile(`${token}\n`, "utf8");
    await file.close();
    return token;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (!isValidToken(existing)) throw new Error("existing bridge token is invalid");
    return existing;
  }
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, "base64url").length === 32;
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
