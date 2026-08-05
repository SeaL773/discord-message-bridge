# Third-Party Notices and Modification Manifest

This repository contains independently written Bridge code and a source patch
(`patches/message-logger-enhanced-collector.patch`) that modifies GPL-licensed
upstream software. This document identifies the upstream components, their
licenses, the modifications made, and the relationship between them.

---

## 1. Vendicated/Vencord

**Repository:** https://github.com/Vendicated/Vencord  
**Pinned commit:** `4b9c27d905d6255141617546227a56073916ebd4`
**License:** GNU General Public License v3.0 or later (GPL-3.0-or-later)  
**License text:** https://github.com/Vendicated/Vencord/blob/main/LICENSE

Vencord is the host client modification framework into which the patched plugin
is built and injected. The patch is applied inside a Vencord source tree at the
pinned commit above. No Vencord source files are included in this repository;
the patch references Vencord only as the build host.

---

## 2. Syncxv/vc-message-logger-enhanced

**Repository:** https://github.com/Syncxv/vc-message-logger-enhanced  
**Pinned commit:** `ea339bc09d7415ad0f715d60b80ba89ba2d685fa`  
**License:** GNU General Public License v3.0 or later (GPL-3.0-or-later)  
**License text:** https://github.com/Syncxv/vc-message-logger-enhanced/blob/master/LICENSE

`vc-message-logger-enhanced` (MessageLoggerEnhanced) is the upstream Vencord
user-plugin that the collector patch modifies. No upstream source files are
included verbatim in this repository. The patch file
(`patches/message-logger-enhanced-collector.patch`) is a diff against the
pinned upstream commit and constitutes a modified source version of that
GPL-3.0-or-later work.

---

## 3. SeaL773 Modifications (2026-07-20, updated 2026-07-24)

**Modifier:** SeaL773  
**Modification dates:** 2026-07-20 and 2026-07-24
**Canonical patch path:** `patches/message-logger-enhanced-collector.patch`  
**Patch manifest:** `BRIDGE_PATCH_NOTICE.md` (embedded in the patch, applied to
the Vencord working tree)

### Summary of modifications

The patch adapts the upstream MessageLoggerEnhanced plugin into a reviewed,
local-only Bridge collector. Key changes:

- Persists `CREATED`, `EDITED`, `DELETED`, and `GHOST_PINGED` events to an
  NDJSON integration journal.
- Adds permission-independent channel/thread context-menu history collection for
  the explicitly right-clicked allowlisted channel with fixed 100/500/1000/5000
  choices and local-only feedback. The optional `/backfillmessages [count]`
  trigger shares strict 1-5000 validation, bounded deterministic Vencord REST
  pagination, required created-message opt-in, complete batch normalization,
  existing MessageLogger privacy filtering, and per-channel concurrency exclusion.
- Coordinates all lifecycle writes per message ID and records CREATED-journal
  completion with an optional IndexedDB marker that is distinct from arbitrary
  record existence or status. Historical collection writes deterministic NDJSON
  using the original API timestamp before marker storage while preserving later
  lifecycle state, retaining an explicit at-least-once crash window without
  claiming global chronology or durable exactly-once delivery.
- Requires a successfully resolved `channel-catalog.request.json` scope as a
  mandatory allowlist; channels outside that scope are denied before any native
  append call.
- Serializes file writes and rotates the active journal at 100 MiB.
- Resolves optional channel and guild names from Discord's in-process stores
  without reading user tokens or message caches.
- Adds **Clear All Local Logs**, whose shared helper independently starts and
  settles IndexedDB clearing plus serialized, idempotent deletion of both
  NDJSON journals, aggregating failures only after both attempts finish.
- Defaults to disabled plugin activation, disabled created-message persistence,
  and disabled broad server-message caching for new installations while
  preserving existing persisted settings.
- Keeps attachment downloads disabled by default.
- Removes the third-party plugin updater and pins installation to reviewed
  source.
- Migrates the plugin to the current Vencord modal API and removes unsafe type
  suppressions.
