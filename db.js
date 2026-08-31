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
 * 暴露能力：
 *   countMagnets()   —— 已索引条数
 *   searchMagnets()  —— 对 name / files 两列做 FTS5 模糊搜索，支持分页与
 *                       可选排序（不传 sortBy 按 id；relevance 按 bm25）
 *   reindex()        —— 全量重建影子索引（源被改/删后手动同步用）
 *   close()          —— 关闭连接
 *
 * 同步策略：启动时按 last_rowid 增量补录新行；tokenizer 变更或索引为空时
 * 全量重建。源库中对已有行的 UPDATE / DELETE 不会自动反映，需调用 reindex()
 * 全量重建（JOIN 会自动丢弃源中已删除的残留行）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql, eq, count } from 'drizzle-orm';
import { magnetsDocs, syncMeta } from './schema.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = path.join(MODULE_DIR, 'data', 'magnet.db');
export const DEFAULT_INDEX_DB_PATH = path.join(MODULE_DIR, 'data', 'dht.search.db');

/** 把配置里的库路径解析为绝对路径：绝对路径原样使用，相对路径基于模块目录 */
function resolveDbPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(MODULE_DIR, p);
}

/** 读取 config.json（不存在或非法时返回空对象，不阻塞启动） */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}
export const CONFIG = loadConfig();

/** 源库主表名 */
export const TABLE = 'magnets';
/** 影子索引库中的 contentless FTS5 表名 */
export const FTS_TABLE = 'magnets_fts';
/** 影子索引库中的去规范化副本表名（展示/排序用） */
export const DOCS_TABLE = 'magnets_docs';

export const TOKENIZER = 'unicode61 remove_diacritics 2';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

/** 允许参与排序的列白名单（relevance 走 bm25，其余走副本表列） */
export const SORT_COLUMNS = Object.freeze(['fetchedAt', 'totalSize', 'relevance']);

/**
 * 排序 SQL 白名单。ORDER BY 的列名与方向无法参数化，故写死为常量按需取用，
 * 杜绝注入。未传 sortBy 时走 '' 键（按 id 排序）；带次排序键 id 保证分页稳定。
 * relevance 用 bm25(fts) —— 值越小越相关，故 relevance:desc 取 ASC。
 */
