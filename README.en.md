# DHT Search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)

[简体中文](README.md) | **English**

A magnet link (torrent) search engine built on **SQLite FTS5 full-text search**, paired with a Vite + Tailwind web UI.

## 1. Overview

DHT Search takes magnet resources from a "source database" (`data/magnet.db`, containing a `magnets` table) continuously written by an external program (e.g. a DHT crawler) and builds a high-performance **shadow index** (FTS5 inverted index + denormalized copy), served over HTTP:

- Full-text fuzzy keyword search (prefix matching, case/diacritic folding)
- Exact infohash lookup (with prefix matching)
- Sort by fetched time / size / relevance
- Size-range filtering, true server-side pagination
- Hot keyword ranking with "noise word" blacklist (import / export)
- Torrent file tree, result highlighting, clipboard magnet copy
- Input suggestions (fuzzy matching based on hot keywords)
- Runtime status dashboard (settings panel, SSE push of cache / memory / processes / sync & reindex progress)
- Access control at the edge (IP / CIDR whitelist)

The project does **not** include the DHT crawler itself — it only consumes existing source-database data and provides the search service.

## 2. Core Architecture

### Shadow Index
The source database (written externally, possibly concurrently) is **never touched** during queries; all searches hit a separate writable index database (default `data/dht.search.db`):

| Database | File | Role | Access |
|----|------|------|--------|
| Source DB | `data/magnet.db` | Raw data written by an external crawler | Opened **read-only** only while building/syncing the index |
| Index DB | `data/dht.search.db` | FTS5 index + copy + sync watermark + keywords | All queries hit this |

The index DB contains 4 kinds of objects:
- `magnets_fts`: contentless FTS5 virtual table (indexes `name` / `files` text only)
- `magnets_docs`: denormalized copy of `magnets` (id + display/sort columns) for query JOINs
- `sync_meta`: sync watermark (`tokenizer` / `last_rowid`)
- `keyword_stats` / `keyword_filter`: hot-keyword stats and noise-word filter tables

### Sync Strategy
- On startup, **incremental catch-up** by `last_rowid` (background only, never blocking service start or requests); there is no longer an "hourly auto incremental sync" at runtime — periodic maintenance is handled by a **scheduled full rebuild** (see `REINDEX_CRON`);
- UPDATE / DELETE of existing rows in the source DB are not reflected automatically; trigger `POST /api/reindex` or wait for the next scheduled rebuild (the rebuild JOIN drops stale rows deleted from the source). Structural changes such as tokenizer changes are also handled by the full rebuild.

### Dual Runtime (Node / Bun)
`src/db-driver.js` picks the driver at runtime via `typeof Bun`; business code doesn't care:

| Runtime | Driver | Index maintenance (rebuild / sync) runs in |
|--------|------|------------------|
| Node | `better-sqlite3` + `drizzle-orm/better-sqlite3` | A dedicated **worker thread** (heap limit configurable; OOM only kills the worker) |
| Bun | `bun:sqlite` + `drizzle-orm/bun-sqlite` | A dedicated **child process** (Bun's `node:worker_threads` coverage is incomplete; `REINDEX_MAX_OLD_SPACE_MB` does not apply — the OS reclaims the heap) |

Either way the **main process is never blocked**: rebuilds / bulk syncs are long sequences of synchronous SQLite native calls which would freeze the whole event loop if run in-process. They are dispatched to a dedicated thread / process, with progress and results relayed over a unified message protocol (see `src/reindex-worker.js`).

### Search Execution Model (On-demand Processes)
Searches run in **dedicated child processes** — not for concurrency, but for "client disconnects, query stops":
`better-sqlite3` / `bun:sqlite` are synchronous APIs; one query blocks the execution unit inside C++, and `worker.terminate()` sets a termination flag that is only checked when execution returns to JS — a query stuck in a native call never sees it (measured: Node terminate → exit 23328ms; Bun still alive after 6s). Only an OS-level `SIGKILL` truly interrupts, and threads cannot be killed individually by the OS — hence processes.

Processes are forked **on demand**, not resident:

| When | Behavior |
|------|------|
| Service start | **0** processes, no extra memory |
| Query arrives | Reuse an idle process; fork only if none and below `SEARCH_MAX_PROCESSES` |
| All busy | New queries queue up (FIFO), no new processes |
| Client disconnects | `SIGKILL` the process and remove it (**no refill**); fork on demand next time |
| Idle timeout | Reclaimed after `SEARCH_PROCESS_IDLE_MS`; process count returns to 0 |

Two-level cancellation, fully covered: **queued** → removed from queue (zero cost); **dispatched** → `SIGKILL` truly interrupts the running synchronous query.

> Note: searches are paginated (≤ `MAX_LIMIT` 200 per page), so a single process needs little memory;
> child-process PRAGMAs are tuned accordingly (`cache_size = -2048`, `mmap_size = 32MB`).
> Process memory is dominated by the runtime baseline itself (Bun ~60-120MB), so the main lever for
> lower memory is **fewer processes**, not tighter PRAGMAs.

### Frontend (`web/`, Vite + Tailwind)
Frontend sources live in `web/src/` (native ES modules + custom elements + Tailwind CSS).
`npm run build:web` outputs the bundle to `public/` at the repo root, served by the backend via `express.static`.
For development use `npm run dev:web` (Vite dev server, `/api` proxied to the backend, port read from `config.js`).
When deploying behind a reverse-proxy subpath, `WEB_BASE_PATH` controls the asset reference prefix.

## 3. Project Layout

```
DHT-search/
├── index.js                   # Express entry: HTTP API + static assets + search cache/scheduled rebuild/status SSE
├── exe-entry.js               # Single-exe build entry (bun --compile; service vs worker modes by CLI flag)
├── app-entry.cjs              # pm2 entry wrapper (CJS require → dynamic import of ESM index.js)
├── config.js                  # Runtime config (ESM module, commented; each item an exported const)
├── ecosystem.config.node.json # pm2 config: Node runtime
├── ecosystem.config.bun.json  # pm2 config: Bun runtime
├── bunfig.toml                # Bun install config (skip the better-sqlite3 native module)
├── package.json
├── src/
│   ├── db.js                  # Data-access core: index maintenance, search, keywords, rebuild (main entry)
│   ├── db-driver.js           # Unified SQLite driver adapter (auto Node/Bun switch)
│   ├── store.js               # Config aggregation & shared conventions (CONFIG, paths, table names, sort whitelist)
│   ├── settings.js            # Unified config loader (compiled exe prefers the external config.js next to it)
│   ├── worker-flags.js        # Worker child-process CLI flags (shared by fork / exe self-spawn)
│   ├── schema.js              # drizzle table definitions (magnets_docs / sync_meta)
│   ├── reindex-worker.js      # Index maintenance worker (dual mode: Node worker thread / Bun child process)
│   ├── searchPool.js          # Search process pool (on-demand fork + bounded concurrency + wait queue)
│   ├── search-child.mjs       # Search child-process entry (opens the index DB read-only)
│   ├── accessControl.js       # Edge access control (IP / CIDR whitelist)
│   ├── stats.js               # Runtime status (cache hit / memory / processes / sync & rebuild progress)
│   ├── logger.js              # Colored leveled logging
│   └── util.js                # Shared pure helpers (clampInt / normalizeKeyword etc.)
├── scripts/                   # Ops / seed scripts (plain Node scripts, not runtime deps)
│   ├── build-exe.mjs          # Single-exe build script (bun build --compile → dist/)
│   ├── pack-zip.mjs           # Zip-only packaging script (dist/ → release/)
│   ├── seed-filter.mjs        # Keyword-blacklist seed: imports hot-filter-words.txt (idempotent)
│   ├── hot-filter-words.txt   # Noise-word list (one per line, # comments)
│   ├── dump-keywords.mjs      # Export non-blacklisted ASCII keywords by doc_count for review
│   ├── filter-common-en.mjs   # Auto-select broad English keyword candidates → hot-filter-en.auto.txt
│   └── spike/                 # Experimental script drafts
├── web/                       # Frontend sources (Vite + Tailwind, requires build)
│   ├── index.html
│   ├── vite.config.js         # Outputs to ../public; dev proxies /api to the backend
│   ├── package.json
│   └── src/
│       ├── main.js            # Main logic: search/pagination/sort/keywords/suggest/URL sync/rebuild/settings
│       ├── components.js      # Custom elements: result cards / file tree / sort controls etc.
│       ├── file-tree.js       # Builds a collapsible tree from flat [{path,size}]
│       ├── util.js            # Shared pure helpers (format, copy, highlight, RPC push etc.)
│       └── styles/app.css     # Tailwind entry & global styles
├── public/                    # Frontend build output (npm run build:web), served by the backend
├── test/
│   ├── smoke.mjs              # End-to-end smoke tests (generates fixture data; runs on Node & Bun)
│   ├── verify-driver.mjs      # Driver feasibility checks (PRAGMA/WAL/transactions/FTS5 etc.)
│   ├── access-control.mjs     # Access-control (whitelist / proxy) tests
│   └── data/                  # Test fixtures
├── dist/                      # exe build output (bun run build:exe; usually ignored)
└── data/                      # Runtime data (source & index DBs; usually ignored)
```

## 4. Features

- **Full-text search**: FTS5 fuzzy search over `name` / `files`, last-token prefix matching, unicode61 case/diacritic folding.
- **Exact infohash lookup**: a 40-char hex (optionally with `urn:btih:` / `hash` prefix) switches to exact + prefix matching, bypassing FTS.
- **Sorting**: `fetchedAt`, `totalSize`, `relevance` (bm25); defaults to id.
- **Size filter**: byte-range filtering (entered as MB in the UI).
- **True server-side pagination**: every query/page/sort fetches a page from the backend; `total` always matches.
- **Hot keyword ranking**: qualified tokens from `name` counted at index time (drop single chars, pure numbers, noise words), sorted by document frequency.
- **Keyword blacklist**: user-maintained noise-word list (seed script / API / Web UI import-export), excluded from ranking and stats.
- **Input suggestions**: tiered matching against hot keywords (exact > prefix > contains > fuzzy Levenshtein).
- **Search cache**: in-process LRU storing serialized JSON strings (zero stringify on hit), byte-capped and TTL-expiring (default 32MB / 1h). Whole-set fetches (`limit=all`) bypass the cache.
- **Online rebuild & scheduled maintenance**: full rebuild runs in a dedicated worker thread (Node) or child process (Bun) — **zero main-process blocking; pages and search stay available**; startup sync runs in the background and the service is up in seconds; runtime periodic maintenance is handled by the `REINDEX_CRON` scheduled full rebuild.
- **Runtime status**: the settings panel receives a snapshot every 3s via SSE (`/api/stats/stream`): cache hit, heap, search-process count, indexed count, next-sync countdown, rebuild/sync progress.
- **Access control**: edge IP / CIDR whitelist covering everything (pages + APIs + writes), proxy-aware.
- **RPC push**: the "push" button on result cards sends magnet links via JSON-RPC 2.0 (`aria2.addUri`) to aria2 / Motrix; address & secret configured in Settings, secret sent as `token:` prefix per aria2 convention.

## 5. Configuration (`config.js`)

Every item ships with a default and comments in `config.js`; edit the corresponding `export const` and restart. Path config accepts relative (repo-root-based) or absolute paths.

| Item | Default | Description |
|--------|------|------|
| `SOURCE_DB_PATH` | `data/magnet.db` | Source DB path (contains the `magnets` table) |
| `INDEX_DB_PATH` | `data/dht.search.db` | Shadow index DB path |
| `PORT` | `3000` | HTTP service port |
| `WEB_BASE_PATH` | `''` | Asset prefix of the frontend build: empty = site root; `/dht` for reverse-proxy subpaths. Affects `npm run build:web` output only — rebuild after changing |
| `MAX_RESULTS` | `2000` | Cap for whole-set fetch (`limit=all`); excess marked `truncated` |
| `REINDEX_MAX_OLD_SPACE_MB` | `2048` | Heap cap (MB) of the Node rebuild worker thread; not applicable when Bun uses a child process |
| `SEARCH_CACHE_MAX_SIZE_MB` | `32` | Search cache memory cap (MB); values are serialized JSON strings so this ≈ actual heap |
| `SEARCH_CACHE_TTL_MS` | `3600000` | Search cache TTL (ms, default 1h) |
| `SEARCH_MAX_PROCESSES` | `2` | Max concurrent search processes (forked on demand; 0 resident at start) |
| `SEARCH_PROCESS_CACHE_SIZE_KB` | `2048` | SQLite page cache per search process (KiB) — **private per process**; total = value × `SEARCH_MAX_PROCESSES` |
| `SEARCH_PROCESS_MMAP_SIZE_MB` | `32` | mmap window per search process (MB) — maps shared clean pages, not duplicated across processes; `0` disables |
| `SEARCH_PROCESS_RECYCLE_IMMEDIATE` | `false` | Reclaim process immediately after a query; `true` keeps 0 idle processes but pays a fork cold start (~1s) per query |
| `SEARCH_PROCESS_IDLE_MS` | `60000` | Idle reclaim delay (ms); `0` disables. **Only effective when `SEARCH_PROCESS_RECYCLE_IMMEDIATE = false`** |
| `SEARCH_QUEUE_MAX` | `16` | Search wait-queue cap; excess queries fail fast when all processes are busy |
| `SEARCH_QUEUE_TIMEOUT_MS` | `10000` | Queue timeout (ms); fail fast on expiry; `0` = unlimited |
| `REINDEX_CRON` | `''` | Cron expression for scheduled full rebuild (5-field, e.g. `'0 4 * * *'` = daily 04:00); empty (default) disables it. When set, the cron becomes the sole periodic maintenance (replacing the old hourly auto-sync) |
| `ACCESS_CONTROL_MODE` | `'ip-whitelist'` | Access-control mode: `'ip-whitelist'` allows only `ALLOWED_CLIENTS`, others get 403; `'off'` disables (for localhost / proxy-auth setups). **On by default** |
| `ALLOWED_CLIENTS` | see below | Client address list (only in `ip-whitelist` mode): exact IPv4/IPv6 and CIDR (e.g. `192.168.0.0/16`, `2001:db8::/32`). Defaults include `127.0.0.1`, `::1`, and private/link-local ranges `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10` |
| `TRUST_PROXY` | `false` | Trust the reverse proxy's `X-Forwarded-For` for the real client IP: `false` (default) uses the TCP peer (direct connection); behind nginx set `true` / `'loopback'` / a subnet, otherwise the whitelist misjudges |

Path resolution priority: **explicit argument > config.js > module default** (config.js values are always non-empty; the service does not read `DHT_DB_PATH` / `DHT_INDEX_DB_PATH` env vars; scripts under `scripts/` still read `DHT_INDEX_DB_PATH`).

## 6. Installation & Prerequisites

1. **Source DB**: `data/magnet.db` must exist and contain a `magnets` table (written by an external DHT crawler). Startup fails otherwise.
2. **Runtime** (either one):
   - **Node**: needs `better-sqlite3` (native C++ module; `npm install` prebuilds/compiles automatically). Node ≥ 20 (top-level await); **22 / 24 LTS recommended** (Node 20 went EOL 2026-04 and is no longer tested in CI).
   - **Bun**: `bun:sqlite` built-in, no native compilation. The root `bunfig.toml` sets `[install] optional = false` so `bun install` skips `optionalDependencies`' better-sqlite3 automatically; npm users are unaffected and get it installed.
3. Install dependencies:
   ```bash
   npm install                 # Node path (installs better-sqlite3 normally)
   # or
   bun install                 # Bun path (bunfig.toml skips better-sqlite3)
   ```

   > ⚠️ **npm and Bun share the same `node_modules`; re-install after switching package managers**:
   > `bun install` skips and **removes** `better-sqlite3` (the Bun runtime uses the built-in `bun:sqlite` and doesn't need it);
   > running the source / tests on Node does need it — restore with `npm install better-sqlite3`.
4. Build the frontend (once for first deployment; skip if `public/` already exists):
   ```bash
   npm run build:web           # web/ → public/ (Vite + Tailwind)
   ```

## 7. Startup

> **First start**: the service listens immediately and builds the index in the background (incremental catch-up if an index exists, full population for a fresh index DB). With large data this can take minutes to tens of minutes — **search results are incomplete and counts low during that period, which is normal**; watch progress in the status panel. Service is ready once done.

### Frontend dev mode (optional)
```bash
npm run dev:web      # Vite dev server, /api proxied to the backend port
```

### Normal start
```bash
npm start            # Node: node index.js
# or
bun index.js         # Bun
```
Hot-reload during development:
```bash
npm run dev:node     # nodemon index.js
npm run dev:bun      # bun --watch index.js
```
Visit `http://localhost:<port>` (default 3000).

### pm2 (two separate configs)
pm2 loads the ESM entry through the `app-entry.cjs` wrapper:

```bash
# Node instance
pm2 start ecosystem.config.node.json
# or
npm run start:pm2:node

# Bun instance (bun must be on PATH)
pm2 start ecosystem.config.bun.json
# or
npm run start:pm2:bun
```

Neither config hardcodes the port; both read `PORT` from `config.js` (default 3000).
To run both side by side, use different ports — e.g. `PORT=3001 pm2 start ecosystem.config.bun.json`, or separate `config.js` files.

Common pm2 commands:
```bash
npm run stop:pm2      # stop both instances
npm run logs:pm2      # logs
pm2 restart <name>    # restart one
pm2 delete  <name>    # remove
```

### Single-file exe (bun build --compile)
Build once on a dev machine; target machines need **no Bun / Node or any dependencies**. Two steps:

```bash
npm run build:exe        # needs Bun ≥ 1.2.17: build:web & bun build + finalize (outputs dist/)
npm run pack:zip         # zip only: dist/ → release/DHT-Search-v<version>.zip
```

- `build:exe` chains `build:web` before `bun scripts/build-exe.mjs` with `&` in package.json — one command does: frontend build → exe compile → sync public → copy config.js / README.md → create empty data/;
- `pack:zip` only zips; the zip contains a `DHT-Search/` top-level folder that yields the full delivery layout on extraction (empty `data/` folder preserved).

The `dist/` delivery folder:

```
dist/
├── DHT-Search.exe   # single-file service (backend + worker bodies + built-in default config)
├── config.js        # external config: read preferentially at runtime; edit & restart, no rebuild needed
├── README.md        # documentation copy (synced on build)
├── public/          # frontend assets (generated by npm run build:web)
└── data/            # runtime data (auto-created; put magnet.db here)
```

- **Deploy**: hand the zip to users, or copy `dist/` to the target machine directly.
- **Config**: edit `config.js` next to the exe and restart; delete it to fall back to built-in defaults.
- **Frontend**: the exe embeds no static assets; `public/` is built by `build:exe` and shipped alongside.
- **Cross-compile**: Bun supports it, e.g. `bun build exe-entry.js --compile --target=bun-linux-x64` (see Bun docs).
- **Implementation notes**: after compilation only the exe exists on disk, so the two worker bodies (index maintenance / search children) are **self-spawned** via `spawn(exe, [flag])` with an unchanged IPC protocol; config.js is dynamically imported at runtime via `src/settings.js`, enabling "edit config without rebuilding".
- **For end users**: step-by-step usage (adding the database, starting, opening the page, config, troubleshooting) is in **Chapter 13 "exe Usage Guide (beginner-friendly)"** of the Chinese README.

## 8. HTTP API

| Method | Path | Description |
|------|------|------|
| GET | `/` | Redirect to `/index.html` |
| GET | `/index.html`, `/public/*` | Frontend static assets (build output) |
| GET | `/api/search` | Search (see below) |
| GET | `/api/count` | Indexed count `{ count }` (memory cache, no table scan) |
| GET | `/api/hot?limit=` | Hot keywords `{ items: [{term,doc_count,occurrences}] }` |
| GET | `/api/hot/filter` | Keyword-blacklist listing |
| POST | `/api/hot/filter` | Add a filter word, body `{ term }` |
| DELETE | `/api/hot/filter?term=` | Delete a filter word |
| GET | `/api/hot/filter/export` | Export blacklist as plain text (attachment, one per line, `#` comments) |
| POST | `/api/hot/filter/import` | Bulk import, body `{ terms: string[] }`, returns `{ ok, accepted, total }` |
| POST | `/api/reindex` | Full index rebuild (background worker/child), returns `{ ok, indexed }` |
| POST | `/api/sync` | Manual incremental sync (catch-up by `last_rowid`), returns `{ ok, skipped, added }` |
| GET | `/api/stats/stream` | Runtime status SSE stream (settings panel), snapshot every 3s |

### `GET /api/search` parameters
| Param | Description |
|------|------|
| `q` | Required, search keywords (at least one letter/digit) |
| `sortBy` | `fetchedAt` / `totalSize` / `relevance`; others ignored (sorted by id) |
| `order` | `asc` / `desc`, default `desc`, only with `sortBy` |
| `limit` | Page size (clamped 1..200, default 20); **only `all` means whole-set fetch**; `0` / negative / non-numeric fall back to pagination |
| `offset` | Pagination offset |
| `minSize` / `maxSize` | Size range filter (bytes) |
| `by` | `hash` for exact infohash lookup (otherwise FTS5 fuzzy) |

Response: `{ total, limit, offset, items: [{ id, name, infohash, magnet, files, totalSize, fetchedAt }], truncated? }`
(`files` is a parsed `[{ path, size }]` array; whole-set fetches beyond `MAX_RESULTS` carry `truncated: true`.)

When the client disconnects midway (page closed / a new search cancels the old request), the server cancels the corresponding query immediately (removed from queue, or the child process is `SIGKILL`ed); nothing is cached or responded.

## 9. Keyword Blacklist Maintenance

Noise words are excluded from hot-keyword ranking and stats. Three ways to maintain:

### 1. Seed script (`scripts/`)
`scripts/hot-filter-words.txt` holds one word per line (`#` comments), bulk-written into the `keyword_filter` table (idempotent):

```bash
npm run seed:filter          # import scripts/hot-filter-words.txt
```

Helper scripts (not auto-imported; for manual/AI review):
- `scripts/dump-keywords.mjs`: export non-blacklisted ASCII keywords (by `doc_count`) to `scripts/hot-keywords-dump.txt`.
- `scripts/filter-common-en.mjs`: auto-select broad English candidates into `scripts/hot-filter-en.auto.txt` (with match-reason comments).

### 2. HTTP API add/remove / bulk import-export
```bash
# single add/remove
curl -X POST localhost:3000/api/hot/filter -H 'content-type: application/json' -d '{"term":"foo"}'
curl -X DELETE 'localhost:3000/api/hot/filter?term=foo'

# bulk import: string array; blank lines / # comments / pure-symbol lines ignored, idempotent
curl -X POST localhost:3000/api/hot/filter/import \
  -H 'content-type: application/json' \
  -d '{"terms":["foo","bar"]}'
# returns {"ok":true,"accepted":2,"total":N}

# export: text/plain attachment (hot-filter-export.txt), re-importable
curl -L localhost:3000/api/hot/filter/export -o hot-filter-export.txt
```
Import/export share the same format: one word per line, `#` comments — enabling an "export → edit → re-import" workflow.

### 3. Web UI (blacklist panel)
The "Blacklist" panel title bar has **import / export** icons:
- **Export**: download the current blacklist as `.txt`.
- **Import**: pick a `.txt` (one per line, `#` comments), bulk-write and refresh ranking instantly.

## 10. Testing

```bash
npm test                 # end-to-end smoke tests (test/smoke.mjs, generates fixture data)
npm run test:access      # access-control tests (test/access-control.mjs)
npm run verify:driver    # driver feasibility checks (test/verify-driver.mjs)
npm run smoke            # alias of test
```
`verify-driver.mjs` auto-detects the runtime (Node / Bun) and verifies driver methods & FTS5 features; `smoke.mjs` builds fixture source DBs and covers search / keywords / rebuild / mutual exclusion / error propagation, on both Node and Bun.

## 11. Operations Notes

- **Startup**: the service listens first; index sync runs in the background (log: `[index] indexed N rows`); responsive immediately, no need to wait.
- **Manual rebuild**: Web "Settings → Rebuild Index", or `POST /api/reindex`. Runs in a dedicated worker thread (Node) / child process (Bun); **pages and search stay available** (results may be temporarily incomplete during rebuild — inherent to online rebuilds). Manual sync via `POST /api/sync`.
- **Incremental sync**: a one-time `last_rowid` catch-up runs on startup; there is no auto-sync at runtime. Periodic maintenance is the `REINDEX_CRON` scheduled full rebuild (disabled by default) which rebuilds once when its time comes.
- **Performance tuning**: SQLite PRAGMAs (WAL, cache_size, mmap_size, temp_store etc.) are preset per scenario in `db.js`; usually no changes needed. For very large indexes, switch `optimizeFts()` back to step-wise merges to lower the optimize memory peak.

## 12. RPC Push (aria2 / Motrix)

The result card provides a **push** icon button (right of the "Thunder download" button) sending the magnet link via JSON-RPC 2.0 `aria2.addUri` to a local downloader. Address & secret are configured in the **Settings** dialog:

- **Address**: default `http://localhost:16800/jsonrpc`
- **Secret**: optional; when set, `token:<secret>` is prepended to request `params` per aria2 convention (empty = no secret)

Stored in browser `localStorage`. Results appear as toasts (success shows the task GID; failure shows the error).

### Prerequisite: enable JSON-RPC and CORS on the downloader
Cross-origin `fetch` from the search site (e.g. `localhost:3000`) to the downloader's RPC port is subject to CORS; start the downloader with:

```bash
aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all
```

Motrix: enable "allow requests from all origins" in settings. Pushes fail with network errors otherwise.

## 13. exe Usage Guide (beginner-friendly)

> For end users receiving the zip. You need **no runtime installed and no coding skills** — just follow the three steps below.

### 13.1 What you need

- A Windows PC (Windows 10 / 11, Server 2016+);
- A magnet database file named **`magnet.db`** — produced by a DHT collection program (crawler); **this software only searches, it does not collect**;
- That's all — nothing else to install.

### 13.2 Know the extracted layout

Extract the zip anywhere (prefer a path without Chinese characters or spaces, e.g. `D:\DHT-Search\`):

```
DHT-Search\
├── DHT-Search.exe   ← main program, double-click to start
├── config.js        ← config file, editable with Notepad
├── README.md        ← this document
├── public\          ← web UI files (read by the program, do not modify)
└── data\            ← data directory (database goes here)
    └── magnet.db    ← magnet database file
```

Distinguish the two kinds of files in `data\`:

| File | What it is | Deletable? |
|------|--------|----------|
| `magnet.db` | **Raw data** (you copied it in) | ❌ Never delete — data would be lost |
| `dht.search.db` (plus `.db-wal` / `.db-shm`) | Search index, **auto-generated** cache | ✅ Yes; rebuilt automatically at next start (takes time again) |

> Note: the installation zip by default **does not include the `data` directory or any database** — database and index are your personal data and are not distributed with the software. If `data` is missing after extraction, create it as described next (the program also creates it automatically at startup).

### 13.3 Step 1: put the database into the data directory

1. Locate your `magnet.db` (the crawler's output);
2. **Copy** (Ctrl+C) it, open the software's `data` folder (if missing, **create** one named exactly `data` inside the DHT-Search directory), and **paste** (Ctrl+V);
3. Make sure the filename is **exactly** `magnet.db` — if it is `magnet(1).db` or similar, right-click → rename to `magnet.db`;
4. If the file is too large to copy, leave it in place and point the config to it — see `SOURCE_DB_PATH` in 13.6.

### 13.4 Step 2: start the program

1. **Double-click `DHT-Search.exe`**;
2. A **black console window** appears — this is the program's "engine" showing logs. **Do not close it while using**; minimize instead;
3. **The first start** builds the search index automatically:
   - Small data: seconds to minutes;
   - Large data (millions of rows): possibly 10-30+ minutes;
   - The web page works during this, but results are incomplete — **that is normal**; progress shows in the window (`indexed N rows`);
4. To exit: just close the black window.

> Tip: if a prebuilt `dht.search.db` index ships with the package, the first start loads it directly — ready in seconds.

### 13.5 Step 3: open the web page

- **On this machine**: open a browser (Edge / Chrome), visit `http://localhost:3000`;
- **Other devices on the same LAN** (phone / other PCs): visit `http://<this PC's IP>:3000`. To find the IP: press `Win + R`, type `cmd`, Enter; type `ipconfig`, Enter; look for "IPv4 Address" (e.g. `192.168.1.5`);
- By default only **localhost and private-network devices** are allowed — LAN access works out of the box;
- Type keywords in the search box and press Enter; open a result card for the file tree, magnet copy, and push to aria2 / Motrix (Chapter 12).

### 13.6 Change configuration (optional)

Open `config.js` with **Notepad**, save, and **restart** (close the black window, double-click the exe). The most common items:

| What to change | Which line | Example |
|----------|----------|------|
| Web port (3000 taken) | `PORT` | `export const PORT = 8080;` |
| Database elsewhere | `SOURCE_DB_PATH` | `export const SOURCE_DB_PATH = 'D:/mydb/magnet.db';` (use `/` not `\`) |
| Allow more/fewer devices | `ALLOWED_CLIENTS` | add a line like `'192.168.1.100',` in the brackets |
| Temporarily disable the IP whitelist | `ACCESS_CONTROL_MODE` | set to `'off'` (**never on public internet**) |
| Scheduled rebuild time | `REINDEX_CRON` | cron expression (e.g. `'0 4 * * *'` for daily 04:00); empty `''` disables scheduled rebuild (startup sync + manual only) |

Notes:

- Each line is `export const name = value;` — **only change the value after `=`**; leave quotes, semicolons, brackets untouched;
- Broke it? Delete `config.js` and restart — the program falls back to factory defaults (a note appears in the window);
- The program reads the config.js **next to the exe**; edits to the source-tree copy do not affect the exe.

### 13.7 Daily use & maintenance

- **New data in the database**: a one-time catch-up runs on startup; for periodic auto-refresh configure `REINDEX_CRON` (e.g. `'0 4 * * *'`) for a daily off-peak full rebuild, or click "Sync" in the Settings panel to catch up now;
- **Odd results / want a clean slate**: click "Rebuild Index" in Settings (usage unaffected during rebuild);
- **Backup**: copy the whole folder. `data\dht.search.db` is a cache-like index and can be skipped; `magnet.db` is the raw data — **keep it**;
- **Upgrade**: overwrite the exe with the new one; `data` and other files stay;
- **Move to another PC**: copy the whole folder.

### 13.8 Troubleshooting

| Symptom | Cause & fix |
|------|-----------|
| Black window flashes and disappears | Usually `magnet.db` missing from `data`, or wrong name/format. Double-click again and quickly read the red error text before the window closes |
| Page shows 403 / access denied | Your IP is not whitelisted: add it to `ALLOWED_CLIENTS` in `config.js` (e.g. `'192.168.1.100',`), save and restart |
| Page unreachable (connection refused) | Program failed to start, or port 3000 is taken: change `PORT` in `config.js` and retry |
| Results incomplete / counts low | First-time index still building — wait for the progress to finish; or a sync is midway |
| Search spins with no results | Make sure the black window is still open (program running); make sure indexing finished; otherwise click "Rebuild Index" in Settings |
| Want friends on the internet to access | Port-forward on your router (external port → this PC's 3000) and add their public IP to `ALLOWED_CLIENTS`. **Do not** disable the whitelist on the public internet |
| Red error text in the window | Screenshot/copy the error, check the config against this document, or report it with the error |

## 14. Data Source & Open-source Acknowledgements

The magnet data consumed by this project comes from the crawling results of the open-source project [**p2pspider**](https://github.com/thejordanprice/p2pspider) against the BitTorrent DHT network — with thanks:

- [p2pspider](https://github.com/thejordanprice/p2pspider) is a Node.js BitTorrent DHT crawler (implements BEP 0005 / 0003 / 0010 / 0009), released under the **MIT License**;
- This project **contains no code** from p2pspider; it only consumes the database file (`data/magnet.db`) produced by its crawling;
- This project and its distribution packages **do not distribute any crawled data** (the `data/` directory is excluded from packages; users prepare their own), which also echoes the p2pspider author's request not to share crawled data on the internet;
- Thanks to [thejordanprice](https://github.com/thejordanprice) and the open-source community.

## 15. Disclaimer & License

### Disclaimer

- This project only indexes resource metadata (magnet links, file names, sizes etc.) **publicly broadcast** on the DHT network (the BitTorrent public distributed hash table); it **does not store, provide, or host any content files themselves**;
- Crawled results may contain indexes to sensitive, illegal, or copyrighted content. **Users must comply with the laws and regulations of their country/region** and must not use this project to infringe intellectual property or other legitimate rights;
- This project is provided "as is", without warranty of any kind; users bear full responsibility for any issues arising from its use.

### License

This project is released under the [MIT License](./LICENSE):

- Anyone may freely use, copy, modify, merge, publish, distribute, sublicense the software, provided the original copyright and permission notices are retained in all copies;
- When forking / redistributing, please also keep the data-source acknowledgement in this README (open-source spirit);
- Dependencies (express / drizzle-orm / better-sqlite3 / archiver / lru-cache / chalk etc.) are all under permissive licenses (MIT / BSD / Apache-2.0) with no copyleft concerns.
