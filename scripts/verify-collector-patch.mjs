import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bridgeRoot = path.resolve(import.meta.dirname, "..");
const patchPath = path.join(bridgeRoot, "patches", "message-logger-enhanced-collector.patch");
const expectedMleCommit = "ea339bc09d7415ad0f715d60b80ba89ba2d685fa";
const expectedVencordCommit = "4b9c27d905d6255141617546227a56073916ebd4";
const removedUpdaterPaths = [
  "components/UpdaterModal.tsx",
  "native/updater.ts",
  "utils/native-file-system-adapter/types/src/adapters/sandbox.d.ts",
  "utils/updater.tsx"
];

function parseArguments(argv) {
  const options = { runVencordBuild: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--vencord-build") {
      options.runVencordBuild = true;
      continue;
    }
    if (argument !== "--mle-fixture" && argument !== "--reviewed-fixture" && argument !== "--vencord")
      throw new Error(`Unknown verifier argument: ${argument}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--"))
      throw new Error(`${argument} requires a directory path`);
    index++;
    const key = argument === "--mle-fixture"
      ? "sourcePath"
      : argument === "--reviewed-fixture"
        ? "reviewedFixturePath"
        : "vencordPath";
    if (options[key] != null) throw new Error(`${argument} may be specified only once`);
    options[key] = path.resolve(value);
  }

  options.sourcePath ??= process.env.MLE_FIXTURE_PATH ? path.resolve(process.env.MLE_FIXTURE_PATH) : undefined;
  options.reviewedFixturePath ??= process.env.MLE_REVIEWED_FIXTURE_PATH ? path.resolve(process.env.MLE_REVIEWED_FIXTURE_PATH) : undefined;
  options.vencordPath ??= process.env.VENCORD_PATH ? path.resolve(process.env.VENCORD_PATH) : undefined;
  if (options.sourcePath == null)
    throw new Error("MessageLoggerEnhanced source repository is required. Pass --mle-fixture <path> or set MLE_FIXTURE_PATH.");
  if (options.vencordPath == null)
    throw new Error("Vencord fixture is required. Pass --vencord <path> or set VENCORD_PATH.");
  return options;
}

const { sourcePath, reviewedFixturePath, vencordPath, runVencordBuild } = parseArguments(process.argv.slice(2));

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CI: "true",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`, { cause: error });
  }
}

async function git(cwd, ...args) {
  const previous = process.env.GIT_MASTER;
  process.env.GIT_MASTER = "1";
  try {
    return await run("git", args, cwd);
  } finally {
    if (previous == null) delete process.env.GIT_MASTER;
    else process.env.GIT_MASTER = previous;
  }
}

function normalizeLf(contents) {
  return contents.replaceAll("\r\n", "\n");
}

function patchedPaths(patch) {
  const paths = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(match => match[2]);
  if (paths.length === 0 || new Set(paths).size !== paths.length)
    throw new Error("Patch must contain at least one diff and each path exactly once");
  if (paths.includes("LOCAL_INTEGRATION.md"))
    throw new Error("Patch must not include LOCAL_INTEGRATION.md");
  if (paths.filter(file => file === "channelCatalog.ts").length !== 1)
    throw new Error("Patch must include channelCatalog.ts exactly once");
  for (const removedPath of removedUpdaterPaths) {
    if (!paths.includes(removedPath))
      throw new Error(`Patch must explicitly include removed updater path ${removedPath}`);
  }
  return paths;
}

async function assertCommit(repository, expected, label) {
  const { stdout } = await git(repository, "rev-parse", "HEAD");
  if (stdout.trim() !== expected)
    throw new Error(`${label} must be pinned to ${expected}; found ${stdout.trim()}`);
}

async function assertDirectory(directory, label) {
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(`${label} directory does not exist: ${directory}`, { cause: error });
    throw error;
  }
}

async function changedPaths(repository) {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    git(repository, "diff", "--name-only", "HEAD", "--"),
    git(repository, "ls-files", "--others", "--exclude-standard")
  ]);
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))].sort();
}

