/**
 * magnets 表数据访问模块（影子索引架构，drizzle-orm 驱动）
 * ------------------------------------------------------------------
 * 源库（data/magnet.db，由其他应用写入）在构建索引时以只读方式打开读取，
 * 查询期完全不触碰源库。本模块在另一可写库（默认 data/dht.search.db）中维护：
 *   - magnets_fts    contentless FTS5 倒排索引（只存 name / files 的索引）
 *   - magnets_docs   去规范化副本（id + 展示/排序所需列），供检索 JOIN
 *   - sync_meta      同步水位（tokenizer / last_rowid）
 *
 * 查询由 drizzle-orm 驱动：常规表（magnets_docs / sync_meta）用 query builder；
 * FTS5 虚表没有 drizzle 原生支持，检索与 DDL 走参数化 raw SQL（sql`` 模板）。
 *
 * 运行时自动检测（见 ./db-driver.js）：
 *   - Node 环境   -> better-sqlite3   + drizzle-orm/better-sqlite3
 *   - Bun 等环境  -> bun:sqlite        + drizzle-orm/bun-sqlite
 * 业务代码通过 db-driver 的统一接口访问底层连接，无需关心具体驱动。
 *
 * 暴露能力：
 *   countMagnets()   —— 已索引条数
 *   searchMagnets()  —— 对 name / files 两列做 FTS5 模糊搜索，支持分页与
 *                       可选排序（不传 sortBy 按 id；relevance 按 bm25）
 *   reindex()        —— 全量重建影子索引（异步；Node 走 worker 线程，Bun 退化为同进程）
 *   rebuildSync()    —— 同上但在当前进程内同步执行（供 worker / 脚本使用）
 *   close()          —— 关闭连接
 *
 * 同步策略：启动时按 last_rowid 增量补录新行；tokenizer 变更或索引为空时
 * 全量重建。源库中对已有行的 UPDATE / DELETE 不会自动反映，需调用 reindex()
 * 全量重建（JOIN 会自动丢弃源中已删除的残留行）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  isBun,
  openDatabase,
  createDrizzle,
  setPragma,
  getPragma,
  getRow,
  allRows,
  pluckAll,
  prepareStmt,
  runStmt,
  transaction,
  closeDb,
} from './db-driver.js';
import { sql, eq, count } from 'drizzle-orm';
import { magnetsDocs, syncMeta } from './schema.js';
import {
  CONFIG,
  resolveDbPath,
  DEFAULT_DB_PATH,
  DEFAULT_INDEX_DB_PATH,
  TABLE,
  FTS_TABLE,
  DOCS_TABLE,
  KEYWORD_TABLE,
  KEYWORD_FILTER_TABLE,
  TOKENIZER,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORT_COLUMNS,
} from './store.js';

/**
 * 排序 SQL 白名单。ORDER BY 的列名与方向无法参数化，故写死为常量按需取用，
 * 杜绝注入。未传 sortBy 时回退为 id 列排序，且方向跟随 order（默认 desc=倒序）；
 * 带次排序键 id 保证分页稳定。relevance 用 bm25(fts) —— 值越小越相关，
 * 故 relevance:desc 取 ASC。
 */
const ORDER_SQL = Object.freeze({
  'id:asc': `ORDER BY m.id ASC`,
  'id:desc': `ORDER BY m.id DESC`,
  'fetchedAt:asc': 'ORDER BY m.fetchedAt ASC, m.id ASC',
  'fetchedAt:desc': 'ORDER BY m.fetchedAt DESC, m.id DESC',
  'totalSize:asc': 'ORDER BY m.totalSize ASC, m.id ASC',
  'totalSize:desc': 'ORDER BY m.totalSize DESC, m.id DESC',
  'relevance:asc': `ORDER BY bm25(${FTS_TABLE}) DESC, m.id ASC`,
  'relevance:desc': `ORDER BY bm25(${FTS_TABLE}) ASC, m.id ASC`,
});

/** 检索返回列（来自副本表） */
const SELECT_COLUMNS = 'm.id, m.name, m.infohash, m.magnet, m.files, m.totalSize, m.fetchedAt';

/** 只保留字母与数字，用于从用户输入中提取安全 token */
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/** 热词统计来源列：只统计 name，避开 files JSON 键名（path/size）噪声 */
const KEYWORD_SOURCE = 'name';
/** 热词过滤：低于此长度的 token 丢弃（去单字符噪声） */
const MIN_KEYWORD_LEN = 2;
/** 热词过滤：纯数字 token（年份/大小等噪声）丢弃 */
const NUMERIC_ONLY = /^\d+$/;

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把用户输入清洗为安全的 FTS5 MATCH 表达式。
 *
 * FTS5 的 MATCH 语法含 AND / OR / NOT / NEAR / * / " / : 等操作符，
 * 原始输入直接拼入会抛 `fts5: syntax error`。这里采用白名单提取：
 * 只保留字母数字 token，双引号包裹，AND 连接，末位 token 追加 '*' 实现前缀匹配。
 *
 * @param {unknown} input 用户输入的搜索串
 * @returns {string|null} 清洗后的 MATCH 表达式；无有效 token 时返回 null
 */
