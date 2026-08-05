# Vencord Collector Patch

`message-logger-enhanced-collector.patch` turns the upstream `MessageLoggerEnhanced` plugin into the local event source required by this bridge.

The patch:

- Persists `CREATED`, `EDITED`, `DELETED`, and `GHOST_PINGED` events.
- Adds a permission-independent **Backfill History** submenu to static Vencord channel and thread context menus, with fixed choices 100, 500, 1000, and 5000 targeting the right-clicked `channel.id`; this is the primary path for read-only channels and uses local-only Vencord feedback.
- Keeps `/backfillmessages [count]` as an optional secondary trigger when a composer is available, with integer count defaulting to 100 and rejected outside 1-5000. Both triggers share validation, result mapping, and the existing pipeline.
- Requires `persistCreatedMessages=true` and the target channel to be in the active catalog scope inside the backfill pipeline before any REST request; disabling it, scope revocation, or plugin stop interrupts further appends. A lifecycle generation lease permanently invalidates an old request across stop/start, so it cannot resume after the plugin restarts.
- Fetches sequential Vencord `RestAPI` pages of at most 100 using the oldest raw-page ID as a deterministic `before` cursor, examines at most the requested count, rejects malformed/non-advancing pagination, and deduplicates overlapping IDs without mutating response pages.
- Validates and normalizes the complete fetched batch before persistence, then applies the same `shouldIgnore` bot/self/blacklist/whitelist/mute/server-cache/ephemeral privacy rules as live CREATED collection. Ignored entries are reported and receive no NDJSON or IndexedDB write.
- Reverses the prepared result once and persists it sequentially oldest-first within that backfill subsequence only; it does not reorder the journal or establish global chronology.
- Coordinates every lifecycle write by message ID. The optional `created_journaled` IndexedDB marker means the CREATED journal append completed; an arbitrary IDB record or status does not. Historical writes append deterministic NDJSON using the original API timestamp before marking/storing IndexedDB while preserving existing EDITED/DELETED/GHOST_PINGED status and payload, leaving an intentional at-least-once crash window rather than claiming durable exactly-once delivery.
- Writes one validated event per line to `message-events.ndjson`.
- Requires a successfully resolved `channel-catalog.request.json` scope as the mandatory NDJSON allowlist; absent and out-of-scope channels are denied before native append.
- Normalizes both Discord `Embed` class objects and API `EmbedJSON` payloads so card text, fields, links, single or multi-image media, thumbnails, and proxy URLs survive collection.
- Recovers class-only camelCase `messageSnapshots`, Components V2, and `poll` values that `toJS()` can omit, while preserving snake_case API `message_snapshots`. Snapshot content recursively retains only bounded visible content, embeds, components, attachments, stickers, and poll data; Components V2 retains semantic labels/content, nested structures, accessories, and media URLs without treating `custom_id` as message text; poll normalization retains question and answer text.
- Applies explicit depth, count, and string limits to these modern visible structures and rebuilds them from allowlisted JSON-safe scalar fields, excluding functions, interaction tokens, `custom_id`, and internal client objects. Components V2 uses one shared node and text budget across the root message and all snapshots, including `components`, `items`, `options`, and `accessory`, so branching cannot multiply local limits.
- Bounds every embed normalization path, including snapshot embeds, with capped embed/image/field counts and capped title, description, provider, footer, author, field, media-description, and URL strings.
- Clones traditional message fields with a bounded, cycle-aware JSON-safe walker instead of serializing an unrestricted class object. Reply cleanup keeps the public API unchanged while sharing seen state and enforcing a maximum reply depth, cutting self/mutual cycles and deep chains safely while retaining privacy stripping.
- Serializes file writes and rotates the active log at 100 MiB.
- Resolves optional channel and guild names for admitted channels from Discord's in-process stores without reading user tokens or message caches.
- Supports a fixed-path, bounded `channel-catalog.request.json` protocol for selected channels or all message-capable channels in one explicitly requested guild.
- Treats an empty requested guild catalog as valid, revokes the previous in-memory scope before every refresh, and fails closed across read/store/write errors until a later refresh succeeds.
- Writes catalog results atomically to `channel-catalog.result.json`; it never enumerates other guilds.
- Waits for IndexedDB initialization before storing events.
- Handles bulk deletions through the same lifecycle event path.
- Defaults to disabled plugin activation, disabled created-message persistence, and disabled broad server-message caching for new installations while preserving persisted settings.
- Keeps attachment downloads disabled by default.
- Adds **Clear All Local Logs**, which awaits IndexedDB clearing and serialized, idempotent deletion of `message-events.ndjson` plus `.1`; a running Bridge must be restarted separately to clear its replay buffer.
- Keeps visible-only clearing limited to currently visible IndexedDB records and labels it accordingly.
- Removes the third-party plugin updater and pins installation to reviewed source.
- Migrates the plugin to the current Vencord modal API and removes unsafe type suppressions.
- Includes `BRIDGE_PATCH_NOTICE.md` with modifier `SeaL773`, latest modification date `2026-08-05`, affected paths, and purpose while preserving upstream notices.

Apply the patch only to the exact upstream commit documented in the root README. Create an explicit request before enabling collection. Requests are read at plugin start or Discord reconnect, not polled; after creating one while connected, re-enable the plugin or restart Discord. Invalid or failed refreshes do not widen scope. Review the diff before building and injecting Vencord.

Recommended selected-channel request schema:

```json
{"schema_version":1,"request_id":"<UUID>","guild_id":"<17-20 digit guild ID>","mode":"selected_channels","channel_ids":["<17-20 digit channel ID>"]}
```

Broader all-text-channels schema:

```json
{"schema_version":1,"request_id":"<UUID>","guild_id":"<17-20 digit guild ID>","mode":"guild_text_channels"}
```

Generate requests offline with `node scripts/create-channel-catalog-request.mjs --guild <guild-id> --channel <channel-id> --output <path>`. Repeat `--channel` for up to 64 unique channels, or use the mutually exclusive `--all-text-channels`. Replacing the request requires plugin re-enable, Discord reconnect, or Discord restart before the new scope is active.

Run `pnpm verify:collector-patch -- --mle-fixture <clean-source-path> --vencord <path>` from the Bridge repository. The verifier clones the pinned clean MLE source, applies the patch in a temporary tree, and then verifies canonical LF form, semantics, and clean applicability. Add `--vencord-build` for a temporary full Vencord build. Maintainers can add `--reviewed-fixture <patched-fixture-path>` to compare the complete changed-path set and resulting file contents, including deletions, with a separately reviewed patched worktree.

The upstream repositories, their licenses, the 2026-07-20, 2026-07-24, and 2026-08-05 SeaL773 modifications, and distribution obligations are documented in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) at the repository root. The `BRIDGE_PATCH_NOTICE.md` embedded in the patch (applied to the Vencord working tree) is the per-file modification manifest; it does not replace the upstream `LICENSE` or source-file notices.