async function comparePatchedTrees(patchedRepository, fixture, paths) {
  const expectedPaths = paths.slice().sort();
  const [patchedChanges, fixtureChanges] = await Promise.all([
    changedPaths(patchedRepository),
    changedPaths(fixture)
  ]);
  if (JSON.stringify(patchedChanges) !== JSON.stringify(expectedPaths))
    throw new Error(`Canonical patch paths do not match its applied tree changes:\npatch=${expectedPaths.join(",")}\napplied=${patchedChanges.join(",")}`);
  if (JSON.stringify(fixtureChanges) !== JSON.stringify(expectedPaths))
    throw new Error(`Canonical patch paths do not match the reviewed fixture changes:\npatch=${expectedPaths.join(",")}\nfixture=${fixtureChanges.join(",")}`);

  for (const relativePath of paths) {
    const patchedFile = path.join(patchedRepository, relativePath);
    const fixtureFile = path.join(fixture, relativePath);
    let patchedContents;
    let fixtureContents;
    try {
      [patchedContents, fixtureContents] = await Promise.all([
        readFile(patchedFile, "utf8"),
        readFile(fixtureFile, "utf8")
      ]);
    } catch (error) {
      if (error.code === "ENOENT") {
        const [patchedExists, fixtureExists] = await Promise.all([
          readFile(patchedFile).then(() => true, missing => missing.code === "ENOENT" ? false : Promise.reject(missing)),
          readFile(fixtureFile).then(() => true, missing => missing.code === "ENOENT" ? false : Promise.reject(missing))
        ]);
        if (!patchedExists && !fixtureExists)
          continue;
      }
      throw error;
    }
    if (normalizeLf(patchedContents) !== normalizeLf(fixtureContents))
      throw new Error(`Patched ${relativePath} does not match the fixture after LF normalization`);
  }
}