const ORDER_SQL = Object.freeze({
  '': `ORDER BY m.id ASC`,
  'id:asc': 'ORDER BY m.id ASC',
  'id:desc': 'ORDER BY m.id DESC',
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

/** 热词统计表名（构建索引时随 populate 统计写入） */
export const KEYWORD_TABLE = 'keyword_stats';
/** 热词过滤表名（用户配置的噪声词；reindex 不清除） */
export const KEYWORD_FILTER_TABLE = 'keyword_filter';
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
  const out = [];
  for (const t of String(text ?? '').match(TOKEN_PATTERN) ?? []) {
    const w = t.toLowerCase();
    if (w.length < MIN_KEYWORD_LEN || NUMERIC_ONLY.test(w)) continue;
    out.push(w);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 源库只读连接                                                        */
/* ------------------------------------------------------------------ */

/** 以只读方式打开源库（构建索引时读取用，查询期不持有） */
function openSourceRO(sourcePath) {
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
  // 双重保险：连接层只读 + 引擎级禁止任何写入语句
  src.pragma('query_only = ON');
  src.pragma('cache_size = -64000');
  src.pragma('mmap_size = 268435456');
  return src;
}

/* ------------------------------------------------------------------ */
/* 索引维护（影子索引库内，db 为 drizzle 可写实例）                     */
/* ------------------------------------------------------------------ */

function maxSourceId(src) {
  return src.prepare(`SELECT coalesce(max(id), 0) AS m FROM ${TABLE}`).get().m;
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
  return db.get(sql`SELECT 1 FROM sqlite_master WHERE name = ${name}`) != null;
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
const REBUILD_BATCH = 5000;

/**
 * 用源库行填充 FTS 与副本表。
 * @param {db} db                      可写连接（drizzle 实例）
 * @param {Iterable<Object>} rowsIterable 源行迭代器（数组或 better-sqlite3 的 stmt.iterate()）。
 *        传入迭代器可避免一次性把全表载入内存，内存峰值仅约等于一个批次的行数。
 */
function populate(db, rowsIterable) {
  const CHUNK = 1000;
  let ftsBuf = [];
  let docBuf = [];
  // 热词过滤集：populate 前从过滤表加载，统计时排除用户配置的噪声词
  const filter = new Set(
    db.all(sql`SELECT term FROM ${sql.raw(KEYWORD_FILTER_TABLE)}`).map((r) => r.term)
  );
  /** 热词累计：term -> { doc, occ }，随批次 flush 落库，控制内存峰值 */
  const kwMap = new Map();
  const flush = () => {
    if (!docBuf.length) return;
    db.transaction((tx) => {
      for (const r of ftsBuf) {
        tx.run(sql`INSERT INTO ${sql.raw(FTS_TABLE)} (rowid, name, files)
          VALUES (${r.id}, ${r.name}, ${r.files})`);
      }
      for (let i = 0; i < docBuf.length; i += CHUNK) {
        const slice = docBuf.slice(i, i + CHUNK).map((r) => ({
          id: r.id,
          name: r.name,
          infohash: r.infohash,
          magnet: r.magnet,
          files: r.files,
          totalSize: r.totalSize,
          fetchedAt: r.fetchedAt,
        }));
        tx.insert(magnetsDocs).values(slice).run();
      }
      // 热词 upsert 合并计数（全量重建时表已被清空，增量时按新行累加）
      for (const [term, k] of kwMap) {
        tx.run(sql`INSERT INTO ${sql.raw(KEYWORD_TABLE)} (term, doc_count, occurrences)
          VALUES (${term}, ${k.doc}, ${k.occ})
          ON CONFLICT(term) DO UPDATE SET
            doc_count = doc_count + excluded.doc_count,
            occurrences = occurrences + excluded.occurrences`);
      }
    });
    ftsBuf = [];
    docBuf = [];
    kwMap.clear();
  };
  for (const r of rowsIterable) {
    ftsBuf.push(r);
    docBuf.push(r);
    // 热词统计：同一文档内去重，doc_count 只计一次
    const seen = new Set();
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
    if (docBuf.length >= REBUILD_BATCH) flush();
  }
  flush();
}

/** 全量重建：从源库灌入所有行并合并索引段 */
function fullRebuild(db, src) {
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
  db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_fetchedAt`)} ON ${sql.raw(DOCS_TABLE)}(fetchedAt)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_totalSize`)} ON ${sql.raw(DOCS_TABLE)}(totalSize)`);
  // 热词统计表：全量重建时清空重建，随 populate 重新统计
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(KEYWORD_TABLE)}`);
  db.run(sql`CREATE TABLE ${sql.raw(KEYWORD_TABLE)} (
    term TEXT PRIMARY KEY,
    doc_count INTEGER NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 0
  )`);

  const stmt = src.prepare(`SELECT ${DOCS_COLUMNS} FROM ${TABLE}`);
  populate(db, stmt.iterate());

  setMeta(db, 'tokenizer', TOKENIZER);
  setMeta(db, 'last_rowid', String(maxSourceId(src)));
  db.run(sql`INSERT INTO ${sql.raw(FTS_TABLE)} (${sql.raw(FTS_TABLE)}) VALUES ('optimize')`);
}

/**
 * 启动同步：tokenizer 不符或索引为空则全量重建；
 * 否则按 last_rowid 增量补录源库中新增的行。
 */
function syncIndex(db, src) {
  const ftsExists = tableExists(db, FTS_TABLE);
  const docsExists = tableExists(db, DOCS_TABLE);
  const stored = getMeta(db, 'tokenizer');
  // 表缺失或 tokenizer 变更 → 全量重建；否则按 last_rowid 增量补录
  if (!ftsExists || !docsExists || stored !== TOKENIZER) {
    fullRebuild(db, src);
    return;
  }
  const last = Number(getMeta(db, 'last_rowid') ?? '0');
  const max = maxSourceId(src);
  if (max > last) {
    const rows = src.prepare(`SELECT ${DOCS_COLUMNS} FROM ${TABLE} WHERE id > ?`).all(last);
    populate(db, rows);
    setMeta(db, 'last_rowid', String(max));
    db.run(sql`INSERT INTO ${sql.raw(FTS_TABLE)} (${sql.raw(FTS_TABLE)}) VALUES ('optimize')`);
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
 * @returns {{ db: import('drizzle-orm/better-sqlite3').BetterSQLite3Database, countMagnets: Function,
 *            searchMagnets: Function, reindex: Function, close: Function }}
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
  const wdb = new Database(indexPath);
  wdb.pragma('busy_timeout = 5000');
  wdb.pragma('journal_mode = WAL');
  wdb.pragma('cache_size = -64000');
  wdb.pragma('mmap_size = 268435456');
  wdb.pragma('synchronous = NORMAL');
  wdb.pragma('temp_store = MEMORY');
  const db = drizzle(wdb);

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
    const srcMode = src.pragma('journal_mode')[0].journal_mode;
    if (srcMode !== 'wal') {
      console.warn(`[warn] 源库非 WAL 模式（${srcMode}）：构建索引时的只读扫描可能与写入进程争用锁`);
    }
    if (!src.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(TABLE)) {
      throw new Error(`源库 ${sourcePath} 中不存在 ${TABLE} 表`);
    }
    syncIndex(db, src);
  } finally {
    src.close();
  }

  // 查询专用只读连接：searchMagnets / countMagnets 仅在此连接上执行 SELECT，
  // 在代码层面杜绝查询路径修改数据库。源库本就只读，索引库的写操作只发生在 syncIndex / reindex。
  const rdb = new Database(indexPath, { readonly: true });
  rdb.pragma('query_only = ON');
  rdb.pragma('cache_size = -32000');
  rdb.pragma('mmap_size = 134217728');
  const dbRO = drizzle(rdb);

  /** 已索引条数（与检索结果一致） */
  function countMagnets() {
    const row = dbRO.select({ total: count() }).from(magnetsDocs).get();
    return Number(row?.total ?? 0);
  }

  /**
   * 热词榜：按文档频率降序返回 top N 关键词。
   * @param {number} [limit=50] 返回条数，钳制 1..1000
   * @returns {Array<{term: string, doc_count: number, occurrences: number}>}
   */
  function topKeywords(limit = 50) {
    const lim = clampInt(limit, 50, 1, 1000);
    return dbRO.all(sql`
      SELECT term, doc_count, occurrences
      FROM ${sql.raw(KEYWORD_TABLE)}
      WHERE term NOT IN (SELECT term FROM ${sql.raw(KEYWORD_FILTER_TABLE)})
      ORDER BY doc_count DESC, occurrences DESC
      LIMIT ${lim}
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
  /** 按 infohash 精确检索（大小写不敏感，支持前缀匹配） */
  function searchByHash({ query, sortBy, order = 'desc', limit, offset }) {
    // 归一化：剥离 magnet 链接里的 urn:btih: 前缀，并去除所有非字母数字字符
    const raw = String(query)
      .replace(/^.*urn:btih:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
    if (!raw) {
      throw new TypeError('searchByHash: 未提供有效的 infohash');
    }
    const direction = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
    // 未传 sortBy 时走 '' 键（按 id 升序），order 仅对显式 sortBy 生效
    const sortKey = SORT_COLUMNS.includes(sortBy) ? `${sortBy}:${direction}` : '';
    const orderSql = ORDER_SQL[sortKey];
    const lim =
      limit === undefined || limit === null || Number(limit) <= 0
        ? -1
        : clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const off = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // 归一化匹配：兼容「带/不带 hash 前缀」两种 infohash 存储，并支持前缀检索
    const cond = sql`lower(m.infohash) = lower(${raw})
      OR lower(m.infohash) = lower(${'hash' + raw})
      OR lower(m.infohash) LIKE lower(${raw + '%'})`;
    const totalRow = dbRO.get(sql`
      SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)} m WHERE ${cond}
    `);
    const total = Number(totalRow?.total ?? 0);

    const rows = dbRO.all(sql`
      SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
      WHERE ${cond}
      ${sql.raw(orderSql)}
      LIMIT ${lim} OFFSET ${off}
    `);
    return { total, limit: lim, offset: off, items: rows.map(mapRow) };
  }

  function searchMagnets(options = {}) {
    const { query, sortBy, order = 'desc', by } = options;

    // infohash 未进入 FTS 索引，按 hash 检索时单独走副本表
    if (by === 'hash') {
      return searchByHash({ query, sortBy, order, limit: options.limit, offset: options.offset });
    }

    const match = buildMatchExpression(query);
    if (!match) {
      throw new TypeError('searchMagnets: options.query 不能为空，且需包含至少一个字母或数字');
    }

    const direction = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
    // 未传 sortBy 时走 '' 键（按 id 升序），order 仅对显式 sortBy 生效
    const sortKey = SORT_COLUMNS.includes(sortBy) ? `${sortBy}:${direction}` : '';
    const orderSql = ORDER_SQL[sortKey];

    const limit =
      options.limit === undefined || options.limit === null || Number(options.limit) <= 0
        ? -1
        : clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // total 走 JOIN：源中已删除的残留索引行会被自动剔除，保证 total 与返回数一致
    const totalRow = dbRO.get(sql`
      SELECT count(*) AS total FROM ${sql.raw(FTS_TABLE)} f
      JOIN ${sql.raw(DOCS_TABLE)} m ON m.id = f.rowid
      WHERE ${sql.raw(FTS_TABLE)} MATCH ${match}
    `);
    const total = Number(totalRow?.total ?? 0);

    const rows = dbRO.all(sql`
      SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(FTS_TABLE)} f
      JOIN ${sql.raw(DOCS_TABLE)} m ON m.id = f.rowid
      WHERE ${sql.raw(FTS_TABLE)} MATCH ${match}
      ${sql.raw(orderSql)}
      LIMIT ${limit} OFFSET ${offset}
    `);

    return { total, limit, offset, items: rows.map(mapRow) };
  }

  /** 全量重建影子索引，返回索引文档数 */
  function reindex() {
    const s = openSourceRO(sourcePath);
    try {
      fullRebuild(db, s);
    } finally {
      s.close();
    }
    const row = dbRO.get(sql`SELECT count(*) AS c FROM ${sql.raw(FTS_TABLE)}`);
    return Number(row?.c ?? 0);
  }

  /** 关闭连接 */
  function close() {
    if (rdb.open) rdb.close();
    if (wdb.open) wdb.close();
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
    close,
  };
}

export default createMagnetDb;
