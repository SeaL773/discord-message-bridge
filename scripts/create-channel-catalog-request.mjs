import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function parseCatalogRequestArgs(argv) {
  let guildId;
  let output;
  let allTextChannels = false;
  const channelIds = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--all-text-channels") {
      if (allTextChannels) throw new Error("--all-text-channels may be specified only once");
      allTextChannels = true;
      continue;
    }
    if (argument !== "--guild" && argument !== "--channel" && argument !== "--output")
      throw new Error(`Unknown argument: ${argument}`);

    const value = argv[index + 1];
    if (value == null || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    index++;

    if (argument === "--guild") {
      if (guildId != null) throw new Error("--guild may be specified only once");
      guildId = value;
    } else if (argument === "--output") {
      if (output != null) throw new Error("--output may be specified only once");
      output = value;
    } else {
      channelIds.push(value);
    }
  }

  if (guildId == null) throw new Error("--guild <17-20 digit guild ID> is required");
  if (!SNOWFLAKE_PATTERN.test(guildId)) throw new Error("Guild ID must contain 17-20 digits");
  if (output == null || output.length === 0) throw new Error("--output <path> is required");
  if (allTextChannels && channelIds.length > 0)
    throw new Error("--channel and --all-text-channels are mutually exclusive");
  if (!allTextChannels && channelIds.length === 0)
    throw new Error("Specify 1-64 --channel IDs or --all-text-channels");
  if (channelIds.length > 64) throw new Error("At most 64 --channel IDs are allowed");
  if (!channelIds.every(channelId => SNOWFLAKE_PATTERN.test(channelId)))
    throw new Error("Every channel ID must contain 17-20 digits");
  if (new Set(channelIds).size !== channelIds.length)
    throw new Error("Duplicate --channel IDs are not allowed");

  return { guildId, output: path.resolve(output), allTextChannels, channelIds };
}

export function createCatalogRequest(options, requestId = randomUUID()) {
  return options.allTextChannels
    ? {
        schema_version: 1,
        request_id: requestId,
        guild_id: options.guildId,
        mode: "guild_text_channels"
      }
    : {
        schema_version: 1,
        request_id: requestId,
        guild_id: options.guildId,
        mode: "selected_channels",
        channel_ids: [...options.channelIds]
      };
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function writeCatalogRequestAtomic(outputPath, request) {
  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(request, null, 2)}\n`;
  let temporaryHandle;

  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(contents, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, outputPath);
    await syncDirectory(directory);
  } catch (error) {
    if (temporaryHandle != null) await temporaryHandle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(cleanupError => {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT"))
        throw cleanupError;
    });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCatalogRequestArgs(argv);
  const request = createCatalogRequest(options);
  await writeCatalogRequestAtomic(options.output, request);
  console.log(`Wrote channel catalog request to ${options.output}`);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