- Normalizes Discord `Embed` class objects and API `EmbedJSON` payloads for
  consistent collection.
- Adds `BRIDGE_PATCH_NOTICE.md` inside the patched tree with modifier, date,
  affected paths, and purpose while preserving all upstream copyright and
  license notices.

### Affected paths (relative to the plugin directory)

- `BRIDGE_PATCH_NOTICE.md` (added)
- `LoggedMessageManager.ts`
- `backfillExecution.ts` (added)
- `backfillLifecycle.ts` (added)
- `backfillPreparation.ts` (added)
- `backfillPagination.ts` (added)
- `channelCatalog.ts`
- `components/LogsModal.tsx`
- `components/UpdaterModal.tsx` (removed)
- `db.ts`
- `index.tsx`
- `messagePersistenceCoordinator.ts` (added)
- `native/index.ts`
- `native/updater.ts` (removed)
- `settings.tsx`
- `types.ts`
- `utils/cleanUp.ts`
- `utils/clearAllLocalLogs.ts` (added)
- `utils/idb/async-iterators.ts`
- `utils/idb/database-extras.ts`
- `utils/idb/wrap-idb-value.ts`
- `utils/misc.ts`
- `utils/native-file-system-adapter/types/src/adapters/sandbox.d.ts` (removed)
- `utils/parseQuery.ts`
- `utils/saveImage/ImageManager.ts`
- `utils/streamparser-json/tokenizer.ts`
- `utils/streamparser-json/tokenparser.ts`
- `utils/updater.tsx` (removed)

---

## 4. Source and Build Verification

The patch verifier (`pnpm verify:collector-patch`) checks:

- Pinned base commits for both Vencord and MessageLoggerEnhanced.
- LF-only canonical patch form.
- Clean apply against the pinned upstream tree.
- Collector semantic checks after patch application in a temporary tree.
- Optional complete changed-path and normalized content comparison with the
  separately reviewed patched fixture, including added and removed files.

Run with `--vencord-build` to additionally perform a temporary full Vencord
build from the pinned commit with locked dependencies.

Fixture paths have no implicit filesystem defaults. Supply
`--mle-fixture <clean-source-path>` and `--vencord <path>` explicitly;
`MLE_FIXTURE_PATH` and `VENCORD_PATH` are accepted only as environment
fallbacks. The MLE path is the pinned unpatched source repository. Optional
`--reviewed-fixture <patched-path>` or `MLE_REVIEWED_FIXTURE_PATH` enables the
maintainer-only changed-path and normalized-content comparison against a
separately reviewed patched worktree after the temporary clean-source patch has
passed semantic checks.

---

## 5. License Boundary

The collector patch (`patches/message-logger-enhanced-collector.patch`) is a
modified source version of GPL-3.0-or-later software and remains subject to
GPL-3.0-or-later. The independently written Bridge runtime code (everything
under `src/`, `scripts/`, `test/`, `examples/`, and the root configuration
files) is also released under GPL-3.0-or-later to maintain a consistent and
unambiguous license for the repository as a whole.

The full license text is in the root `LICENSE` file.

---

## 6. Non-Affiliation

This project is not affiliated with, endorsed by, or sponsored by Discord Inc.,
Vendicated, or Syncxv. "Discord", "Vencord", and "MessageLoggerEnhanced" are
used solely for identification of the upstream software components.

---

## 7. Distribution Obligations

Before redistributing this repository or any compiled Vencord artifacts that
include the patched plugin:

- Include the complete GPL-3.0-or-later license text (root `LICENSE`).
- Preserve all upstream copyright and license notices in the patched source
  files.
- Identify your modifications and their date (this document and
  `BRIDGE_PATCH_NOTICE.md` satisfy this for the 2026-07-20 and 2026-07-24 SeaL773 changes;
  add a new entry here for any further modifications).
- Provide the corresponding source and reproducible build instructions for every
  patch or compiled artifact you distribute, as required by GPL-3.0 section 6.

This is a practical distribution checklist, not legal advice.
