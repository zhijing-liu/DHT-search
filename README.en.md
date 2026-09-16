# DHT Search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)

[简体中文](README.md) | **English**

A magnet link (torrent) search engine built on **SQLite FTS5 full-text search**, paired with a Vite + Tailwind web UI. The project does not include the DHT crawler itself — it only consumes an existing source database.

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configurationconfigjs)
- [Running](#running)
- [HTTP API](#http-api)
- [Architecture](#architecture)
- [Project Layout](#project-layout)
- [Keyword Blacklist](#keyword-blacklist)
- [Testing](#testing)
- [Operations Notes](#operations-notes)
- [RPC Push (aria2 / Motrix)](#rpc-push-aria2--motrix)
- [exe Usage Guide](#exe-usage-guide-beginner-friendly)
- [Data Source & Acknowledgements](#data-source--open-source-acknowledgements)
- [Disclaimer & License](#disclaimer--license)

## Features

- **Full-text search**: FTS5 fuzzy search over `name` / `files`, last-token prefix matching, case / diacritic folding.
- **Exact infohash lookup**: a 40-char hex (optionally with `urn:btih:` / `hash` prefix) switches to exact + prefix matching.
- **Sorting and filtering**: by fetched time / size / relevance (bm25), with byte-range size filters.
- **True server-side pagination**: paging and sorting always fetch a page from the backend; `total` stays consistent.
- **Two views**: search, and a "Library" view listing the newest entries by insertion order (paging only).
- **URL state sync**: the view lives in the hash (`#latest`), keywords / sort / filter / page in the query string; both are pushed to browser history and shareable.
- **Hot keyword ranking and suggestions**: tokens counted at index time (single chars, pure numbers and noise words dropped); suggestions tier by exact > prefix > contains > fuzzy.
- **Keyword blacklist**: maintained via seed script, HTTP API or the web UI (with import / export).
- **File tree**: fetched on demand by the detail dialog, with expand/collapse and keyword highlighting.
- **Search cache**: in-process LRU, byte-capped and TTL-expiring (default 32MB / 1h).
- **Shadow-DB rebuild + atomic swap**: rebuilds are written to a shadow DB by a child process and swapped in atomically; the live index keeps serving.
- **Runtime status**: the settings panel receives cache hits, memory, process count, indexed count, next sync time and maintenance progress over SSE.
- **Access control**: edge IP / CIDR whitelist (on by default) covering the whole site.
- **RPC push**: send magnet links to aria2 / Motrix from a result card.

## Quick Start

### Prerequisites

1. **Source DB**: `data/magnet.db` must exist and contain a `magnets` table (written by an external crawler); startup fails otherwise.
2. **Runtime** (either one):
   - **Node ≥ 20** (22 / 24 LTS recommended): needs the `better-sqlite3` native module, installed by `npm install`;
   - **Bun**: uses the built-in `bun:sqlite`, no native compilation. The root `bunfig.toml` is configured to skip `better-sqlite3`.

```bash
npm install                 # Node
# or
bun install                 # Bun
```

> `better-sqlite3` lives in `optionalDependencies` rather than `dependencies`: the Node path needs it, the Bun path does not.
> `bun install` **skips** it (no download, no native build) thanks to `optional = false` in `bunfig.toml`, while npm / pnpm install it by default.
> npm and Bun share the same `node_modules`, so after switching package managers, restore it with `npm install better-sqlite3`
> if Node reports that it cannot find `better-sqlite3`.

3. **Build the frontend** (once per deployment):

```bash
npm run build:web           # web/ → public/ (Vite + Tailwind)
```

## Configuration (`config.js`)

All settings live in `config.js` as individual `export const` values; restart the service after editing. Paths may be relative (to the repo root) or absolute.

| Item | Default | Description |
|--------|------|------|
| `SOURCE_DB_PATH` | `data/magnet.db` | Source DB path (contains the `magnets` table) |
| `INDEX_DB_PATH` | `data/dht.search.db` | Shadow index DB path |
| `PORT` | `3000` | HTTP service port |
| `WEB_BASE_PATH` | `'/dht'` | Deploy prefix of the frontend build: empty = site root; `/dht` suits reverse-proxy subpaths. Rebuild the frontend after changing |
| `MAX_RESULTS` | `2000` | Cap for a whole-set fetch (`limit=all`); excess marked `truncated` |
| `REINDEX_MAX_OLD_SPACE_MB` | `2048` | Heap cap (MB) of the index-maintenance child process: Node via `--max-old-space-size`; Bun adds `--smol` |
| `SEARCH_CACHE_MAX_SIZE_MB` | `32` | Search cache cap (MB); values are serialized JSON strings |
| `SEARCH_CACHE_TTL_MS` | `3600000` | Search cache TTL (ms) |
| `SEARCH_MAX_PROCESSES` | `2` | Max concurrent search processes |
| `SEARCH_PROCESS_CACHE_SIZE_KB` | `2048` | SQLite page cache per search process (KiB, private per process) |
| `SEARCH_PROCESS_MMAP_SIZE_MB` | `32` | mmap window per search process (MB); `0` disables |
| `SEARCH_PROCESS_RECYCLE_IMMEDIATE` | `false` | Reclaim the process immediately after a query (lowest memory, but pays a cold start per query) |
| `SEARCH_PROCESS_IDLE_MS` | `60000` | Idle reclaim delay (ms), `0` disables; only effective when the previous item is `false` |
| `SEARCH_QUEUE_MAX` | `16` | Search wait-queue cap; excess queries fail fast |
| `SEARCH_QUEUE_TIMEOUT_MS` | `10000` | Queue timeout (ms), `0` = unlimited |
| `SYNC_CRON` | `''` | Cron expression for scheduled incremental sync (5-field, e.g. `'0 4 * * *'`); empty disables |
| `SYNC_ON_START` | `false` | Whether to run one incremental catch-up at startup. With an obsolete index format, startup runs a migration rebuild regardless (see [Operations Notes](#operations-notes)) |
| `ACCESS_CONTROL_MODE` | `'ip-whitelist'` | `'ip-whitelist'` allows only the whitelist; `'off'` disables |
| `ALLOWED_CLIENTS` | see config.js | Whitelist entries: exact IPv4 / IPv6 and CIDR; defaults cover localhost and common private ranges |
| `TRUST_PROXY` | `true` | Whether to trust the reverse proxy's `X-Forwarded-For` (affects `req.ip` and whitelist matching) |

Path resolution priority: **explicit argument > config.js > module default**. The service does not read `DHT_DB_PATH` / `DHT_INDEX_DB_PATH` env vars; scripts under `scripts/` still do.

## Running

> **First start**: the service listens immediately and builds the index in the background (full population for a fresh index DB, incremental catch-up otherwise). Results are incomplete and counts low during that period — the status panel shows progress.

```bash
npm start                    # Node
bun index.js                 # Bun

npm run dev:node             # dev: nodemon
npm run dev:bun              # dev: bun --watch
npm run dev:web              # dev: Vite dev server (/api proxied to the backend)
```

Visit `http://localhost:<port>` (default 3000).

### pm2

```bash
pm2 start ecosystem.config.node.json   # or npm run start:pm2:node
pm2 start ecosystem.config.bun.json    # or npm run start:pm2:bun
npm run stop:pm2                       # stop both
npm run logs:pm2                       # logs
```

Neither config hardcodes the port; both read `PORT` from `config.js`. To run both side by side, start one with a different port, e.g. `PORT=3001 pm2 start ecosystem.config.bun.json`.

### Single-file exe (bun build --compile)

Build once on a dev machine; target machines need no Bun / Node or any dependencies.

```bash
npm run build:zip        # = build:exe & pack:zip → release/DHT-Search-v<version>.zip
```

| Command | What it does | Output |
|------|------|------|
| `npm run build:exe` | Frontend build → exe compile → sync public → copy config.js / README.md → create empty data/ | `dist/` delivery folder |
| `npm run pack:zip` | Zip only, no build | `release/DHT-Search-v<version>.zip` |

```
dist/
├── DHT-Search.exe   # single-file service (backend and workers inside; frontend assets are not embedded)
├── config.js        # external config, read preferentially at runtime; edit and restart
├── public/          # frontend assets
└── data/            # runtime data (auto-created; put magnet.db here)
```

- **Deploy**: hand out the zip from `release/`, or copy `dist/` directly.
- **Config**: edit `config.js` next to the exe and restart; delete it to fall back to built-in defaults.
- **Cross-compile**: `bun build exe-entry.js --compile --target=bun-linux-x64` (see Bun docs).
- **Compiled behaviour**: only the exe exists on disk, so the two worker bodies are self-spawned via `spawn(exe, [flag])` with an unchanged IPC protocol.
- **End users**: see the [exe Usage Guide](#exe-usage-guide-beginner-friendly).

## HTTP API

| Method | Path | Description |
|------|------|------|
| GET | `/` | Redirect to `/index.html` |
| GET | `/index.html`, `/public/*` | Frontend static assets |
| GET | `/api/search` | Search (see below) |
| GET | `/api/latest` | Latest list (bypasses FTS; newest first) |
| GET | `/api/magnet/:id/files` | Full file tree of one magnet `{ id, nodes }` |
| GET | `/api/count` | Indexed count `{ count }` |
| GET | `/api/hot?limit=` | Hot keywords `{ items }` |
| GET | `/api/hot/filter` | Blacklist listing |
| POST | `/api/hot/filter` | Add a filter word, body `{ term }` |
| DELETE | `/api/hot/filter?term=` | Delete a filter word |
| GET | `/api/hot/filter/export` | Export the blacklist as a text attachment (one word per line) |
| POST | `/api/hot/filter/import` | Bulk import, body `{ terms: string[] }` → `{ ok, accepted, total }` |
| POST | `/api/reindex` | Full rebuild (child process writes a shadow DB, then atomic swap) → `{ ok, indexed }` |
| POST | `/api/sync` | Manual incremental sync → `{ ok, skipped, added }` |
| GET | `/api/stats/stream` | Runtime status SSE stream (every 3s) |

### `GET /api/search`

| Param | Description |
|------|------|
| `q` | Required, search keywords (at least one letter or digit) |
| `sortBy` | `fetchedAt` / `totalSize` / `relevance`; others ignored (sorted by id) |
| `order` | `asc` / `desc`, default `desc`, only with `sortBy` |
| `limit` | Page size (clamped 1..200, default 20); only `all` means whole-set fetch |
| `offset` | Pagination offset |
| `minSize` / `maxSize` | Size range filter (bytes) |
| `by` | `hash` for exact infohash lookup |

Response: `{ total, limit, offset, items: [{ id, name, infohash, magnet, fileCount, preview, totalSize, fetchedAt }], truncated? }`.

`fileCount` is precomputed at index time; `preview` holds up to 5 server-picked `{ path, size }` entries (only matching files when a query is present). Lists never carry the whole file tree — call `/api/magnet/:id/files` when needed. Whole-set fetches beyond `MAX_RESULTS` carry `truncated: true`.

### `GET /api/magnet/:id/files`

Returns `{ id, nodes }` where `nodes` is a flat tree:

```js
[{ name, parent, isDir, size, path? }]
```

`parent` is the index of the parent node (`-1` for roots), directory `size` already aggregates its descendants, and only file nodes carry `path`. A non-integer `id` returns 400, a missing entry returns 404.

### `GET /api/latest`

| Param | Description |
|------|------|
| `limit` | Page size (clamped 1..200, default 30); `all` unsupported |
| `offset` | Pagination offset |

Response fields are the same as `/api/search`. The list is always ordered by `id` descending and offers no keywords / sorting / filtering; it does not go through FTS.

### Request cancellation

When the client disconnects midway (page closed, or a new search cancels the old request), the server cancels the query immediately: queued tasks are removed, dispatched ones have their child process `SIGKILL`ed; nothing is cached or responded.

## Architecture

### Shadow index

The source DB is never touched during queries; all searches hit a separate writable index DB:

| Database | File | Role | Access |
|----|------|------|--------|
| Source DB | `data/magnet.db` | Raw data written by an external crawler | Opened read-only while building / syncing |
| Index DB | `data/dht.search.db` | FTS5 index + copy + sync watermark + keywords | All queries hit this |

The index DB contains 4 kinds of objects:

- `magnets_fts`: contentless FTS5 virtual table indexing `name` and the path-only text of `files`;
- `magnets_docs`: denormalized copy of `magnets` (including `fileCount`) for query JOINs; its `files` column keeps the source text, from which the detail endpoint builds the flat tree;
- `sync_meta`: index state (data watermark `last_rowid` / format version `files_format` / maintenance state `build_mode` / FTS merge counter `fts_pending`);
- `keyword_stats` / `keyword_filter`: hot-keyword stats and the filter table.

### Sync strategy

- On startup, an incremental catch-up by `last_rowid` runs in the background and never blocks the service;
- Runtime periodic maintenance is the `SYNC_CRON` incremental sync, disabled by default; full rebuilds are manual only;
- UPDATE / DELETE of existing source rows are not captured incrementally — trigger `POST /api/reindex` for a full rebuild.

### Dual runtime

`src/db-driver.js` picks the driver at runtime via `typeof Bun`; business code does not care:

| Runtime | Driver | Index maintenance runs in |
|--------|------|------------------|
| Node | `better-sqlite3` + `drizzle-orm/better-sqlite3` | A child process (spawn + IPC, heap cap via `--max-old-space-size`) |
| Bun | `bun:sqlite` + `drizzle-orm/bun-sqlite` | A child process (spawn + IPC, adds `--smol`) |

Both runtimes share one execution carrier, unified in `src/child-process.js`.

### Search execution model

Searches run in child processes so that "client disconnects, query stops" actually works: the drivers are synchronous APIs, one query blocks the execution unit, and only an OS-level `SIGKILL` can interrupt it — so the unit must be a process, not a thread.

Processes are spawned on demand, never resident:

| When | Behaviour |
|------|------|
| Service start | 0 processes |
| Query arrives | Reuse an idle process; spawn only if none and below `SEARCH_MAX_PROCESSES` |
| All busy | New queries join a FIFO queue |
| Client disconnects | `SIGKILL` and remove (no refill) |
| Idle timeout | Reclaimed after `SEARCH_PROCESS_IDLE_MS`; count returns to 0 |

Cancellation is two-level: queued tasks are removed at zero cost; dispatched ones are interrupted with `SIGKILL`. Process memory is dominated by the runtime baseline, so the main lever is fewer processes rather than tighter PRAGMAs.

### Frontend

Frontend sources live in `web/src/` (Alpine.js + Tailwind, bundled by Vite). Rendering and events are driven by Alpine directives in `index.html`; `web/src/` only holds state, actions and pure helpers. `npm run build:web` outputs to `public/` at the repo root, served by `express.static`.

## Project Layout

```
DHT-search/
├── index.js                   # Express entry: HTTP API + static assets + search cache/scheduled sync/status SSE
├── exe-entry.js               # Single-exe build entry (bun --compile)
├── app-entry.cjs              # pm2 entry wrapper (CJS require → dynamic import of the ESM index.js)
├── config.js                  # Runtime config (one exported const per item)
├── ecosystem.config.node.json # pm2 config: Node
├── ecosystem.config.bun.json  # pm2 config: Bun
├── bunfig.toml                # Bun install config (skip the better-sqlite3 native module)
├── package.json
├── src/
│   ├── db.js                  # Facade: createMagnetDb assembly (index maintenance + search + keywords)
│   ├── index/                 # Index subsystem
│   │   ├── ddl.js             # Single source of index DDL (ensureSchema / resetIndexTables)
│   │   ├── transform.js       # Write-time row transform (files text → FTS path text + fileCount)
│   │   ├── tuning.js          # Tuning knobs (batch sizes / rebuild PRAGMAs / sort threads)
│   │   └── timing.js          # Index pipeline phase timing
│   ├── search/                # Search subsystem
│   │   ├── query.js           # Search input contract (normalization / MATCH expression / SQL whitelist)
│   │   └── api.js             # Search implementation (shared by main process and search child)
│   ├── db-driver.js           # Unified SQLite driver adapter (Node/Bun switch + capability probe)
│   ├── store.js               # Shared conventions (CONFIG, paths, table and column lists, sort whitelist)
│   ├── settings.js            # Config loader (compiled exe prefers the config.js next to it)
│   ├── worker-flags.js        # Worker child-process CLI flags
│   ├── child-process.js       # Unified spawn entry
│   ├── schema.js              # drizzle table definitions (sync_meta)
│   ├── file-tree.js           # Flat file-tree builder (used on demand by the detail endpoint)
│   ├── reindex-worker.js      # Index maintenance carrier (IPC progress / results)
│   ├── searchPool.js          # Search process pool (on-demand spawn + bounded concurrency + queue)
│   ├── search-child.mjs       # Search child-process entry
│   ├── accessControl.js       # Edge access control (IP / CIDR whitelist)
│   ├── stats.js               # Runtime status
│   ├── logger.js              # Leveled logging
│   └── util.js                # Shared pure helpers
├── scripts/                   # Ops / seed scripts (not runtime deps)
│   ├── build-exe.mjs          # Single-exe build
│   ├── pack-zip.mjs           # Package release/*.zip
│   ├── seed-filter.mjs        # Noise-word seed (hot-filter-words.txt, idempotent)
│   ├── hot-filter-words.txt   # Noise-word list (one per line, # comments)
│   ├── dump-keywords.mjs      # Export unfiltered keywords for review
│   ├── filter-common-en.mjs   # Auto-select broad English keyword candidates
│   ├── fts-ab.mjs             # FTS5 parameter A/B benchmark (npm run bench:fts)
│   ├── reset.mjs              # Reset the app: delete index DB and derived files (npm run reset)
│   └── spike/                 # Experimental script drafts
├── web/                       # Frontend sources (Vite + Tailwind, requires a build)
│   ├── index.html
│   ├── vite.config.js         # Outputs to ../public; dev proxies /api to the backend
│   └── src/
│       ├── main.js            # Entry: registers Alpine components and stores
│       ├── app.js             # Page component (state + actions)
│       ├── card.js            # Result card component
│       ├── api.js             # Backend API layer
│       ├── toast.js           # Global notification store
│       ├── icons.js           # Icon literals for templates
│       ├── file-tree.js       # Renders the flat file tree
│       ├── util.js            # Shared pure helpers
│       └── styles/app.css     # Tailwind entry
├── public/                    # Frontend build output (build:web)
├── test/                      # Tests and benchmark scripts
├── dist/                      # exe build output (ignored)
└── data/                      # Runtime data (source and index DBs, ignored)
```

## Keyword Blacklist

Filter words are excluded from the hot-keyword ranking and stats. Three ways to maintain them:

### Seed script

```bash
npm run seed:filter          # import scripts/hot-filter-words.txt (idempotent)
```

Helper scripts (generate candidates only, never write to the DB):

- `scripts/dump-keywords.mjs`: export unfiltered ASCII keywords by `doc_count` to `scripts/hot-keywords-dump.txt`;
- `scripts/filter-common-en.mjs`: select broad English candidates into `scripts/hot-filter-en.auto.txt`.

### HTTP API

```bash
curl -X POST localhost:3000/api/hot/filter -H 'content-type: application/json' -d '{"term":"foo"}'
curl -X DELETE 'localhost:3000/api/hot/filter?term=foo'

# bulk import (blank lines / # comments / pure-symbol lines ignored, idempotent)
curl -X POST localhost:3000/api/hot/filter/import \
  -H 'content-type: application/json' \
  -d '{"terms":["foo","bar"]}'

# export (text/plain attachment, re-importable)
curl -L localhost:3000/api/hot/filter/export -o hot-filter-export.txt
```

Import and export share one format: one word per line, `#` comments.

### Web UI

The "Blacklist" panel title bar offers import / export buttons: export downloads a `.txt`, import bulk-writes the chosen file and refreshes the ranking immediately.

## Testing

```bash
npm test                 # cron wiring + reset script + smoke + real-boot integration (cron / reset / smoke / boot)
npm run test:cron        # cron wiring (test/cron.mjs)
npm run test:reset       # reset script behaviour (test/reset.mjs, temp paths only, never touches data/)
npm run smoke            # smoke tests (test/smoke.mjs, generates fixture data)
npm run test:boot        # real boot + HTTP integration (test/boot.mjs)
npm run test:access      # access-control tests (test/access-control.mjs)
npm run verify:driver    # driver feasibility checks (test/verify-driver.mjs)
npm run bench:fts        # FTS5 schema A/B (scripts/fts-ab.mjs)
npm run bench:index      # rebuild benchmark (test/bench-index.mjs)
```

| Script | Coverage |
|------|----------|
| `smoke.mjs` | Builds fixture source DBs; covers search / keywords / rebuild / mutual exclusion / idempotent resume / index migration (Node and Bun) |
| `boot.mjs` | Starts the real service on a free port and drives it over HTTP; covers `index.js` wiring (search pool recovery after an index swap, the SSE "next sync" source) |
| `reset.mjs` | Safety properties of the reset script: source DB untouched by default, `--yes` required to delete it, `--dry-run` writes nothing, misconfiguration rejected |
| `verify-driver.mjs` | Detects the runtime and verifies driver methods and FTS5 features |
| `bench:fts` | Compares FTS5 schema options (detail / columnsize / index text shape) against size and relevance |
| `bench:index` | Runs each tuning variant into a comparison table (time / peak RSS / phase breakdown) on deterministic synthetic data |

## Operations Notes

- **Startup**: the service listens first; index sync runs in the background.
- **Manual rebuild / sync**: Web "Settings" panel, or `POST /api/reindex` / `POST /api/sync`. The rebuild leaves pages and search untouched and swaps in atomically; a failed build only discards the shadow file.
- **Disk headroom**: auto-checkpoint is disabled during a rebuild, so the WAL grows to roughly the index size and is flushed once at the end — leave about 2× the index size free.
- **Phase timings**: every rebuild (and any sync that appended rows) logs one line of phase timings (`schema / scan / fts / docs / txn / js / index / merge / checkpoint`); semantics in `src/index/timing.js`.
- **Upgrading**: opening an old index DB adds missing columns automatically (the old DB keeps answering queries, new fields take defaults); when the format is obsolete, startup runs a full rebuild in the background regardless of `SYNC_ON_START` and the live index keeps serving throughout. Downgrading is safe too: old code rebuilds back to the old format.
- **Resetting**: `npm run reset` deletes the index DB and its derived files — the DB itself, an in-progress shadow DB (`.build`), the swap backup (`.old`) and their WAL / SHM files. The index is regenerable, so the next start rebuilds it (full population). **The source DB is left untouched** (crawled data cannot be recovered); to delete it too, run `npm run reset -- --source --yes` (without `--yes` the script refuses). `--dry-run` lists what would go, `--tests` also clears the `test/data` fixtures. Stop the service first, otherwise file locks make the deletion fail.
- **Tuning**: batch sizes, rebuild PRAGMAs and sort threads live in `src/index/tuning.js`, each overridable via env vars for benchmarking; `npm run bench:index` reproduces the comparison locally. FTS merge strategy: one `optimize` after a rebuild, partial `merge` for incremental syncs once the accumulated row count crosses the threshold.

## RPC Push (aria2 / Motrix)

The result card's push button sends the magnet link via JSON-RPC 2.0 `aria2.addUri` to a downloader. Address and secret are configured in Settings and stored in browser `localStorage`:

- Address defaults to `http://localhost:16800/jsonrpc`;
- Secret is optional; when set, `token:<secret>` is prepended to `params` per the aria2 convention.

Results appear as toasts (success shows the task GID). Cross-origin requests to the downloader's RPC port require CORS to be enabled:

```bash
aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all
```

Motrix: enable "allow requests from all origins" in its settings.

## exe Usage Guide (beginner-friendly)

> For end users receiving the zip: no runtime installation and no coding skills required.

### 1. What you need

- A Windows PC (Windows 10 / 11, Server 2016+);
- A magnet database file named `magnet.db` (produced by a DHT crawler; this software only searches).

### 2. Extracted layout

Extract anywhere (prefer a path without spaces, e.g. `D:\DHT-Search\`):

```
DHT-Search\
├── DHT-Search.exe   ← main program, double-click to start
├── config.js        ← config file, editable with Notepad
├── README.md        ← this document
├── public\          ← web UI files (do not modify)
└── data\            ← data directory
    └── magnet.db    ← magnet database file
```

| File | What it is | Deletable |
|------|--------|----------|
| `magnet.db` | Raw data | No |
| `dht.search.db` (plus `.db-wal` / `.db-shm`) | Auto-generated search index | Yes; rebuilt automatically at next start |

> The zip contains no `data` directory or database (personal data is not distributed). The program creates the directory automatically if missing.

### 3. Put the database in place

1. Locate the crawler's `magnet.db`;
2. Copy it into the software's `data` folder (create the folder if missing — the name must be exactly `data`);
3. Make sure the file name is exactly `magnet.db` (rename `magnet(1).db`, `magnet.db.crdownload` and similar);
4. To keep the file elsewhere, point `SOURCE_DB_PATH` at it instead (see section 6).

### 4. Start the program

1. Double-click `DHT-Search.exe`: a console window opens and scrolls logs. Keep it open while using (minimizing is fine);
2. The first start builds the index: seconds to minutes for small data, tens of minutes for millions of rows. The page works meanwhile, but results are incomplete and counts low — progress appears as `indexed N rows`;
3. To exit, close the console window.

> If a prebuilt `dht.search.db` ships with the package, the first start loads it directly and is ready in seconds.

### 5. Open the web page

- On this machine: visit `http://localhost:3000`;
- Other devices on the same LAN: visit `http://<this PC's IP>:3000` (find the IPv4 address with `ipconfig`);
- By default only localhost and private-network devices are allowed, so LAN access works out of the box.

### 6. Change configuration (optional)

Edit `config.js` with Notepad, save, and restart the program:

| What to change | Item | Example |
|----------|--------|------|
| Web port | `PORT` | `export const PORT = 8080;` |
| Database location | `SOURCE_DB_PATH` | `export const SOURCE_DB_PATH = 'D:/mydb/magnet.db';` (use `/`) |
| Allow more devices | `ALLOWED_CLIENTS` | add a line such as `'192.168.1.100',` in the brackets |
| Disable the IP whitelist | `ACCESS_CONTROL_MODE` | set to `'off'` (never on the public internet) |
| Scheduled incremental sync | `SYNC_CRON` | cron expression, e.g. `'0 3 * * *'` for daily 03:00; empty disables |

Each line is `export const name = value;` — change only the value. Broke it? Delete `config.js` and restart to fall back to defaults. The program reads the `config.js` next to the exe.

### 7. Daily use and maintenance

- **New data**: a catch-up runs on startup; configure `SYNC_CRON` for periodic catch-ups, or click "Sync" in Settings. UPDATE / DELETE of existing source rows require "Rebuild Index".
- **Backup**: copy the whole folder. `dht.search.db` is a rebuildable index; `magnet.db` is the raw data and must be kept.
- **Upgrade**: overwrite the exe with the new one; `data` stays as is.
- **Move to another PC**: copy the whole folder.

### 8. Troubleshooting

| Symptom | Fix |
|------|-----------|
| Console window flashes and disappears | Usually `magnet.db` is missing from `data`, or its name / format is wrong; re-run and read the red error text |
| Page shows 403 | The device IP is not whitelisted: add it to `ALLOWED_CLIENTS` and restart |
| Page unreachable (connection refused) | The program failed to start, or the port is taken: change `PORT` and retry |
| Results incomplete / counts low | Indexing or a sync is still in progress — wait for it to finish |
| Search spins forever | Make sure the program is running and indexing finished; otherwise click "Rebuild Index" |
| Want internet access | Port-forward on the router and add the peer's public IP to `ALLOWED_CLIENTS`; do not disable the whitelist on the public internet |
| Red error text in the window | Note the message, check the config against this document, then report it |

## Data Source & Open-source Acknowledgements

The magnet data consumed by this project comes from the crawling results of [p2pspider](https://github.com/thejordanprice/p2pspider) (a Node.js BitTorrent DHT crawler, MIT License):

- This project contains no code from p2pspider; it only consumes the database file (`data/magnet.db`) it produces;
- Neither this project nor its packages distribute any crawled data (the `data/` directory must be prepared by the user).

Thanks to [thejordanprice](https://github.com/thejordanprice) and the open-source community.

## Disclaimer & License

### Disclaimer

- This project only indexes resource metadata (magnet links, file names, sizes etc.) publicly broadcast on the DHT network; it does not store, provide or host any content files themselves;
- Crawled results may index sensitive, illegal or copyrighted content. Users must comply with the laws and regulations of their country / region and must not use this project to infringe the rights of others;
- This project is provided "as is", without warranty of any kind; users bear full responsibility for its use.

### License

Released under the [MIT License](./LICENSE): free to use, copy, modify, merge, publish and distribute, provided the original copyright and permission notices are retained. Dependencies (express / drizzle-orm / better-sqlite3 / lru-cache / chalk etc.) are under permissive licenses with no copyleft concerns.