async function assertUpdaterRemoved(repository) {
  for (const relativePath of removedUpdaterPaths) {
    try {
      await stat(path.join(repository, relativePath));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    throw new Error(`Patched tree must not retain third-party updater path ${relativePath}`);
  }
}

function assertMatches(contents, pattern, message) {
  if (!pattern.test(contents))
    throw new Error(message);
}

function assertBefore(contents, firstPattern, secondPattern, message) {
  const first = contents.search(firstPattern);
  const second = contents.search(secondPattern);
  if (first === -1 || second === -1 || first >= second)
    throw new Error(message);
}

async function loadTypeScriptHelper(contents) {
  const javascript = ts.transpileModule(contents, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

function makeDescendingMessages(high, count) {
  return Array.from({ length: count }, (_, index) => ({ id: String(high - index) }));
}

async function assertBackfillPaginationHelper(helperContents) {
  if (/^\s*import\s/m.test(helperContents))
    throw new Error("Backfill pagination helper must remain import-free");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(helperContents))
    throw new Error("Backfill pagination helper must not contain type suppressions or any casts");

  const helper = await loadTypeScriptHelper(helperContents);
  const { paginateBackfill, validateBackfillCount } = helper;
  if (typeof paginateBackfill !== "function" || typeof validateBackfillCount !== "function")
    throw new Error("Backfill pagination helper must export validation and pagination functions");

  const requests = [];
  const pages = [makeDescendingMessages(1000, 100), makeDescendingMessages(900, 100), makeDescendingMessages(800, 50)];
  const snapshots = pages.map(page => JSON.stringify(page));
  const result = await paginateBackfill(250, async request => {
    requests.push({ ...request });
    return pages[requests.length - 1];
  });
  if (JSON.stringify(requests) !== JSON.stringify([
    { limit: 100 },
    { limit: 100, before: "901" },
    { limit: 50, before: "801" }
  ])) throw new Error("Backfill pagination must request 250 entries as 100/100/50 with raw-page oldest cursors");
  if (result.examined !== 250 || result.entries.length !== 250 || result.historyEnded)
    throw new Error("Backfill pagination must report the exact 250-entry bound without inventing history end");
  if (result.entries[0].id !== "1000" || result.entries.at(-1).id !== "751")
    throw new Error("Backfill pagination must preserve complete newest-first order");
  const oldestFirst = result.entries.slice().reverse();
  if (oldestFirst[0].id !== "751" || oldestFirst.at(-1).id !== "1000")
    throw new Error("A single full-result reverse must produce oldest-first persistence order");
  if (pages.some((page, index) => JSON.stringify(page) !== snapshots[index]))
    throw new Error("Backfill pagination must not mutate input page arrays");

  const short = await paginateBackfill(250, async () => makeDescendingMessages(500, 40));
  if (!short.historyEnded || short.examined !== 40 || short.entries.length !== 40)
    throw new Error("A short history page must end pagination");
  let emptyCalls = 0;
  const empty = await paginateBackfill(10, async () => {
    emptyCalls++;
    return [];
  });
  if (!empty.historyEnded || empty.examined !== 0 || empty.entries.length !== 0 || emptyCalls !== 1)
    throw new Error("An empty history page must end pagination immediately");

  const overlapPages = [
    makeDescendingMessages(200, 100),
    [{ id: "101" }, { id: "100" }]
  ];
  let overlapIndex = 0;
  const overlap = await paginateBackfill(102, async () => overlapPages[overlapIndex++]);
  if (overlap.examined !== 102 || overlap.entries.length !== 101 || overlap.entries.at(-1).id !== "100")
    throw new Error("Backfill pagination must globally deduplicate overlap while bounding raw entries examined");

  for (const invalid of [0, 5001, 1.5, Number.NaN, "100", null]) {
    let rejected = false;
    try {
      validateBackfillCount(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`Backfill count validator accepted invalid value ${String(invalid)}`);
  }
  for (const valid of [1, 100, 5000]) {
    if (validateBackfillCount(valid) !== valid)
      throw new Error(`Backfill count validator changed valid value ${valid}`);
  }

  let cursorRejected = false;
  try {
    let call = 0;
    await paginateBackfill(102, async () => call++ === 0
      ? makeDescendingMessages(200, 100)
      : [{ id: "150" }, { id: "101" }]);
  } catch {
    cursorRejected = true;
  }
  if (!cursorRejected)
    throw new Error("Backfill pagination must reject repeated or non-advancing cursors");
}

async function assertMessagePersistenceCoordinator(helperContents) {
  if (/^\s*import\s/m.test(helperContents))
    throw new Error("Message persistence coordinator must remain import-free");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(helperContents))
    throw new Error("Message persistence coordinator must not contain type suppressions or any casts");

  const helper = await loadTypeScriptHelper(helperContents);
  const { createMessagePersistenceCoordinator, preserveCreatedJournalMarker } = helper;
  if (typeof createMessagePersistenceCoordinator !== "function" || typeof preserveCreatedJournalMarker !== "function")
    throw new Error("Message persistence coordinator must export its runtime helpers");

  {
    const coordinator = createMessagePersistenceCoordinator();
    let marker = false;
    let appends = 0;
    const operations = () => ({
      messageId: "1",
      canAppend: () => true,
      hasCreatedEvent: async () => marker,
      appendCreated: async () => {
        appends++;
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      markCreatedEvent: async () => {
        marker = true;
      }
    });
    const outcomes = await Promise.all([coordinator.commitCreated(operations()), coordinator.commitCreated(operations())]);
    if (appends !== 1 || marker !== true || outcomes.filter(outcome => outcome === "journaled").length !== 1)
      throw new Error("Same-ID live/backfill CREATED races must perform exactly one append");
  }

  {
    const coordinator = createMessagePersistenceCoordinator();
    let marker = false;
    let attempts = 0;
    const run = () => coordinator.commitCreated({
      messageId: "2",
      canAppend: () => true,
      hasCreatedEvent: async () => marker,
      appendCreated: async () => {
        attempts++;
        if (attempts === 1) throw new Error("append failed");
      },
      markCreatedEvent: async () => {
        marker = true;
      }
    });
    await run().then(
      () => { throw new Error("Failed CREATED append must reject"); },
      () => undefined
    );
    if (marker) throw new Error("Failed CREATED append must not set the journal marker");
    if (await run() !== "journaled" || attempts !== 2 || !marker)
      throw new Error("A later CREATED retry must succeed after append failure");
  }

  {
    const coordinator = createMessagePersistenceCoordinator();
    let marker = false;
    const timestamps = [];
    let markAttempts = 0;
    const commit = () => coordinator.commitCreated({
      messageId: "3",
      canAppend: () => true,
      hasCreatedEvent: async () => marker,
      appendCreated: async () => {
        timestamps.push("2026-01-02T03:04:05.000Z");
      },
      markCreatedEvent: async () => {
        markAttempts++;
        if (markAttempts === 1) throw new Error("IDB marker failed");
        marker = true;
      }
    });
    await commit().then(
      () => { throw new Error("Marker failure must reject and stop historical persistence"); },
      () => undefined
    );
    if (marker) throw new Error("Marker failure must leave CREATED unmarked");
    if (await commit() !== "journaled" || timestamps.length !== 2 || new Set(timestamps).size !== 1)
      throw new Error("Marker failure retry must reuse the identical deterministic timestamp");
  }

  const edited = { status: "EDITED", message: { id: "4" } };
  const markedEdit = preserveCreatedJournalMarker({ created_journaled: true }, edited);
  if (markedEdit.created_journaled !== true || markedEdit.status !== "EDITED")
    throw new Error("Non-CREATED updates must preserve the marker without replacing lifecycle status");
}

async function assertBackfillPreparationHelper(helperContents) {
  if (/^\s*import\s/m.test(helperContents))
    throw new Error("Backfill preparation helper must remain import-free");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(helperContents))
    throw new Error("Backfill preparation helper must not contain type suppressions or any casts");

  const helper = await loadTypeScriptHelper(helperContents);
  const { fetchAndPrepareBackfill } = helper;
  if (typeof fetchAndPrepareBackfill !== "function")
    throw new Error("Backfill preparation helper must export fetchAndPrepareBackfill");

  let fetches = 0;
  await fetchAndPrepareBackfill(false, async () => {
    fetches++;
    return { entries: [], examined: 0, historyEnded: true };
  }, value => value, () => "timestamp", () => false).then(
    () => { throw new Error("Disabled created persistence must reject backfill"); },
    () => undefined
  );
  if (fetches !== 0)
    throw new Error("persistCreatedMessages=false must cause zero REST/fetch calls");

  let persistenceStarted = false;
  await fetchAndPrepareBackfill(true, async () => ({
    entries: [{ id: "1" }, { id: "2" }],
    examined: 2,
    historyEnded: true
  }), value => {
    if (value.id === "2") throw new Error("normalization failed");
    return value;
  }, () => "timestamp", () => {
    persistenceStarted = true;
    return false;
  }).then(
    () => { throw new Error("Complete-batch normalization failure must reject"); },
    () => undefined
  );
  if (persistenceStarted)
    throw new Error("Complete-batch normalization failure must occur before filtering or append");

  const ignored = await fetchAndPrepareBackfill(true, async () => ({
    entries: [{ id: "1" }],
    examined: 1,
    historyEnded: true
  }), value => value, () => "timestamp", () => true);
  if (ignored.ignored !== 1 || ignored.entries.length !== 0)
    throw new Error("Privacy-ignored entries must produce zero persistence candidates");
}

async function assertBackfillExecutionHelper(helperContents) {
  if (/^\s*import\s/m.test(helperContents))
    throw new Error("Backfill execution helper must remain import-free");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(helperContents))
    throw new Error("Backfill execution helper must not contain type suppressions or any casts");

  const helper = await loadTypeScriptHelper(helperContents);
  const runBackfillExecution = helper.runBackfillExecution;
  if (typeof runBackfillExecution !== "function")
    throw new Error("Backfill execution helper must export runBackfillExecution");

  const calls = [];
  const success = await runBackfillExecution("123", 500, value => {
    calls.push(["validate", value]);
    return value;
  }, async (channelId, count) => {
    calls.push(["execute", channelId, count]);
    return "Backfill complete. requested=500 persisted=42";
  }, code => calls.push(["log", code]));
  if (!success.ok || success.message !== "Backfill complete. requested=500 persisted=42")
    throw new Error("Shared backfill runner must preserve successful result counters");
  if (JSON.stringify(calls) !== JSON.stringify([["validate", 500], ["execute", "123", 500]]))
    throw new Error("Shared backfill runner must validate once and execute the explicit target channel once");

  const safeErrors = [
    "Enable created-message persistence before running backfill.",
    "This channel is not in the active Bridge channel-catalog allowlist.",
    "A backfill is already running for this channel.",
    "count must be an integer from 1 to 5000"
  ];
  for (const safeError of safeErrors) {
    let logged;
    const failure = await runBackfillExecution("123", 100, value => value, async () => {
      throw new Error(safeError);
    }, code => { logged = code; });
    if (failure.ok || failure.message !== `Backfill failed. ${safeError}` || logged !== "backfill_failed")
      throw new Error("Shared backfill runner must expose only approved validation failures and log only a fixed error code");
  }

  const secret = "Authorization: Bearer secret-token response-body-message-content";
  let unsafeLog;
  const unsafe = await runBackfillExecution("123", 100, value => value, async () => {
    throw new Error(secret);
  }, code => { unsafeLog = code; });
  if (unsafe.ok || unsafe.message !== "Backfill failed." || unsafe.message.includes(secret) || unsafeLog !== "backfill_failed")
    throw new Error("Shared backfill runner must replace unknown technical errors in feedback and logs with fixed wording");
}

async function assertBackfillLifecycleHelper(helperContents) {
  if (/^\s*import\s/m.test(helperContents))
    throw new Error("Backfill lifecycle helper must remain import-free");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(helperContents))
    throw new Error("Backfill lifecycle helper must not contain type suppressions or any casts");

  const helper = await loadTypeScriptHelper(helperContents);
  const lifecycle = helper.createBackfillLifecycle();
  lifecycle.start();
  const oldLease = lifecycle.begin("123");
  if (!lifecycle.isCurrent(oldLease))
    throw new Error("A new backfill lease must be current while the lifecycle is running");
  lifecycle.stop();
  lifecycle.start();
  if (lifecycle.isCurrent(oldLease))
    throw new Error("A pre-stop backfill lease must remain invalid after restart");
  const newLease = lifecycle.begin("123");
  lifecycle.finish(oldLease);
  if (!lifecycle.isCurrent(newLease))
    throw new Error("Finishing an old lease must not release a newer backfill for the same channel");
  lifecycle.finish(newLease);
  const replacement = lifecycle.begin("123");
  if (!lifecycle.isCurrent(replacement))
    throw new Error("Finishing the current lease must permit a replacement backfill");
}

