import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseEventLine } from "./event-parser.js";
import type { DiscordEvent } from "./types.js";

const MAX_PRELOAD_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_NDJSON_LINE_CHARACTERS = 1024 * 1024;
const OVERSIZED_LINE_ERROR = "NDJSON line exceeds maximum length";

interface FileState {
  handle: FileHandle;
  identity: string;
  offset: number;
  decoder: StringDecoder;
  text: string;
  discardFirstLine: boolean;
  discardOversizedLine: boolean;
}

interface OpenedFile {
  handle: FileHandle;
  stats: Stats;
  identity: string;
}

export type ActiveOpenPhase = "startup" | "poll";

export interface EventTailerTestHooks {
  afterActiveOpen?: (phase: ActiveOpenPhase) => void | Promise<void>;
}

function identity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function newState(opened: OpenedFile, offset = 0, discardFirstLine = false): FileState {
  return {
    handle: opened.handle,
    identity: opened.identity,
    offset,
    decoder: new StringDecoder("utf8"),
    text: "",
    discardFirstLine,
    discardOversizedLine: false
  };
}

export interface EventTailerOptions {
  eventPath: string;
  pollMs: number;
  onEvent: (event: DiscordEvent, broadcast: boolean) => void;
  onError?: (error: unknown) => void;
  testHooks?: EventTailerTestHooks;
}

export interface EventTailerHealth {
  running: boolean;
  last_successful_poll_at: number | null;
  last_read_progress_at: number | null;
  consecutive_poll_errors: number;
}

export class EventTailer {
  readonly #eventPath: string;
  readonly #rotatedPath: string;
  readonly #pollMs: number;
  readonly #onEvent: (event: DiscordEvent, broadcast: boolean) => void;
  readonly #onError: (error: unknown) => void;
  readonly #testHooks: EventTailerTestHooks | undefined;
  #state: FileState | null = null;
  #timer: NodeJS.Timeout | null = null;
  #pollPromise: Promise<void> | null = null;
  #startPromise: Promise<void> | null = null;
  #stopping = false;
  #running = false;
  #lastSuccessfulPollAt: number | null = null;
  #lastReadProgressAt: number | null = null;
  #consecutivePollErrors = 0;

  public constructor(options: EventTailerOptions) {
    this.#eventPath = options.eventPath;
    this.#rotatedPath = `${options.eventPath}.1`;
    this.#pollMs = options.pollMs;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError ?? (() => undefined);
    this.#testHooks = options.testHooks;
  }

  public async start(): Promise<void> {
    if (this.#running) return;
    if (this.#startPromise !== null) return this.#startPromise;
    this.#stopping = false;
    const operation = this.#start();
    this.#startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#startPromise === operation) this.#startPromise = null;
    }
  }

  async #start(): Promise<void> {
    const active = await this.#openActive("startup", true);
    if (active === null) {
      await this.#preloadRotated(null);
    } else {
      const snapshotSize = active.stats.size;
      const start = Math.max(0, snapshotSize - MAX_PRELOAD_BYTES);
      this.#state = newState(active, start, start > 0);
      await this.#preloadRotated(active.identity);
      await this.#readTo(this.#state, snapshotSize, false);
    }

    await this.pollOnce();
    if (this.#stopping) return;
    this.#timer = setInterval(() => void this.pollOnce(), this.#pollMs);
    this.#timer.unref();
    this.#running = true;
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#startPromise !== null) await this.#startPromise;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#pollPromise !== null) await this.#pollPromise;
    const state = this.#state;
    this.#state = null;
    if (state !== null) await state.handle.close();
    this.#running = false;
  }

  public health(): EventTailerHealth {
    return {
      running: this.#running,
      last_successful_poll_at: this.#lastSuccessfulPollAt,
      last_read_progress_at: this.#lastReadProgressAt,
      consecutive_poll_errors: this.#consecutivePollErrors
    };
  }

  public async pollOnce(): Promise<void> {
    if (this.#pollPromise !== null) return this.#pollPromise;
    const operation = this.#poll().then(
      () => {
        this.#lastSuccessfulPollAt = Date.now();
        this.#consecutivePollErrors = 0;
      },
      (error: unknown) => {
        this.#consecutivePollErrors += 1;
        this.#onError(error);
      }
    );
    this.#pollPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#pollPromise === operation) this.#pollPromise = null;
    }
  }

