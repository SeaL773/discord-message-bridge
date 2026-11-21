# Discord Message Bridge

Local-only REST/WebSocket bridge for the Vencord `MessageLoggerEnhanced` NDJSON integration. It tails the plugin-owned file without modifying it, validates supported events, deduplicates them, retains a configurable in-memory replay window, and broadcasts newly appended events.

This project is the middle component in an optional open-source pipeline:

```text
Vencord collector -> Discord Message Bridge -> discord-tg-forwarder -> Telegram
```

For the downstream Telegram consumer and complete deployment runbook, see
[`SeaL773/discord-telegram-forwarder`](https://github.com/SeaL773/discord-telegram-forwarder).

## Requirements

- Windows with Discord and the patched Vencord `MessageLoggerEnhanced` collector described below.
- Node.js 20 or newer.
- pnpm.

Discord must be running for new events to be captured. The bridge does not connect to Discord, extract user tokens, or call Discord APIs.

> [!WARNING]
> Vencord is an unofficial Discord client modification. Using client modifications may violate Discord's Terms of Service. Review the collector patch before installing it and use it at your own risk.

## Data scope and consent

The reviewed collector patch is opt-in and privacy-safe for new installations. The plugin is disabled by default; created-message persistence and broad server-message caching also default to disabled. Attachment downloads remain disabled. Existing persisted Vencord settings remain usable after upgrading.

NDJSON collection additionally requires a successfully resolved `channel-catalog.request.json` active scope. Channels outside that scope, or all channels when no valid scope is active, are denied before the plugin calls the native append API. IndexedDB behavior remains controlled by the plugin's own settings and is not gated by this Bridge allowlist. Collected in-scope payloads can include message text, author/channel/guild identifiers, edits, deleted-message content, embeds, attachment URLs, and reply metadata. Enable and scope the collector only for accounts and communities where you are authorized to collect this information. A downstream Forwarder `default_action: drop` prevents forwarding; it does not widen or replace collector-side consent.

## Install the Vencord collector

The bridge consumes an NDJSON file produced by a patched version of `MessageLoggerEnhanced`. The reproducible patch is included at `patches/message-logger-enhanced-collector.patch`.

The patch is based on:

- Vencord commit `ce9355e9a93e369c7295fa162ad563f7f97b1ff7`
- `Syncxv/vc-message-logger-enhanced` commit `ea339bc09d7415ad0f715d60b80ba89ba2d685fa`

From a Windows terminal:

```powershell
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
git checkout ce9355e9a93e369c7295fa162ad563f7f97b1ff7

git clone https://github.com/Syncxv/vc-message-logger-enhanced.git src/userplugins/messageLoggerEnhanced
cd src/userplugins/messageLoggerEnhanced
git checkout ea339bc09d7415ad0f715d60b80ba89ba2d685fa
git apply C:\path\to\discord-message-bridge\patches\message-logger-enhanced-collector.patch
cd ..\..\..

pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Select Discord Stable when prompted, then restart Discord. Before enabling the collector, create the explicit catalog request described below. Then enable `MessageLoggerEnhanced`; allowed message lifecycle events are written to:

```text
%APPDATA%\Vencord\MessageLoggerData\message-events.ndjson
```

When explicitly enabled through persisted plugin settings, the collector can persist new, edited, deleted, and ghost-pinged messages. Only events admitted by the active catalog scope are appended to NDJSON. Writes are serialized and the log rotates at 100 MiB. Attachment downloads are disabled by default. See `patches/README.md` for patch details.

The primary history workflow, especially for read-only channels, is to right-click an allowlisted channel or thread and choose **Backfill History**, then select exactly `100`, `500`, `1000`, or `5000`. This static Vencord context menu targets the channel object that was right-clicked and does not require a message composer or `SEND_MESSAGES` permission. Result/error feedback stays local in Vencord and does not send a Discord message. The optional `/backfillmessages [count]` command remains available when a composer is accessible; `count` defaults to `100` and must be an integer from `1` through `5000`, with invalid values rejected rather than clamped. Both triggers use the same validation and backfill pipeline.

`persistCreatedMessages` must be enabled and the target channel must already be admitted by the active channel-catalog allowlist, or backfill makes no Discord REST request. These checks remain inside the execution pipeline, so stale menus or revoked scope cannot bypass them. The collector uses Vencord's authenticated `RestAPI` context, examines at most `count` newest API history entries in sequential pages of at most 100, follows a deterministic `before` cursor from the oldest ID in each raw page, globally deduplicates overlapping IDs, and validates and normalizes the complete fetched batch before writing anything. It then applies the same `shouldIgnore` privacy rules as live CREATED collection, including bot/self filters, user/channel/guild blacklist and whitelist precedence, muted guild/category/channel rules, server-cache restrictions, and ephemeral-message exclusion. Ignored entries are reported and receive no NDJSON or IndexedDB write.

After a successful full-batch normalization and privacy pass, the remaining unique subsequence is reversed once and persisted sequentially oldest-first. This ordering applies **only within that backfill subsequence**; it does not sort the existing journal and does not claim global NDJSON chronology. All lifecycle writes for one message share a per-message-ID coordinator, while different IDs remain concurrent. An optional IndexedDB `created_journaled` marker represents successful completion of that message's CREATED journal append; arbitrary CREATED, EDITED, DELETED, or GHOST_PINGED record existence is not equivalent to that marker. Historical collection appends deterministic NDJSON first with `captured_at` equal to Discord's original message `timestamp`, then marks/stores IndexedDB while preserving any later lifecycle status and payload. Consequently, a crash after NDJSON append but before marker storage leaves an intentional at-least-once NDJSON retry window; cursor deduplication can suppress an identical retry while its cursor remains buffered, but durable exactly-once delivery is not guaranteed. Only one backfill per channel runs at a time, and plugin stop, disabling created-message persistence, or allowlist revocation interrupts further appends without cancelling an already issued HTTP request.

The plugin's **Clear All Local Logs** operation awaits deletion of its IndexedDB records and both integration files, `message-events.ndjson` and `message-events.ndjson.1`. File deletion is serialized behind pending integration writes and is idempotent. If the Bridge is running, restart the Bridge afterward to clear its in-memory replay buffer. This operation does not erase downstream state, dead letters, Telegram messages, backups, or synchronized copies. **Clear Visible IndexedDB Logs** affects only the currently visible IndexedDB records and intentionally leaves both NDJSON journals unchanged.

The patched collector requires a bounded `channel-catalog.request.json` in `MessageLoggerData` as its NDJSON collection allowlist. A request targets exactly one guild and either explicit channel IDs or `mode: guild_text_channels`; an empty guild catalog is valid but permits no NDJSON events. The renderer resolves only that scope from Discord's in-process stores and atomically writes `channel-catalog.result.json`. Optional channel and guild names enrich admitted events. No Discord token, HTTP API, message body, or other guild catalog is read for this operation.

Use the offline generator rather than hand-editing request files. `selected_channels` is recommended because it grants the narrowest scope:

```powershell
node .\scripts\create-channel-catalog-request.mjs --guild $env:DISCORD_GUILD_ID --channel $env:DISCORD_CHANNEL_ID_A --channel $env:DISCORD_CHANNEL_ID_B --output "$env:APPDATA\Vencord\MessageLoggerData\channel-catalog.request.json"
```

```sh
node ./scripts/create-channel-catalog-request.mjs --guild "$DISCORD_GUILD_ID" --channel "$DISCORD_CHANNEL_ID_A" --channel "$DISCORD_CHANNEL_ID_B" --output "$HOME/.config/Vencord/MessageLoggerData/channel-catalog.request.json"
```

To request all message-capable text channels in one guild, replace all `--channel` arguments with `--all-text-channels`. The generator accepts exactly one 17–20 digit guild ID, either 1–64 unique 17–20 digit channel IDs or `--all-text-channels`, and an explicit output path. It uses no Discord token or API and atomically replaces only the specified output file.

Selected-channel request schema:

```json
{
  "schema_version": 1,
  "request_id": "00000000-0000-4000-8000-000000000000",
  "guild_id": "<DISCORD_GUILD_ID>",
  "mode": "selected_channels",
  "channel_ids": ["<DISCORD_CHANNEL_ID_A>", "<DISCORD_CHANNEL_ID_B>"]
}
```

All-text-channels request schema:

```json
{
  "schema_version": 1,
  "request_id": "00000000-0000-4000-8000-000000000000",
  "guild_id": "<DISCORD_GUILD_ID>",
  "mode": "guild_text_channels"
}
```

The collector checks the request when the plugin starts and when Discord dispatches `CONNECTION_OPEN`; it does not poll the file. Create or atomically replace the request before starting/reconnecting. Replacing a request while connected requires disabling and re-enabling `MessageLoggerEnhanced`, reconnecting Discord, or restarting Discord before the new scope becomes active. Every refresh synchronously revokes the previous in-memory scope before reading or resolving the request. A failed refresh is logged and leaves collection denied until a later refresh succeeds; removing the request and then triggering a refresh also leaves the scope empty.

## Install and run

```powershell
pnpm install
pnpm build
pnpm start
```

Alternatively, double-click `start-bridge.cmd`.

Defaults:

- Event file: `%APPDATA%\Vencord\MessageLoggerData\message-events.ndjson`
- Listen address: `127.0.0.1:17891`
- Token file: `%APPDATA%\Vencord\MessageLoggerData\bridge-token.txt`
- Replay buffer: 10,000 events
- Poll interval: 250 ms

On first run the bridge creates a random 32-byte base64url bearer token. It prints only the token file path, never the token itself. Keep this file private.

Environment overrides:

| Variable | Purpose |
| --- | --- |
| `DISCORD_BRIDGE_EVENT_PATH` | Active NDJSON file path |
| `DISCORD_BRIDGE_HOST` | Bind host; defaults to loopback |
| `DISCORD_BRIDGE_PORT` | TCP port |
| `DISCORD_BRIDGE_TOKEN_PATH` | Token file path |
| `DISCORD_BRIDGE_BUFFER_SIZE` | In-memory event count |
| `DISCORD_BRIDGE_POLL_MS` | Poll interval in milliseconds |

## API

### `GET /v1/health`

Unauthenticated and intentionally contains no file paths, tokens, message data, or error text. It reports whether the tailer is running, whether recent polls have succeeded, and non-sensitive ages for the last successful poll and last read progress. A quiet event file remains healthy as long as polling succeeds.

```json
{"status":"ok","consecutive_poll_errors":0,"last_successful_poll_age_ms":12,"last_read_progress_age_ms":null}
```

### `GET /v1/events?after=<cursor>&limit=<n>`

Requires `Authorization: Bearer <token>`. `limit` defaults to 100 and must be 1–500. With no `after`, the newest events up to the limit are returned. With `after`, events following that cursor are returned. A cursor no longer in the ring buffer returns HTTP 409 with `cursor_expired`.

```powershell
$token = (Get-Content "$env:APPDATA\Vencord\MessageLoggerData\bridge-token.txt" -Raw).Trim()
curl.exe -H "Authorization: Bearer $token" "http://127.0.0.1:17891/v1/events?limit=100"
```

Response fields distinguish the page checkpoint from the global newest buffered event:

- `next_cursor`: last event returned, or the supplied `after` cursor when the page is empty. Use this for the next request.
- `has_more`: whether another forward page currently exists.
- `buffer_latest_cursor`: newest cursor in the ring buffer when the page was produced. Do not use it as a pagination checkpoint.

With no `after`, the endpoint retains snapshot-style behavior: it returns the newest `limit` events and `has_more` is always `false`.

```json
{"events":[{"type":"event","cursor":"...","event":{}}],"next_cursor":"...","has_more":false,"buffer_latest_cursor":"..."}
```

### WebSocket `/v1/events`

Requires the bearer token in the `Authorization` header. Query-string tokens are not supported. The server first sends:

```json
{"type":"ready","latest_cursor":"..."}
```

It then broadcasts each newly tailed envelope. Use REST after reconnecting to replay events after the last cursor, repeatedly requesting with `after=next_cursor` while `has_more` is true. See `examples/node-client.mjs`:

```powershell
node .\examples\node-client.mjs
```

## Event and cursor behavior

Supported input events have `schema_version: 1`, one of `CREATED`, `EDITED`, `DELETED`, or `GHOST_PINGED`, an ISO timestamp, and string `message.id` and `message.channel_id`. Unknown fields are preserved; invalid lines and unsupported schemas are ignored.

The cursor is a stable base64url SHA-256 digest of schema version, event type, capture timestamp, and message ID. Delivery is at-least-once at the file boundary; cursor deduplication prevents duplicate envelopes while the cursor remains in the ring buffer.

At startup, the bridge first opens and retains the active file handle and snapshots its size from that handle. It then preloads up to 8 MiB of complete recent lines from `message-events.ndjson.1` and the retained active handle without WebSocket broadcasts. Appends after the snapshot are consumed by the first poll. During operation it retains that same active handle across polls, preserves partial UTF-8 lines, detects truncation and path replacement, drains the old retained handle to its current handle-reported size, closes it, and only then adopts the newly opened active handle. This avoids advancing an old offset by reading a different path identity.

## Development

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm verify:collector-patch -- --mle-fixture /path/to/clean/vc-message-logger-enhanced --vencord /path/to/Vencord --vencord-build
```

Tests use only temporary files and ephemeral loopback ports. The bridge never reads real event data during tests.

The patch verifier requires explicit clean MessageLoggerEnhanced and Vencord repositories pinned to the documented commits. It clones both inputs into a temporary directory, applies the canonical patch there, runs semantic checks, and optionally performs a full Vencord build. `MLE_FIXTURE_PATH` and `VENCORD_PATH` are supported as environment-variable alternatives to the command-line paths.

PowerShell:

```powershell
pnpm verify:collector-patch -- --mle-fixture C:\src\vc-message-logger-enhanced-clean --vencord C:\src\Vencord --vencord-build
```

## Downstream consumers

[`discord-tg-forwarder`](https://github.com/SeaL773/discord-telegram-forwarder) is the reference downstream consumer. It connects to this Bridge over authenticated REST/WebSocket, applies administrator-defined routing rules, and delivers matching events to Telegram with durable cursor recovery, bounded media handling, rate limiting, and dead letters.

The Bridge API is not Telegram-specific. Custom consumers can use the same authenticated `/v1/events` REST and WebSocket endpoints; see [`examples/node-client.mjs`](examples/node-client.mjs) for a minimal client.

## Security and networking

- REST and WebSocket event endpoints require a random 256-bit bearer token stored under the current user's `%APPDATA%` directory. On Unix-like filesystems the token is created with mode `0600`; Windows users must also rely on appropriate account and directory ACLs.
- The bridge binds to `127.0.0.1` by default and does not enable CORS.
- Do not expose the default plain HTTP/WebSocket endpoint to a LAN or the public internet. If remote access is unavoidable, use an authenticated VPN/SSH tunnel or a correctly configured TLS reverse proxy rather than changing the bind address alone.
- If the bearer token may have been disclosed, stop the Bridge, delete `bridge-token.txt`, and restart it to generate a replacement; update every client before resuming forwarding.
- Native Windows programs can use `127.0.0.1` directly. WSL2 in NAT mode cannot reach Windows loopback without additional Windows networking configuration.
- Event payloads contain private message data. Keep the event log, token file, and all downstream storage private.

## License, attribution, and third-party code

This repository is released under the **GNU General Public License v3.0 or later (GPL-3.0-or-later)**. The full license text is in the root [`LICENSE`](LICENSE) file.

The collector patch modifies [`Syncxv/vc-message-logger-enhanced`](https://github.com/Syncxv/vc-message-logger-enhanced) at commit `ea339bc09d7415ad0f715d60b80ba89ba2d685fa`. That project and [`Vendicated/Vencord`](https://github.com/Vendicated/Vencord) are GPL-3.0-or-later licensed. The patch is a modified source version and remains subject to GPL-3.0-or-later. Upstream repositories, their licenses, the 2026-07-20, 2026-07-24, 2026-08-05, 2026-08-13, and 2026-11-21 SeaL773 modifications, affected paths, source/build verification, and distribution obligations are documented in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Patch-level details are in [`patches/README.md`](patches/README.md).

Before redistributing this repository or compiled Vencord artifacts that include the patched plugin, preserve upstream copyright and license notices, identify your modifications and their date, and provide the corresponding source and build instructions required for the form you distribute. See `THIRD_PARTY_NOTICES.md` section 7 for the full checklist. This is a practical distribution guide, not legal advice.

Vencord, the collector, and this project are not affiliated with or endorsed by Discord.