async function assertCollectorSemantics(fixture) {
  const [catalog, db, manager, native, settings, plugin, logsModal, clearHelper, backfillHelper, lifecycleHelper, preparationHelper, executionHelper, coordinatorHelper] = await Promise.all([
    readFile(path.join(fixture, "channelCatalog.ts"), "utf8"),
    readFile(path.join(fixture, "db.ts"), "utf8"),
    readFile(path.join(fixture, "LoggedMessageManager.ts"), "utf8"),
    readFile(path.join(fixture, "native", "index.ts"), "utf8"),
    readFile(path.join(fixture, "settings.tsx"), "utf8"),
    readFile(path.join(fixture, "index.tsx"), "utf8"),
    readFile(path.join(fixture, "components", "LogsModal.tsx"), "utf8"),
    readFile(path.join(fixture, "utils", "clearAllLocalLogs.ts"), "utf8"),
    readFile(path.join(fixture, "backfillPagination.ts"), "utf8"),
    readFile(path.join(fixture, "backfillLifecycle.ts"), "utf8"),
    readFile(path.join(fixture, "backfillPreparation.ts"), "utf8"),
    readFile(path.join(fixture, "backfillExecution.ts"), "utf8"),
    readFile(path.join(fixture, "messagePersistenceCoordinator.ts"), "utf8")
  ]);

  assertMatches(catalog, /getRequestedEventNames\(channelId: string\): RequestedEventNames \| null/, "Catalog API must explicitly deny absent or out-of-scope channels with null");
  assertMatches(catalog, /if \(scope == null \|\| !scope\.channelIds\.has\(channelId\)\)\s*return null;/, "Catalog API must deny channels outside the active scope");
  assertMatches(catalog, /if \(refreshPromise != null\)\s*return refreshPromise;\s*activeScope = null;\s*refreshPromise = runRefresh\(\)/, "Catalog refresh must revoke the previous allowlist synchronously before any fallible refresh work");
  assertMatches(manager, /const eventNames = getRequestedEventNames\(finalMessage\.channel_id\);[\s\S]*?if \(eventNames != null\)[\s\S]*?Native\.appendLogEvent/, "NDJSON append must be gated by the resolved catalog allowlist");

  assertMatches(plugin, /enabledByDefault:\s*false/, "Collector must be disabled by default");
  assertMatches(settings, /persistCreatedMessages:\s*\{[\s\S]*?default:\s*false/, "Created-message persistence must default to false");
  assertMatches(settings, /cacheMessagesFromServers:\s*\{[\s\S]*?default:\s*false/, "Server-message caching must default to false");
  assertMatches(settings, /saveImages:\s*\{[\s\S]*?default:\s*false/, "Attachment downloads must remain disabled by default");

  assertMatches(native, /export function clearLogEvents\([\s\S]*?eventLogWriteQueue\.then\(clearEvents, clearEvents\)/, "Native integration log clearing must serialize behind the event write queue");
  assertMatches(native, /EVENT_LOG_FILENAME[\s\S]*?`\$\{eventLogPath\}\.1`[\s\S]*?unlink/, "Native integration log clearing must cover active and rotated journals");
  assertMatches(settings, /clearAllLocalLogs\(clearMessagesIDB, \(\) => Native\.clearLogEvents\(\)\)/, "Settings Clear All must use the shared failure-independent helper");
  assertMatches(logsModal, /clearAllLocalLogs\(clearMessagesIDB, \(\) => Native\.clearLogEvents\(\)\)/, "Logs modal Clear All must use the shared failure-independent helper");
  assertMatches(logsModal, /Clear Visible IndexedDB Logs/, "Visible-only clearing must be explicit in the UI");

  const clearCopy = `${settings}\n${logsModal}`;
  assertMatches(clearCopy, /Bridge[^\n]*restart|restart[^\n]*Bridge/i, "Clear confirmation must disclose that Bridge restart clears its replay buffer");
  if (/downstream state[^\n]*(?:clear|delete|erase)|Telegram[^\n]*(?:clear|delete|erase)/i.test(clearCopy))
    throw new Error("Clear confirmation must not claim downstream state or Telegram is erased");
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(settings))
    throw new Error("Touched settings code must not contain type suppressions or any casts");

  assertMatches(plugin, /name:\s*"backfillmessages"/, "Collector must register the static /backfillmessages command");
  assertMatches(plugin, /const channelId = ctx\.channel\.id;/, "Backfill command must operate on the current command channel only");
  assertMatches(plugin, /type:\s*ApplicationCommandOptionType\.INTEGER/, "Backfill count option must use the integer command type");
  assertMatches(plugin, /runBackfillWithLocalFeedback\(channelId, findOption\(args, "count", DEFAULT_BACKFILL_COUNT\)\)/, "Backfill command must use the shared local-feedback runner with default 100");
  assertMatches(plugin, /const patchBackfillChannelContextMenu:\s*NavContextMenuPatchCallback\s*=\s*\(children, \{ channel \}/, "Backfill context menu must use the official static Vencord callback pattern");
  assertMatches(plugin, /contextMenus:\s*\{[\s\S]*?"channel-context":\s*patchBackfillChannelContextMenu[\s\S]*?"thread-context":\s*patchBackfillChannelContextMenu/, "Backfill must register channel and thread context menus");
  assertMatches(plugin, /isContextMenuChannel\(channel\)[\s\S]*?runBackfillWithLocalFeedback\(channel\.id, count\)/, "Context-menu backfill must target props.channel.id after structural validation");
  assertMatches(plugin, /const BACKFILL_COUNTS = \[100, 500, 1000, 5000\] as const;/, "Context-menu backfill choices must be exactly 100, 500, 1000, and 5000");
  assertMatches(plugin, /id=\{`\$\{BACKFILL_MENU_ID\}-\$\{count\}`\}[\s\S]*?key=\{`\$\{BACKFILL_MENU_ID\}-\$\{count\}`\}/, "Each fixed backfill choice must derive a stable unique item ID and key");
  assertMatches(plugin, /runBackfillExecution\([\s\S]*?validateBackfillCount[\s\S]*?backfillCurrentChannel/, "Slash and context-menu triggers must share validation and pipeline execution");
  assertMatches(plugin, /Alerts\.show\(\{[\s\S]*?title:[\s\S]*?body:\s*result\.message/, "Backfill completion and failure feedback must use a local-only alert");
  if (/sendBotMessage|sendMessage|SEND_MESSAGES|Authorization\s*:|document\.elementFromPoint|dispatchEvent\(|MouseEvent\(|clientX|clientY|screenX|screenY/.test(`${plugin}\n${executionHelper}`))
    throw new Error("Backfill triggers must not send messages, require SEND_MESSAGES, add authorization, or automate UI coordinates");
  assertMatches(plugin, /if \(!settings\.store\.persistCreatedMessages\)[\s\S]*?getRequestedEventNames\(channelId\) == null/, "Persistence and catalog enforcement must remain inside the shared backfill pipeline");
  assertMatches(plugin, /const lease = backfillLifecycle\.begin\(channelId\)[\s\S]*?finally[\s\S]*?backfillLifecycle\.finish\(lease\)/, "Backfill must hold and release a per-channel lifecycle lease with try/finally");
  assertMatches(plugin, /backfillLifecycle\.start\(\);[\s\S]*?stop\(\)[\s\S]*?backfillLifecycle\.stop\(\);/, "Collector start and stop must advance the backfill lifecycle generation");
  assertMatches(plugin, /backfillLifecycle\.isCurrent\(lease\)/, "Backfill continuation checks must reject stale lifecycle generations");
  assertBefore(plugin, /!settings\.store\.persistCreatedMessages/, /RestAPI\.get\(/, "Created-message persistence must be required before the first backfill REST request");
  assertBefore(plugin, /getRequestedEventNames\(channelId\) == null/, /RestAPI\.get\(/, "Backfill scope must be rejected before the first REST request");
  assertMatches(plugin, /RestAPI\.get\(\{[\s\S]*?Constants\.Endpoints\.MESSAGES\(channelId\)[\s\S]*?query:\s*\{\s*limit,\s*\.\.\.\(before \? \{ before \} : \{\}\)\s*\}[\s\S]*?retries:\s*2/, "Backfill must use bounded Vencord RestAPI message pagination with retries=2");
  assertMatches(plugin, /"ok" in response[\s\S]*?response\.ok !== true[\s\S]*?throw new Error\("Discord history request failed\."\)/, "Backfill must reject non-success REST responses before reading their body");
  assertMatches(plugin, /message\.channel_id === channelId[\s\S]*?Date\.parse\(message\.timestamp\)/, "Backfill must validate channel identity and parseable timestamps before persistence");
  assertMatches(plugin, /fetchAndPrepareBackfill\([\s\S]*?cleanupMessage[\s\S]*?shouldIgnore\(\{[\s\S]*?isCachedByUs:\s*true/, "Backfill must normalize the complete batch and apply live CREATED privacy filtering before persistence");
  assertMatches(plugin, /`ignored=\$\{ignored\}`/, "Backfill result must report ignored entries");
  assertMatches(plugin, /const oldestFirst = result\.entries\.slice\(\)\.reverse\(\);[\s\S]*?persistHistoricalCreatedMessages\(\s*oldestFirst/, "Backfill must reverse the complete prepared result exactly once before persistence");
  assertMatches(db, /created_journaled\?: true/, "IndexedDB records must expose an optional CREATED-journal completion marker");
  assertMatches(db, /hasCreatedEventIDB\([\s\S]*?created_journaled === true/, "CREATED dedupe must use the explicit journal marker");
  assertMatches(db, /markCreatedEventIDB\([\s\S]*?existing == null[\s\S]*?created_journaled: true[\s\S]*?\.\.\.existing, created_journaled: true/, "Marking CREATED success must preserve existing lifecycle records and statuses");
  if (/hasMessageIDB/.test(manager))
    throw new Error("Generic message existence must not be used as proof of CREATED journal success");
  assertMatches(manager, /const persistenceCoordinator = createMessagePersistenceCoordinator\(\)/, "All lifecycle writes must share the message-ID persistence coordinator");
  if (/Failed to append (?:CREATED )?message event",\s*(?:error|cause|response)/.test(manager))
    throw new Error("Lifecycle append failures must not log raw exception or response objects");
  assertMatches(manager, /created_event_append_failed/, "CREATED append failures must log only a fixed error code");
  assertMatches(manager, /lifecycle_event_append_failed/, "Lifecycle append failures must log only a fixed error code");
  assertMatches(manager, /if \(status === DBMessageStatus\.CREATED\)[\s\S]*?commitCreatedMessage\(finalMessage, finalMessage\.timestamp/, "Live CREATED must use the shared deterministic CREATED commit primitive");
  assertMatches(manager, /persistHistoricalCreatedMessages\([\s\S]*?commitCreatedMessage\(message, capturedAt, shouldContinue, false\)/, "Historical CREATED must use the same commit primitive with original timestamps");
  assertMatches(manager, /persistenceCoordinator\.runExclusive\(finalMessage\.id[\s\S]*?addMessageIDB\(finalMessage, status\)/, "Non-CREATED lifecycle writes must use the same per-ID coordinator");
  assertBefore(coordinatorHelper, /appendCreated\(\)/, /markCreatedEvent\(\)/, "CREATED append must complete before the journal marker is stored");
  const historicalCreated = manager.match(/export async function persistHistoricalCreatedMessages\(([\s\S]*)/);
  if (historicalCreated == null)
    throw new Error("Historical CREATED persistence export is required");
  const newBackfillCode = `${backfillHelper}\n${lifecycleHelper}\n${preparationHelper}\n${executionHelper}\n${coordinatorHelper}\n${plugin.slice(0, plugin.indexOf("const cacheThing"))}\n${historicalCreated[0]}`;
  if (/@ts-ignore|@ts-expect-error|\bas any\b/.test(newBackfillCode))
    throw new Error("Backfill implementation must not contain type suppressions or any casts");

  await assertBackfillPaginationHelper(backfillHelper);
  await assertBackfillLifecycleHelper(lifecycleHelper);
  await assertBackfillPreparationHelper(preparationHelper);
  await assertBackfillExecutionHelper(executionHelper);
  await assertMessagePersistenceCoordinator(coordinatorHelper);

  if (/Failed to refresh channel catalog",\s*(?:error|cause|response)/.test(catalog))
    throw new Error("Catalog refresh failures must not log raw exception or response objects");
  assertMatches(catalog, /channel_catalog_refresh_failed/, "Catalog refresh failures must log only a fixed error code");
  if (/Failed to clean up channel catalog temporary file",\s*(?:cleanupError|error|cause)/.test(native))
    throw new Error("Catalog cleanup failures must not log raw exception objects");
  assertMatches(native, /channel_catalog_temp_cleanup_failed/, "Catalog cleanup failures must log only a fixed error code");

  const helperModule = await loadTypeScriptHelper(clearHelper);
  const clearAllLocalLogs = helperModule.clearAllLocalLogs;
  if (typeof clearAllLocalLogs !== "function")
    throw new Error("Shared Clear All helper must export clearAllLocalLogs");

  for (const failingOperation of ["idb", "native"]) {
    const attempted = { idb: false, native: false };
    try {
      await clearAllLocalLogs(
        async () => {
          attempted.idb = true;
          if (failingOperation === "idb") throw new Error("IDB clear failed");
        },
        async () => {
          attempted.native = true;
          if (failingOperation === "native") throw new Error("Native clear failed");
        }
      );
      throw new Error(`Shared Clear All helper did not reject when ${failingOperation} clearing failed`);
    } catch (error) {
      if (!(error instanceof AggregateError) || error.errors.length !== 1)
        throw new Error("Shared Clear All helper must throw an AggregateError after a partial failure", { cause: error });
    }
    if (!attempted.idb || !attempted.native)
      throw new Error("Shared Clear All helper must attempt both operations despite either failure");
  }
}

async function buildVencord(tempRoot) {
  const buildRoot = path.join(tempRoot, "Vencord");
  await git(tempRoot, "clone", "--quiet", "--no-hardlinks", "--no-checkout", await realpath(vencordPath), buildRoot);
  await git(buildRoot, "checkout", "--quiet", expectedVencordCommit);
  const pluginRoot = path.join(buildRoot, "src", "userplugins", "messageLoggerEnhanced");
  await mkdir(path.dirname(pluginRoot), { recursive: true });
  await git(path.dirname(pluginRoot), "clone", "--quiet", "--no-hardlinks", "--no-checkout", await realpath(sourcePath), pluginRoot);
  await git(pluginRoot, "checkout", "--quiet", expectedMleCommit);
  await git(pluginRoot, "apply", patchPath);
  await run("pnpm", ["install", "--frozen-lockfile"], buildRoot);
  await run("pnpm", ["build"], buildRoot);
}

async function main() {
  const patch = await readFile(patchPath, "utf8");
  if (patch.includes("\r"))
    throw new Error("Canonical patch must use LF line endings only");
  const paths = patchedPaths(patch);
  await assertDirectory(sourcePath, "MessageLoggerEnhanced source repository");
  await assertDirectory(vencordPath, "Vencord fixture");
  await assertCommit(sourcePath, expectedMleCommit, "MLE source repository");
  await assertCommit(vencordPath, expectedVencordCommit, "Vencord fixture");
  if (reviewedFixturePath != null) {
    await assertDirectory(reviewedFixturePath, "Reviewed patched fixture");
    await assertCommit(reviewedFixturePath, expectedMleCommit, "Reviewed patched fixture base");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "bridge-collector-patch-"));
  try {
    const cleanMle = path.join(tempRoot, "messageLoggerEnhanced");
    await git(tempRoot, "clone", "--quiet", "--no-hardlinks", "--no-checkout", await realpath(sourcePath), cleanMle);
    await git(cleanMle, "checkout", "--quiet", expectedMleCommit);
    await git(cleanMle, "apply", "--check", patchPath);
    await git(cleanMle, "apply", patchPath);
    await assertUpdaterRemoved(cleanMle);
    await assertCollectorSemantics(cleanMle);
    if (reviewedFixturePath != null)
      await comparePatchedTrees(cleanMle, reviewedFixturePath, paths);
    if (runVencordBuild)
      await buildVencord(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`Verified collector patch against clean source ${expectedMleCommit}${reviewedFixturePath != null ? " and matched the reviewed patched fixture" : ""}${runVencordBuild ? " and built pinned Vencord" : ""}.`);
}

await main();