  async #poll(): Promise<void> {
    if (this.#stopping) return;
    const candidate = await this.#openActive("poll", true);
    const retained = this.#state;

    if (retained === null) {
      if (candidate === null) return;
      this.#state = newState(candidate);
      await this.#drainCurrent(this.#state, true);
      return;
    }

    if (candidate === null) {
      await this.#drainCurrent(retained, true);
      return;
    }

    if (candidate.identity !== retained.identity) {
      await this.#replaceRetained(retained, candidate);
      return;
    }

    await candidate.handle.close();
    await this.#drainCurrent(retained, true);

    // A replacement can occur after the candidate was opened. Re-open the path
    // after draining the retained handle so the new identity can be adopted in
    // this poll without ever reading old offsets from the new path.
    const verification = await this.#openActive("poll", false);
    if (verification === null) return;
    if (verification.identity === retained.identity) {
      await verification.handle.close();
      return;
    }
    await this.#replaceRetained(retained, verification);
  }

  async #replaceRetained(retained: FileState, replacement: OpenedFile): Promise<void> {
    try {
      await this.#drainCurrent(retained, true);
    } finally {
      await retained.handle.close();
    }
    const adopted = newState(replacement);
    this.#state = adopted;
    await this.#drainCurrent(adopted, true);
  }

  async #drainCurrent(state: FileState, broadcast: boolean): Promise<void> {
    const stats = await state.handle.stat();
    if (stats.size < state.offset) {
      state.offset = 0;
      state.decoder = new StringDecoder("utf8");
      state.text = "";
      state.discardFirstLine = false;
      state.discardOversizedLine = false;
    }
    await this.#readTo(state, stats.size, broadcast);
  }

  async #openActive(phase: ActiveOpenPhase, invokeHook: boolean): Promise<OpenedFile | null> {
    let handle: FileHandle;
    try {
      handle = await open(this.#eventPath, "r");
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }

    try {
      const stats = await handle.stat();
      const opened = { handle, stats, identity: identity(stats) };
      if (invokeHook) await this.#testHooks?.afterActiveOpen?.(phase);
      return opened;
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }

  async #preloadRotated(activeIdentity: string | null): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(this.#rotatedPath, "r");
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }

    try {
      const stats = await handle.stat();
      const rotatedIdentity = identity(stats);
      if (rotatedIdentity === activeIdentity) return;
      const start = Math.max(0, stats.size - MAX_PRELOAD_BYTES);
      const state = newState({ handle, stats, identity: rotatedIdentity }, start, start > 0);
      await this.#readTo(state, stats.size, false);
    } finally {
      await handle.close();
    }
  }

  async #readTo(state: FileState, end: number, broadcast: boolean): Promise<void> {
    while (state.offset < end) {
      const length = Math.min(READ_CHUNK_BYTES, end - state.offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await state.handle.read(buffer, 0, length, state.offset);
      if (result.bytesRead === 0) break;
      state.offset += result.bytesRead;
      this.#lastReadProgressAt = Date.now();
      this.#consumeText(state, state.decoder.write(buffer.subarray(0, result.bytesRead)), broadcast);
    }
  }

  #consumeText(state: FileState, text: string, broadcast: boolean): void {
    if (state.discardFirstLine || state.discardOversizedLine) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      state.discardFirstLine = false;
      state.discardOversizedLine = false;
      text = text.slice(newline + 1);
    }

    state.text += text;
    let newline = state.text.indexOf("\n");
    while (newline >= 0) {
      const line = state.text.slice(0, newline);
      state.text = state.text.slice(newline + 1);
      if (line.length > MAX_NDJSON_LINE_CHARACTERS) {
        this.#onError(new Error(OVERSIZED_LINE_ERROR));
      } else {
        const event = parseEventLine(line.replace(/\r$/, ""));
        if (event !== null) this.#onEvent(event, broadcast);
      }
      newline = state.text.indexOf("\n");
    }

    if (state.text.length > MAX_NDJSON_LINE_CHARACTERS) {
      state.text = "";
      state.discardOversizedLine = true;
      this.#onError(new Error(OVERSIZED_LINE_ERROR));
    }
  }
}