export function buildMatchExpression(input) {
  if (input === null || input === undefined) return null;
  const tokens = String(input).match(TOKEN_PATTERN);
  if (!tokens || tokens.length === 0) return null;

  return tokens
    .map((token, index) => {
      const isLast = index === tokens.length - 1;
      // unicode61 会做大小写折叠，这里统一转小写保证确定性
      return `"${token.toLowerCase()}"${isLast ? '*' : ''}`;
    })
    .join(' AND ');
}

/** 把任意值钳制为 [min, max] 区间内的整数 */
function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.floor(num), min), max);
}

/**
 * 统一规范化检索的分页与排序参数（searchMagnets / searchByHash 共用）。
 * 未传 sortBy 时按 id 排序（'' 键），order 仅对显式 sortBy 生效；
 * limit 传 <=0 或不传表示不限制，否则钳制到 1..MAX_LIMIT。
 * @returns {{ orderSql: string, limit: number, offset: number }}
 */
function normalizeQueryOptions({ sortBy, order, limit, offset }) {
  const direction = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
  // 未传 sortBy 时回退到 id 列，但方向仍跟随 order（默认 desc=倒序），
  // 这样默认视图下点「正序/倒序」也能立即改变结果，而不会忽略方向
  const sortKey = SORT_COLUMNS.includes(sortBy) ? `${sortBy}:${direction}` : `id:${direction}`;
  return {
    orderSql: ORDER_SQL[sortKey],
    limit:
      limit === undefined || limit === null || Number(limit) <= 0
        ? -1
        : clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** files 在库中是 JSON 字符串，返回时解析为对象，失败则保留原始字符串 */
function parseFiles(raw) {
  if (raw === null || raw === undefined) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 把数据库行加工为对外返回的行对象 */
function mapRow(row) {
  return { ...row, files: parseFiles(row.files) };
}

/** 从文本提取合格的热词 token（与 unicode61 折叠行为对齐：小写 + 去噪） */
function keywordTokens(text) {
  return String(text ?? '').match(TOKEN_PATTERN)
    ?.map((t) => t.toLowerCase())
    .filter((w) => w.length >= MIN_KEYWORD_LEN && !NUMERIC_ONLY.test(w)) ?? [];
}

/* ------------------------------------------------------------------ */
/* 源库只读连接                                                        */
/* ------------------------------------------------------------------ */

/** 以只读方式打开源库（构建索引时读取用，查询期不持有） */
function openSourceRO(sourcePath) {
  const src = openDatabase(sourcePath, { readonly: true });
  // 双重保险：连接层只读 + 引擎级禁止任何写入语句
  setPragma(src, 'query_only', 'ON');
  // 全表顺序扫描不需要 mmap：扫过的页会全部计入 RSS，2GB 库下白白吃掉几百 MB
  setPragma(src, 'mmap_size', 0);
  setPragma(src, 'cache_size', -16000);
  return src;
}

/* ------------------------------------------------------------------ */
/* 索引维护（影子索引库内，db 为 drizzle 可写实例）                     */
/* ------------------------------------------------------------------ */

function maxSourceId(src) {
  return getRow(src, `SELECT coalesce(max(id), 0) AS m FROM ${TABLE}`).m;
}

function getMeta(db, key) {
  const row = db.select({ value: syncMeta.value }).from(syncMeta)
    .where(eq(syncMeta.key, key)).get();
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.insert(syncMeta).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: syncMeta.key, set: { value: String(value) } })
    .run();
}

function tableExists(db, name) {
  // 注意：drizzle 在 Bun 下的裸 db.get() 返回行数组而非单行对象，
  // 故统一用 db.all(...)[0] 取首行，Node / Bun 行为一致。
  return db.all(sql`SELECT 1 FROM sqlite_master WHERE name = ${name}`)[0] != null;
}

/** 清空并重建 FTS5 虚表（contentless） */
function buildFts(db) {
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(FTS_TABLE)}`);
  db.run(sql`CREATE VIRTUAL TABLE ${sql.raw(FTS_TABLE)} USING fts5(
    name, files, content='', tokenize=${sql.raw(`'${TOKENIZER}'`)}
  )`);
}

const DOCS_COLUMNS = 'id, name, infohash, magnet, files, totalSize, fetchedAt';

/** 每批写入事务的行数上限；分批改写以限制全量重建时的内存峰值 */
const REBUILD_BATCH = 2000;
/**
 * 每批写入事务的字节上限（按 name + files 的字符数估算）。
 * 只按行数分批时，多文件种子的 files JSON 可达几十 KB，单批仍可能撑到几百 MB，
 * 故行数与字节数两个阈值先到先生效。
 * 注：对中文字符（V8 内部按 2 字节存储）会低估约一倍，属于偏安全的方向。
 */
const REBUILD_BATCH_BYTES = 16 * 1024 * 1024;
/** reindex worker 入口（与 db.js 同目录） */
const REINDEX_WORKER_URL = new URL('./reindex-worker.js', import.meta.url);

/**
 * 按 id 升序分段扫描源表，逐行 yield（流式，不物化整表）。
 *
 * 相比单个跨越全表的大游标：
 *   - 每段一个独立短游标，不长时间占用源库读快照（源库非 WAL 时尤其重要）；
 *   - 单段失败可从该 id 续跑；
 *   - 进度可精确上报。
 *
 * 依赖 magnets.id 为 INTEGER PRIMARY KEY（rowid），此时 WHERE id > ? 走 rowid 区间扫描，
 * 代价与全表顺序扫描相当；若源库 id 只是普通索引列，ORDER BY 保证结果仍然正确，仅略慢。
 *
 * from 为开区间下界，调用方需保证它小于待扫描的最小 id：
 * 全量重建传 min(id) - 1（避免漏掉 id <= 0 的行），增量补录传 last_rowid。
 *
 * 实现上按批 allRows 取数（每批仍受 REBUILD_BATCH 限制），绕开 better-sqlite3 /
 * bun:sqlite 在 stmt.iterate() 参数签名上的差异，且内存峰值不变。
 */
function* scanById(src, { from = 0, size = REBUILD_BATCH } = {}) {
  let cursor = from;
  for (;;) {
    const rows = allRows(
      src,
      `SELECT ${DOCS_COLUMNS} FROM ${TABLE} WHERE id > ? ORDER BY id LIMIT ?`,
      [cursor, size]
    );
    if (rows.length === 0) return;
    let last = cursor;
    for (const row of rows) {
      last = row.id;
      yield row;
    }
    if (rows.length < size) return;
    cursor = last;
  }
}

/**
 * 用源库行填充 FTS 与副本表。
 *
 * 热路径绕过 drizzle 的 sql`` 模板：后者每次 run() 都会重新 prepare 一条语句
 * （drizzle 的 SQLiteSession 无语句缓存），每行一次的 Statement 包装对象分配会带来
 * 明显的 GC 压力。这里改为整个重建复用 3 条 prepared statement（bun 下 query() 自带
 * 字节码缓存，等价于手工复用 prepare 的优化）。
 *
 * 注意：SQLite 这个构建禁用了双引号字符串字面量，原生 SQL 里的字面量一律用单引号。
 *
 * @param {db}        db            可写连接（drizzle 实例）
 * @param {Iterable}  rowsIterable  源行迭代器（数组或 scanById() 生成器）
 * @param {(info: { rows: number }) => void} [onFlush] 每批落库后回调，rows 为本批行数
 */
function populate(db, rowsIterable, onFlush) {
  // drizzle 实例上的 $client 即底层原生连接（bun:sqlite 或 better-sqlite3）
  const raw = db.$client ?? db.session?.client;

  const insertFts = prepareStmt(raw, `INSERT INTO ${FTS_TABLE} (rowid, name, files) VALUES (?, ?, ?)`);
  // 副本表用 OR REPLACE：重复 id 时覆盖而非抛错，增量补录更稳。
  // FTS 侧不能这样写 —— contentless FTS5 不支持 REPLACE 冲突处理。
  const insertDoc = prepareStmt(raw, `INSERT OR REPLACE INTO ${DOCS_TABLE}
       (id, name, infohash, magnet, files, totalSize, fetchedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const upsertKw = prepareStmt(raw, `INSERT INTO ${KEYWORD_TABLE} (term, doc_count, occurrences) VALUES (?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET
       doc_count = doc_count + excluded.doc_count,
       occurrences = occurrences + excluded.occurrences`);
  const runBatch = transaction(raw, (rows, kws) => {
    for (const r of rows) runStmt(insertFts, [r.id, r.name, r.files]);
    for (const r of rows) {
      runStmt(insertDoc, [r.id, r.name, r.infohash, r.magnet, r.files, r.totalSize, r.fetchedAt]);
    }
    for (const [term, k] of kws) runStmt(upsertKw, [term, k.doc, k.occ]);
  });

  // 热词过滤集：populate 前从过滤表加载，统计时排除用户配置的噪声词
  const filter = new Set(pluckAll(raw, `SELECT term FROM ${KEYWORD_FILTER_TABLE}`));
  /** 热词累计：term -> { doc, occ }，随批次 flush 落库，控制内存峰值 */
  const kwMap = new Map();
  const seen = new Set(); // 复用，避免每行 new Set()
  let buf = [];
  let bytes = 0;

  const flush = () => {
    if (!buf.length) return;
    runBatch(buf, kwMap);
    onFlush?.({ rows: buf.length });
    buf = [];
    bytes = 0;
    kwMap.clear();
  };

  for (const r of rowsIterable) {
    buf.push(r);
    bytes += (r.name?.length ?? 0) + (r.files?.length ?? 0);
    // 热词统计：同一文档内去重，doc_count 只计一次
    seen.clear();
    for (const w of keywordTokens(r[KEYWORD_SOURCE])) {
      if (filter.has(w)) continue;
      const e = kwMap.get(w) ?? { doc: 0, occ: 0 };
      e.occ += 1;
      if (!seen.has(w)) {
        seen.add(w);
        e.doc += 1;
      }
      kwMap.set(w, e);
    }
    if (buf.length >= REBUILD_BATCH || bytes >= REBUILD_BATCH_BYTES) flush();
  }
  flush();
}

/**
 * 合并 FTS5 segment（等价于 'optimize'）。
 * 注：'optimize' 会一次性把所有 b-tree 合并成单个 segment，内存峰值与索引规模成正比；
 * 若索引规模可控（数百 MB 以内）这种一次性写法足够清晰，超大索引需改回分步合并。
 * @param {number} [level=4] 合并等级，4 为 FTS5 推荐的默认值
 */
function optimizeFts(db, level = 4) {
  db.run(sql`INSERT INTO ${sql.raw(FTS_TABLE)} (${sql.raw(FTS_TABLE)}, rank)
    VALUES ('optimize', ${level})`);
}

/**
 * 全量重建：按 id 分段扫描源库灌入所有行，最后增量合并索引段。
 *
 * 建表 DDL 整体包在一个事务里：重建与查询是并发的（reindex() 在 worker 线程执行），
 * 若 DROP 与 CREATE 分处两个事务，其他连接可能观察到「DROP 已执行、CREATE 还没执行」
 * 的中间态而拿到 "no such table" 错误 —— 这是 schema 错误，busy_timeout 兜不住。
 *
 * populate 期间 countMagnets() 会从 0 递增、检索结果不完整，属于在线重建的固有代价。
 *
 * @param {Function} [onFlush] 每批落库后回调，参数为 { rows }
 */
function fullRebuild(db, src, onFlush) {
  const raw = db.$client ?? db.session?.client;
  raw.transaction(() => {
    buildFts(db);
    db.run(sql`DROP TABLE IF EXISTS ${sql.raw(DOCS_TABLE)}`);
    db.run(sql`CREATE TABLE ${sql.raw(DOCS_TABLE)} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      infohash TEXT,
      magnet TEXT,
      files TEXT,
      totalSize INTEGER NOT NULL DEFAULT 0,
      fetchedAt INTEGER NOT NULL DEFAULT 0
    )`);
    // 热词统计表：全量重建时清空重建，随 populate 重新统计
    db.run(sql`DROP TABLE IF EXISTS ${sql.raw(KEYWORD_TABLE)}`);
    db.run(sql`CREATE TABLE ${sql.raw(KEYWORD_TABLE)} (
      term TEXT PRIMARY KEY,
      doc_count INTEGER NOT NULL DEFAULT 0,
      occurrences INTEGER NOT NULL DEFAULT 0
    )`);
  })();

  // 从 min(id) - 1 起扫：改前的全表扫描不带 WHERE，会包含所有行；
  // 换成 keyset 后若从 0 起（id > 0）会静默漏掉 id <= 0 的行。
  // id 是 rowid 时 min(id) 是一次 O(1) 查找，代价可忽略。
  const minId = getRow(src, `SELECT min(id) AS m FROM ${TABLE}`)?.m;
  populate(
    db,
    scanById(src, { from: minId == null ? 0 : Number(minId) - 1, size: REBUILD_BATCH }),
    onFlush
  );

  // 二级索引放到灌数据之后建：空表建索引会让后续每条 INSERT 都维护两个 B-Tree，
  // 写入慢 2~3 倍；先灌数据再建索引是批量排序构建，快得多。
  db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_fetchedAt`)} ON ${sql.raw(DOCS_TABLE)}(fetchedAt)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_totalSize`)} ON ${sql.raw(DOCS_TABLE)}(totalSize)`);

  setMeta(db, 'tokenizer', TOKENIZER);
  setMeta(db, 'last_rowid', String(maxSourceId(src)));
  optimizeFts(db);
}

/**
 * 启动同步：tokenizer 不符或索引为空则全量重建；
 * 否则按 last_rowid 增量补录源库中新增的行。
 */
function syncIndex(db, src, onFlush) {
  const ftsExists = tableExists(db, FTS_TABLE);
  const docsExists = tableExists(db, DOCS_TABLE);
  const stored = getMeta(db, 'tokenizer');
  // 表缺失或 tokenizer 变更 → 全量重建；否则按 last_rowid 增量补录
  if (!ftsExists || !docsExists || stored !== TOKENIZER) {
    fullRebuild(db, src, onFlush);
    return;
  }
  const last = Number(getMeta(db, 'last_rowid') ?? '0');
  const max = maxSourceId(src);
  if (max > last) {
    // keyset 分段 + 流式迭代，避免 .all() 把数百万行一次性物化进堆
    populate(db, scanById(src, { from: last, size: REBUILD_BATCH }), onFlush);
    setMeta(db, 'last_rowid', String(max));
    optimizeFts(db);
  }
}

/* ------------------------------------------------------------------ */
/* 工厂函数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 打开影子索引库并构建/同步索引，返回查询句柄。
 *
 * @param {Object|string} [options] 源库路径字符串，或 { source, indexDbPath }
 * @param {string} [options.source]      源库路径，默认 process.env.DHT_DB_PATH 或 data/magnet.db
 * @param {string} [options.indexDbPath] 影子索引库路径，默认 process.env.DHT_INDEX_DB_PATH 或 data/dht.search.db
 * @param {boolean} [options.sync=true]  打开时是否执行同步（全量重建 / 增量补录）；
 *        传 false 则只建立连接不建索引，供 reindex worker 使用
 */
export function createMagnetDb(options = {}) {
  const opts = typeof options === 'string' ? { source: options } : options;
  // 优先级：调用方显式传入 > config.json > 环境变量 > 模块内默认值
  const sourcePath = resolveDbPath(
    opts.source ?? CONFIG.sourceDbPath ?? process.env.DHT_DB_PATH ?? DEFAULT_DB_PATH
  );
  const indexPath = resolveDbPath(
    opts.indexDbPath ?? CONFIG.indexDbPath ?? process.env.DHT_INDEX_DB_PATH ?? DEFAULT_INDEX_DB_PATH
  );

  fs.mkdirSync(path.dirname(path.resolve(indexPath)), { recursive: true });

  // 可写连接：仅供 syncIndex / reindex / fullRebuild 等索引维护使用
  const wdb = openDatabase(indexPath);
  setPragma(wdb, 'busy_timeout', 5000);
  setPragma(wdb, 'journal_mode', 'WAL');
  // 重建期间不需要 mmap；temp_store 改 FILE，把排序/临时页交给磁盘而不是内存
  // （temp_store = MEMORY 的临时页不受 cache_size 限制，2GB 级排序会吃掉几百 MB）
  setPragma(wdb, 'mmap_size', 0);
  setPragma(wdb, 'cache_size', -32000);
  setPragma(wdb, 'synchronous', 'NORMAL');
  setPragma(wdb, 'temp_store', 'FILE');
  const db = createDrizzle(wdb);

  // 同步水位表（drizzle 不自动建表，按你的选择由 raw DDL 维护）
  db.run(sql`CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)`);

  // 热词统计表（同样由 raw DDL 维护；fullRebuild 会 DROP 重建保证干净）
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KEYWORD_TABLE)} (
    term TEXT PRIMARY KEY,
    doc_count INTEGER NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 0
  )`);
  // 热词过滤表（用户配置；reindex 不清除，仅启动时确保存在）
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KEYWORD_FILTER_TABLE)} (
    term TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT 0
  )`);

  // 源库只读打开（构建时读取），并校验表存在 / 提示 WAL 模式
  const src = openSourceRO(sourcePath);
  try {
    const srcMode = getPragma(src, 'journal_mode').journal_mode;
    if (srcMode !== 'wal') {
      console.warn(`[warn] 源库非 WAL 模式（${srcMode}）：构建索引时的只读扫描可能与写入进程争用锁`);
    }
    if (!getRow(src, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, [TABLE])) {
      throw new Error(`源库 ${sourcePath} 中不存在 ${TABLE} 表`);
    }
    // sync: false 供 reindex worker 使用：它只为重建而来，不必先跑一次增量同步
    if (opts.sync !== false) {
      let done = 0;
      let logged = 0;
      let nextLog = 100000;
      syncIndex(db, src, ({ rows }) => {
        done += rows;
        if (done >= nextLog) {
          nextLog = done + 100000;
          logged = done;
          console.log(`[index] 已索引 ${done} 行`);
        }
      });
      // 进度按阈值打印，最后一批不足一个阈值时上面不会触发，这里补打总数，
      // 否则「已索引 100000 行」看起来会像是提前停了
      if (done > logged) console.log(`[index] 索引完成，共 ${done} 行`);
    }
  } finally {
    src.close();
  }

  // 查询专用只读连接：searchMagnets / countMagnets 仅在此连接上执行 SELECT，
  // 在代码层面杜绝查询路径修改数据库。源库本就只读，索引库的写操作只发生在 syncIndex / reindex。
  const rdb = openDatabase(indexPath, { readonly: true });
  setPragma(rdb, 'query_only', 'ON');
  // 重建在 worker 线程并发进行，读连接遇到写锁要等待而不是立刻抛 SQLITE_BUSY
  setPragma(rdb, 'busy_timeout', 5000);
  setPragma(rdb, 'cache_size', -32000);
  setPragma(rdb, 'mmap_size', 134217728);
  const dbRO = createDrizzle(rdb);

  // reindex worker 的堆上限与超时；超时传 0 表示不限时
  const REINDEX_TIMEOUT_MS = clampInt(CONFIG.reindexTimeoutMs, 0, 0, Number.MAX_SAFE_INTEGER);

  let reindexWorker = null;
  let reindexPromise = null;

  /** 派生 worker 线程执行重建（仅 Node 路径使用） */
  function spawnReindexWorker(onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(REINDEX_WORKER_URL, {
        workerData: { sourcePath, indexPath },
        // 堆触顶时 worker 会以 ERR_WORKER_OUT_OF_MEMORY 退出，只杀 worker，主进程不受影响
        resourceLimits: { maxOldGenerationSizeMb: clampInt(CONFIG.reindexMaxOldSpaceMb, 2048, 256, 65536) },
        stdout: true,
        stderr: true,
      });
      reindexWorker = worker;

      let settled = false;
      let timer = null;
      const settle = (ok, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reindexWorker = null;
        if (!ok) worker.terminate();
        (ok ? resolve : reject)(value);
      };

      if (REINDEX_TIMEOUT_MS > 0) {
        timer = setTimeout(
          () => settle(false, new Error(`reindex 超时（${REINDEX_TIMEOUT_MS}ms）`)),
          REINDEX_TIMEOUT_MS
        );
      }
      worker.on('message', (msg) => {
        if (msg?.type === 'progress') {
          onProgress?.(msg);
          return;
        }
        if (msg?.ok) settle(true, msg.indexed);
        else settle(false, new Error(msg?.error || 'reindex failed'));
      });
      worker.on('error', (err) => settle(false, err));
      worker.on('exit', (code) => {
        if (!settled) settle(false, new Error(`reindex 进程异常退出（code=${code}）`));
      });
    });
  }

  /** 已索引条数（与检索结果一致） */
  function countMagnets() {
    return Number(dbRO.select({ total: count() }).from(magnetsDocs).get()?.total ?? 0);
  }

  /**
   * 热词榜：按文档频率降序返回 top N 关键词。
   * @param {number} [limit=50] 返回条数，钳制 1..1000
   * @returns {Array<{term: string, doc_count: number, occurrences: number}>}
   */
  function topKeywords(limit = 50) {
    return dbRO.all(sql`
      SELECT term, doc_count, occurrences
      FROM ${sql.raw(KEYWORD_TABLE)} k
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sql.raw(KEYWORD_FILTER_TABLE)} f WHERE f.term = k.term
      )
      ORDER BY doc_count DESC, occurrences DESC
      LIMIT ${clampInt(limit, 50, 1, 1000)}
    `);
  }

  /** 列出当前热词过滤词（按 term 排序） */
  function listKeywordFilters() {
    return dbRO.all(sql`
      SELECT term, created_at
      FROM ${sql.raw(KEYWORD_FILTER_TABLE)}
      ORDER BY term
    `);
  }

  /** 添加热词过滤词（幂等，小写归一；增量统计与热词榜均立即生效） */
  function addKeywordFilter(term) {
    const t = String(term).trim().toLowerCase();
    if (!t) throw new TypeError('addKeywordFilter: term 不能为空');
    db.run(sql`INSERT OR IGNORE INTO ${sql.raw(KEYWORD_FILTER_TABLE)} (term, created_at)
      VALUES (${t}, ${Date.now()})`);
    return t;
  }

  /** 删除热词过滤词（删除后该词重新出现在热词榜） */
  function removeKeywordFilter(term) {
    const t = String(term).trim().toLowerCase();
    if (!t) throw new TypeError('removeKeywordFilter: term 不能为空');
    db.run(sql`DELETE FROM ${sql.raw(KEYWORD_FILTER_TABLE)} WHERE term = ${t}`);
    return t;
  }

  /**
   * FTS5 模糊搜索（name + files 两列，files 按整个 JSON 字符串匹配）。
   *
   * @param {Object} options
   * @param {string}  options.query                   搜索关键词，必填；清洗后无有效 token 会抛错
   * @param {'fetchedAt'|'totalSize'|'relevance'} [options.sortBy] 排序列；不传则按 id 排序
   * @param {'asc'|'desc'} [options.order='desc']     排序方向，仅 sortBy 传入时生效
   * @param {number} [options.limit=20]               每页条数，钳制至 1..200；传 <=0 或不传表示不限制
   * @param {number} [options.offset=0]               偏移量，钳制至 >= 0
   * @returns {{ total: number, limit: number, offset: number, items: Array<Object> }}
   */
  /**
   * 把 minSize / maxSize（字节）构造为 SQL 过滤片段（数值已校验为有限非负）。
   * 返回 null 表示不加大小过滤。
   */
  function sizeFilterSql(minSize, maxSize) {
    const conds = [];
    const mn = Number(minSize);
    const mx = Number(maxSize);
    if (Number.isFinite(mn) && mn >= 0) conds.push(sql`m.totalSize >= ${mn}`);
    if (Number.isFinite(mx) && mx >= 0) conds.push(sql`m.totalSize <= ${mx}`);
    // 注意：bun 下 drizzle-orm/bun-sqlite 会把 sql.join 的字符串分隔符参数化成
    // 一个 `?`，导致 `>= ? AND <= ?` 错拼成 `>= ?? <= ?`。故改为显式拼接 SQL 片段。
    if (conds.length === 0) return null;
    if (conds.length === 1) return conds[0];
    return sql`${conds[0]} AND ${conds[1]}`;
  }

  /** 按 infohash 精确检索（大小写不敏感，支持前缀匹配） */
  function searchByHash({ query, sortBy, order = 'desc', limit, offset, minSize, maxSize }) {
    // 归一化：剥离 magnet 链接里的 urn:btih: 前缀，并去除所有非字母数字字符
    const raw = String(query)
      .replace(/^.*urn:btih:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
    if (!raw) {
      throw new TypeError('searchByHash: 未提供有效的 infohash');
    }
    const { orderSql, limit: lim, offset: off } = normalizeQueryOptions({ sortBy, order, limit, offset });
    const sf = sizeFilterSql(minSize, maxSize);
    const sizeCond = sf ? sql` AND ${sf}` : sql``;

    // 归一化匹配：兼容「带/不带 hash 前缀」两种 infohash 存储，并支持前缀检索
    const cond = sql`lower(m.infohash) = lower(${raw})
      OR lower(m.infohash) = lower(${'hash' + raw})
      OR lower(m.infohash) LIKE lower(${raw + '%'})`;
    const total = Number(dbRO.all(sql`
      SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)} m WHERE ${cond}${sizeCond}
    `)[0]?.total ?? 0);

    return {
      total,
      limit: lim,
      offset: off,
      items: dbRO.all(sql`
        SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
        WHERE ${cond}${sizeCond}
        ${sql.raw(orderSql)}
        LIMIT ${lim} OFFSET ${off}
      `).map(mapRow),
    };
  }

  function searchMagnets(options = {}) {
    const { query, sortBy, order = 'desc', by, minSize, maxSize } = options;

    // infohash 未进入 FTS 索引，按 hash 检索时单独走副本表
    if (by === 'hash') {
      return searchByHash({ query, sortBy, order, limit: options.limit, offset: options.offset, minSize, maxSize });
    }

    const match = buildMatchExpression(query);
    // FTS5 MATCH 必须接收「SQL 字符串字面量」形式的查询表达式（单引号包裹），
    // 否则 SQLite 会把双引号短语误当标识符、或把参数化占位符 ? 在 prepare 阶段
    // 抛 fts5: near "?"。match 已白名单化（仅字母数字/双引号/星号/AND），安全。
    const matchLit = `'${match}'`;
    if (!match) {
      throw new TypeError('searchMagnets: options.query 不能为空，且需包含至少一个字母或数字');
    }

    const { orderSql, limit, offset } = normalizeQueryOptions({
      sortBy,
      order,
      limit: options.limit,
      offset: options.offset,
    });

    const sf = sizeFilterSql(minSize, maxSize);
    const sizeCond = sf ? sql` AND ${sf}` : sql``;

    // total 走 JOIN：源中已删除的残留索引行会被自动剔除，保证 total 与返回数一致
    const total = Number(dbRO.all(sql`
      SELECT count(*) AS total FROM ${sql.raw(FTS_TABLE)} f
      JOIN ${sql.raw(DOCS_TABLE)} m ON m.id = f.rowid
      WHERE ${sql.raw(FTS_TABLE)} MATCH ${sql.raw(matchLit)}${sizeCond}
    `)[0]?.total ?? 0);

    return {
      total,
      limit,
      offset,
      items: dbRO.all(sql`
        SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(FTS_TABLE)} f
        JOIN ${sql.raw(DOCS_TABLE)} m ON m.id = f.rowid
        WHERE ${sql.raw(FTS_TABLE)} MATCH ${sql.raw(matchLit)}${sizeCond}
        ${sql.raw(orderSql)}
        LIMIT ${limit} OFFSET ${offset}
      `).map(mapRow),
    };
  }

  /**
   * 在当前进程内同步执行全量重建。供 reindex worker 调用；
   * 脚本 / 测试想跳过线程开销时也可直接用。
   * @param {(p: { done: number, total: number }) => void} [onProgress]
   * @returns {number} 索引文档数
   */
  function rebuildSync(onProgress) {
    const s = openSourceRO(sourcePath);
    try {
      let done = 0;
      fullRebuild(db, s, ({ rows }) => {
        done += rows;
        onProgress?.({ done, total: Number(getRow(s, `SELECT count(*) AS c FROM ${TABLE}`)?.c ?? 0) });
      });
    } finally {
      s.close();
    }
    return Number(dbRO.all(sql`SELECT count(*) AS c FROM ${sql.raw(FTS_TABLE)}`)[0]?.c ?? 0);
  }

  /**
   * 全量重建影子索引。
   * - Node 环境：在独立 worker 线程执行，不阻塞事件循环，worker OOM 只杀 worker。
   * - Bun 环境：node:worker_threads 覆盖不全、resourceLimits 不生效，退化为同进程
   *   同步重建（仍保持 Promise 形态，调用方无需关心差异）。
   * @param {(p: { done: number, total: number }) => void} [onProgress] 进度回调
   * @returns {Promise<number>} 索引文档数
   */
  function reindex(onProgress) {
    // 已有重建在跑则复用同一个 promise（注意：第二个调用方的 onProgress 不会生效）
    if (reindexPromise) return reindexPromise;
    if (isBun) {
      reindexPromise = (async () => {
        await new Promise((r) => setTimeout(r, 0)); // 让出事件循环，贴近异步语义
        return rebuildSync(({ done, total }) => onProgress?.({ done, total }));
      })().finally(() => {
        reindexPromise = null;
      });
      return reindexPromise;
    }
    reindexPromise = spawnReindexWorker(onProgress).finally(() => {
      reindexPromise = null;
    });
    return reindexPromise;
  }

  /**
   * 运行期增量补录：按 last_rowid 把源库新增行灌入索引（由 index.js 定时调用，默认每小时一次）。
   * 与 reindex() 互斥（reindexPromise 非空）：重建期间跳过本轮，下一周期再试。
   * 不触发全量重建——tokenizer 变更等结构性变更交由重启或手动 reindex 处理。
   * @param {(p: { done: number, total: number }) => void} [onProgress]
   */
  function syncIncremental(onProgress) {
    // 重建进行中（reindexPromise 非空）则跳过本轮，与 reindex 互斥
    if (reindexPromise) return;
    const src = openSourceRO(sourcePath);
    try {
      const last = Number(getMeta(db, 'last_rowid') ?? '0');
      const max = maxSourceId(src);
      if (max > last) {
        populate(db, scanById(src, { from: last, size: REBUILD_BATCH }), onProgress);
        setMeta(db, 'last_rowid', String(max));
        optimizeFts(db);
      }
    } finally {
      src.close();
    }
  }

  /** 关闭连接 */
  function close() {
    if (reindexWorker) {
      reindexWorker.terminate();
      reindexWorker = null;
    }
    closeDb(rdb);
    closeDb(wdb);
  }

  return {
    db,
    countMagnets,
    searchMagnets,
    topKeywords,
    listKeywordFilters,
    addKeywordFilter,
    removeKeywordFilter,
    reindex,
    syncIncremental,
    rebuildSync,
    close,
  };
}

export default createMagnetDb;
