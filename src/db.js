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
 *   searchMagnets()  —— 检索（FTS5 模糊 / infohash 精确），支持分页与排序
 *   listLatest()     —— 最新入库列表（不经过 FTS，按入库顺序从新到旧）
 *   normalizeSearchQuery() —— 检索参数归一化，HTTP 层与数据层共用（幂等）
 *   normalizeLatestQuery() —— 最新入库参数归一化，HTTP 层与数据层共用（幂等）
 *   normalizeKeyword()     —— 热词 / 过滤词归一化，HTTP 层与数据层共用
 *   reindex()        —— 全量重建影子索引（异步；Node 走 worker 线程，Bun 走子进程）
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
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import { runtimeStats } from './stats.js';
import { clampInt, normalizeKeyword } from './util.js';
import {
  isBun,
  isCompiledExe,
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
  execRaw,
} from './db-driver.js';
import { sql, eq, count } from 'drizzle-orm';
import { magnetsDocs, syncMeta } from './schema.js';
import { INDEX_WORKER_FLAG } from './worker-flags.js';
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
import { MAX_RESULTS, SOURCE_READ_MMAP_MB } from './settings.js';

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

/** 「最新入库」默认每批条数 */
const DEFAULT_LATEST_LIMIT = 30;

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

/**
 * 归一化 limit。
 * - 'all' / 数字 -1   -> -1，表示「整集拉取」（受 WHOLESET_CAP 截断）。
 *                        数字 -1 是内部标记，必须原样返回以保证本函数幂等；
 *                        字符串 '-1' 则按用户输入处理，归入下面的「<= 0 → 分页」。
 * - 缺省 / null / 非数值 / <= 0  -> DEFAULT_LIMIT（默认分页）
 * - 其余                         -> 钳制到 [1, MAX_LIMIT]
 *
 * 「整集拉取」是显式 opt-in，只有 limit=all 才触发。
 * 旧行为把「不传 limit」也当作整集拉取，一次就能拉回上万条完整记录（含 files），
 * 是内存峰值的主要来源；改为默认分页后，单次查询结果规模由 MAX_LIMIT 硬保证，
 * 内存预算才有确定性。
 */
function toLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  // -1 是「整集拉取」的内部标记（由本函数或 'all' 产生），必须原样保留：
  // normalizeSearchQuery 是幂等的、各层会重复调用它，若把 -1 当成「负数 → 分页」，
  // 则 HTTP 层归一化出的 -1 传到搜索子进程再归一化一次就会静默退化成分页。
  if (value === -1) return -1;
  const text = String(value).trim().toLowerCase();
  if (text === 'all') return -1;
  const num = Number(text);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_LIMIT;
  return clampInt(num, DEFAULT_LIMIT, 1, MAX_LIMIT);
}

/** 归一化大小筛选（字节）：非有限值或负数一律视为「不限制」 */
function toSize(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

/** 由已校验的 sortBy / order 取白名单内的 ORDER BY 片段 */
function orderSqlFor({ sortBy, order }) {
  return ORDER_SQL[sortBy ? `${sortBy}:${order}` : `id:${order}`];
}

/**
 * 检索参数归一化——HTTP 层与数据层共用的唯一入口。
 *
 * 把任意来源的原始输入（Express 的 req.query、测试直接构造的对象、worker 转发的对象）
 * 收敛为一个规范对象：所有字段均已校验 / 已钳制，可直接用于构造缓存键、派发给搜索
 * worker、拼装 SQL。
 *
 * 幂等：对已归一化的对象再次调用结果不变，因此允许各层放心重复调用而不必「谁负责
 * 归一化」地互相推诿——直接调用 searchMagnets() 的使用方同样安全。
 *
 * @param {object} [raw] 原始检索参数
 * @returns {{ query: string, sortBy: string|undefined, order: 'asc'|'desc',
 *             by: 'hash'|'fts', minSize: number|undefined, maxSize: number|undefined,
 *             limit: number, offset: number }} limit 为 -1 表示整集拉取
 */
export function normalizeSearchQuery(raw = {}) {
  const source = raw ?? {};
  // HTTP 查询串的值可能是数组（?q=a&q=b），取首个而不是静默丢弃为空串
  const rawQuery = Array.isArray(source.query) ? source.query[0] : source.query;
  return {
    query: typeof rawQuery === 'string' ? rawQuery.trim() : '',
    sortBy: SORT_COLUMNS.includes(source.sortBy) ? source.sortBy : undefined,
    order: String(source.order).toLowerCase() === 'asc' ? 'asc' : 'desc',
    by: source.by === 'hash' ? 'hash' : 'fts',
    minSize: toSize(source.minSize),
    maxSize: toSize(source.maxSize),
    limit: toLimit(source.limit),
    offset: clampInt(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * 「最新入库」参数归一化——**只有分页**。
 *
 * 该列表固定按 id 倒序（id 是源库自增主键/rowid，倒序即「最新入库的在最前」，
 * 也就是把表倒过来看），不提供关键词、排序与过滤，避免把「看一眼最新入库了什么」
 * 做成一个检索界面。
 *
 * @param {object} [raw] 原始参数（Express 的 req.query 或子进程转发对象）
 * @returns {{ limit: number, offset: number }}
 */
export function normalizeLatestQuery(raw = {}) {
  const source = raw ?? {};
  const n = Number(source.limit);
  return {
    // 不支持「整集拉取」：本列表是浏览式的，一次最多 MAX_LIMIT 条，靠 offset 翻页
    limit: Number.isFinite(n) && n > 0 ? clampInt(n, DEFAULT_LATEST_LIMIT, 1, MAX_LIMIT) : DEFAULT_LATEST_LIMIT,
    offset: clampInt(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
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

/**
 * 归一化热词 / 过滤词：去首尾空白 + 小写折叠。
 * 不含任何字母或数字时返回空串，调用方自行决定是跳过还是报错——HTTP 层与数据层共用，
 * 避免同一套校验在多处各写一遍。
 * @param {unknown} term
 * @returns {string} 归一化后的词；无效输入返回空串
 */
// normalizeKeyword 的实现见 ./util.js，此处重新导出供 HTTP 层（index.js）引用
export { normalizeKeyword };

/* ------------------------------------------------------------------ */
/* 源库只读连接                                                        */
/* ------------------------------------------------------------------ */

/** 以只读方式打开源库（构建索引时读取用，查询期不持有） */
function openSourceRO(sourcePath) {
  const src = openDatabase(sourcePath, { readonly: true });
  // 双重保险：连接层只读 + 引擎级禁止任何写入语句
  setPragma(src, 'query_only', 'ON');
  // mmap（默认开启，config.js 的 SOURCE_READ_MMAP_MB 可调，0=关闭）：
  // 顺序扫整表时，逐页 4KB 同步读让磁盘队列深度只有 1，SSD/NVMe 顺序带宽用不上；
  // 开启后由内核大块预取，吞吐接近顺序读。代价是扫过的 mmap 页计入页缓存/工作集
  //（可回收页），值越大预取窗口越大。
  const mmapMb = Number(SOURCE_READ_MMAP_MB);
  const mmapBytes = Number.isFinite(mmapMb) && mmapMb > 0 ? Math.floor(mmapMb) * 1024 * 1024 : 0;
  setPragma(src, 'mmap_size', mmapBytes);
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

/** 确保索引表（副本表 + FTS5 虚表）存在（空表）。createMagnetDb 初始化时始终调用，
 *  使 sync:false 或 worker 内打开的全新索引库也能被安全读取 / 增量写入，
 *  不必先跑一次全量重建。全量重建时 fullRebuild 会 DROP+CREATE 覆盖它们。 */
function ensureSchema(db) {
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(DOCS_TABLE)} (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    infohash TEXT,
    magnet TEXT,
    files TEXT,
    totalSize INTEGER NOT NULL DEFAULT 0,
    fetchedAt INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.raw(FTS_TABLE)} USING fts5(
    name, files, content='', tokenize=${sql.raw(`'${TOKENIZER}'`)}
  )`);
}

const DOCS_COLUMNS = 'id, name, infohash, magnet, files, totalSize, fetchedAt';

/** 每批写入事务的行数上限；分批改写以限制全量重建时的内存峰值。
 * 2000 → 5 万：源库行均 ~3.7KB，5 万行≈185MB 仍低于字节阈值，故批次基本由行数封顶。
 * 「少而大」的事务把 COMMIT / WAL 自动 checkpoint / 进度消息的次数降一个量级
 * （1.89M 行重建从 943 批降到约 38 批），磁盘顺序性更好。 */
const REBUILD_BATCH = 50000;
/**
 * 每批写入事务的字节上限（按 name + files 的字符数估算）。
 * 只按行数分批时，多文件种子的 files JSON 可达几十 KB，单批仍可能撑到几百 MB，
 * 故行数与字节数两个阈值先到先生效（超大行场景由字节阈值兜底拆批，单行超大时
 * 该行单独成批）。
 * 注：对中文字符（V8 内部按 2 字节存储）会低估约一倍，属于偏安全的方向。
 */
const REBUILD_BATCH_BYTES = 256 * 1024 * 1024;
/** reindex worker 入口（与 db.js 同目录）；worker 线程与子进程两种模式共用 */
const REINDEX_WORKER_URL = new URL('./reindex-worker.js', import.meta.url);
/** fork 的 modulePath 需要字符串路径而非 URL，预先换算一次 */
const REINDEX_WORKER_PATH = fileURLToPath(REINDEX_WORKER_URL);

/**
 * 重建/同步过程追踪（临时调试用，排查重建卡住问题，定位后移除）：
 * 设置环境变量 DHT_REINDEX_DEBUG=1 启用；fork 子进程会继承父进程 env，故两边都会输出。
 */
const TRACE_INDEXING = process.env.DHT_REINDEX_DEBUG === '1';
const traceIndexing = (...args) => {
  if (TRACE_INDEXING) console.log('[reindex]', ...args);
};

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
    traceIndexing(`scanById 读源库: id>${cursor} limit=${size}`);
    const rows = allRows(
      src,
      `SELECT ${DOCS_COLUMNS} FROM ${TABLE} WHERE id > ? ORDER BY id LIMIT ?`,
      [cursor, size]
    );
    traceIndexing(`scanById 读完成: rows=${rows.length}（id ${rows[0]?.id} ~ ${rows[rows.length - 1]?.id}）`);
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
    traceIndexing(`populate 写入批次开始: rows=${buf.length} kw=${kwMap.size}`);
    runBatch(buf, kwMap);
    traceIndexing(`populate 写入批次完成: rows=${buf.length}`);
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
 * 把 WAL 合并回主库并截断（TRUNCATE），避免 -wal 文件无限增长拖慢读查询。
 * WAL 模式下写操作先追加到 -wal，读查询要「主库 + WAL」合并读，-wal 越大读越慢；
 * 正常关闭连接会自动 checkpoint，但进程被强杀（SIGKILL）时不会，导致 -wal 累积。
 * 故在每次写操作收尾时主动执行一次（此时无并发写，TRUNCATE 所需的独占锁立即可得）。
 * 仅在写连接上调用（db 为 drizzle 可写实例）。
 */
function checkpointWAL(db) {
  const raw = db.$client ?? db.session?.client;
  execRaw(raw, 'PRAGMA wal_checkpoint(TRUNCATE)');
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
  // 批量灌数据期的写盘策略（对全量重建安全，因为整份索引可整体重跑）：
  //   - wal_autocheckpoint=0：灌数据期间禁用自动 checkpoint，所有新页先顺序追加到
  //     WAL，末尾一次性 checkpoint 回主库——把「每批提交都随机回写主库」换成
  //     「1 次大顺序回写」；代价是重建期 WAL 会涨到接近新数据体量（本机空间充足）。
  //   - synchronous=OFF：跳过每提交一次的落盘等待；中途断电最多丢已提交事务、
  //     不会损坏库，重跑即可。收尾先恢复 NORMAL 再 checkpoint，保证最终落盘 durable。
  setPragma(raw, 'wal_autocheckpoint', 0);
  setPragma(raw, 'synchronous', 'OFF');
  try {
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
    traceIndexing('fullRebuild: DDL 事务完成，开始灌数据 populate');
    populate(
      db,
      scanById(src, { from: minId == null ? 0 : Number(minId) - 1, size: REBUILD_BATCH }),
      onFlush
    );
    traceIndexing('fullRebuild: populate 完成，开始建二级索引');

    // 二级索引放到灌数据之后建：空表建索引会让后续每条 INSERT 都维护 B-Tree，
    // 写入慢 2~3 倍；先灌数据再建索引是批量排序构建，快得多。
    // 只建 totalSize 索引：fetchedAt 排序的唯一路径是「FTS JOIN 后 temp 排序」，
    // 连接方向决定了该索引永不会被查询使用（反转驱动已实测 fetchedAt 反而更慢，
    // 故只对 totalSize 开放），保留纯属白付构建/维护成本，已移除。
    db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_totalSize`)} ON ${sql.raw(DOCS_TABLE)}(totalSize)`);
    traceIndexing('fullRebuild: 二级索引完成');

    setMeta(db, 'tokenizer', TOKENIZER);
    setMeta(db, 'last_rowid', String(maxSourceId(src)));
    traceIndexing('fullRebuild: 开始 optimizeFts（可能耗时较长）');
    optimizeFts(db);
    traceIndexing('fullRebuild: optimizeFts 完成，开始 checkpointWAL');
  } finally {
    // 异常也要恢复持久化语义，避免后续运行时仍处于「不自动 checkpoint + 不落盘」状态
    setPragma(raw, 'wal_autocheckpoint', 1000);
    setPragma(raw, 'synchronous', 'NORMAL');
  }
  // 恢复后再做一次性 checkpoint，把重建期累积在 WAL 的页以 durable 方式写回主库并清空
  checkpointWAL(db);
  traceIndexing('fullRebuild: 全部完成');
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
    checkpointWAL(db);
  }
}

/* ------------------------------------------------------------------ */
/* 工厂函数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 打开影子索引库并构建/同步索引，返回查询句柄。
 *
 * @param {Object|string} [options] 源库路径字符串，或 { source, indexDbPath }
 * @param {string} [options.source]      源库路径，默认 config.js 的 SOURCE_DB_PATH（data/magnet.db）
 * @param {string} [options.indexDbPath] 影子索引库路径，默认 config.js 的 INDEX_DB_PATH（data/dht.search.db）
 * @param {boolean} [options.sync=true]  打开时是否执行同步（全量重建 / 增量补录）；
 *        传 false 则只建立连接不建索引，供 reindex worker 使用
 */
/**
 * 检索逻辑工厂：接收「只读数据库连接（drizzle 包装）」，返回同步检索函数。
 *
 * 主线程在 createMagnetDb 内用它构建查询 API；搜索子进程也用它（各自持有独立的
 * 只读连接）构建同样的逻辑——从而 Bun / Node 共用同一套实现，无需 isBun 分支。
 *
 * 重要：better-sqlite3 / bun:sqlite 均为同步 API，单条 SQL 执行期间会阻塞事件循环，
 * 无法被 JS 中途打断。因此「客户端断开即停止」不能在本函数内实现，而由 HTTP 层把查询
 * 放进独立子进程、断开时 SIGKILL 掉整个进程来完成（见 src/searchPool.js）——
 * 这也是搜索执行单元只能是进程而非线程的原因：线程的 terminate() 无法中断
 * 卡在原生调用里的查询，只有操作系统级的 kill 可以。
 * 本函数只负责把结果查出来，并对整集拉取做内存上限保护（WHOLESET_CAP）。
 *
 * @param {object} dbRO drizzle-orm 包装的只读连接，提供 .all() 执行 SELECT
 * @returns {{ searchMagnetsSync: Function }}
 */
export function buildSearchApi(dbRO) {
  /** 整集拉取安全上限（与 config.js 的 MAX_RESULTS 对齐，配置缺失则回退 20000） */
  const WHOLESET_CAP =
    Number.isFinite(Number(MAX_RESULTS)) && Number(MAX_RESULTS) > 0 ? Number(MAX_RESULTS) : 20000;

  /**
   * 匹配数超过该值才启用「索引反转驱动」做 totalSize/fetchedAt 排序。
   * 反转驱动从二级索引倒序扫、逐个用 EXISTS 校验 FTS 匹配，凑够 LIMIT 个就停，
   * 避免「JOIN 全部匹配行再全量排序」。实测（热 cache）：movie 9513 快 5 倍、
   * 111 30167 快 1.8 倍，但 mp4 208247 反而慢 12%——EXISTS 的逐行 FTS 校验代价随
   * 倒排列表大小增长，超大匹配时不划算。故设此下限：非精确词（>5000）走反转，
   * 精确词（≤5000）匹配本就少，直接 JOIN 更快。
   */
  const INDEX_SCAN_MIN_TOTAL = 5000;

  /**
   * 构造大小筛选片段（值已由 normalizeSearchQuery 校验为「有限非负」或 undefined）。
   * 无条件时返回空片段，调用方无需再判空。
   */
  function buildSizeCond({ minSize, maxSize }) {
    const conds = [];
    if (minSize !== undefined) conds.push(sql`m.totalSize >= ${minSize}`);
    if (maxSize !== undefined) conds.push(sql`m.totalSize <= ${maxSize}`);
    // bun 下 drizzle-orm/bun-sqlite 会把 sql.join 的字符串分隔符参数化成 `?`，导致 `>= ? AND <= ?`
    // 错拼成 `>= ?? <= ?`。故显式拼接 SQL 片段，不用 join。
    if (conds.length === 0) return sql``;
    if (conds.length === 1) return sql` AND ${conds[0]}`;
    return sql` AND ${conds[0]} AND ${conds[1]}`;
  }

  /** 归一化 infohash：剥离 magnet 链接里的 urn:btih: 前缀，并去除所有非字母数字字符 */
  function normalizeInfohash(query) {
    return String(query ?? '')
      .replace(/^.*urn:btih:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  /** FTS5 模糊检索：JOIN FTS 表，顺带剔除源库中已删除的残留索引行（保证 total 与返回数一致） */
  function ftsWhere(query) {
    const match = buildMatchExpression(query);
    if (!match) {
      throw new TypeError('searchMagnets: options.query 不能为空，且需包含至少一个字母或数字');
    }
    // FTS5 MATCH 必须接收「SQL 字符串字面量」形式的查询表达式（单引号包裹），否则 SQLite 会把
    // 双引号短语误当标识符、或把参数化占位符 ? 在 prepare 阶段抛 fts5: near "?"。
    // match 已白名单化（仅字母数字 / 双引号 / AND / *），安全。
    return {
      join: sql`JOIN ${sql.raw(FTS_TABLE)} f ON m.id = f.rowid`,
      cond: sql`${sql.raw(FTS_TABLE)} MATCH ${sql.raw(`'${match}'`)}`,
    };
  }

  /** infohash 精确检索：无需 JOIN，直接匹配副本表，兼容「带/不带 hash 前缀」并支持前缀检索 */
  function hashWhere(query) {
    const raw = normalizeInfohash(query);
    if (!raw) {
      throw new TypeError('searchByHash: 未提供有效的 infohash');
    }
    return {
      join: sql``,
      cond: sql`lower(m.infohash) = lower(${raw})
        OR lower(m.infohash) = lower(${'hash' + raw})
        OR lower(m.infohash) LIKE lower(${raw + '%'})`,
    };
  }

  /**
   * 由归一化参数构造 count / 分页 SQL 工厂。
   * 两种检索模式的差异只有「是否 JOIN FTS 表 + 匹配条件」，其余拼装基本共用。
   *
   * 两条针对宽泛词（匹配数上万）的性能优化，实测数据见下：
   *  - count：FTS 且无大小筛选时直接查 FTS 虚表，省掉「每个匹配 rowid 回 docs 做一次
   *    主键查找」的开销（the 词 8.1 万匹配：1241ms → 23ms）；
   *  - page：FTS + 无大小筛选 + 默认 id 排序时，用子查询预取 rowid 再 JOIN，
   *    利用 FTS5 对 rowid 有序输出的提前终止，只 JOIN 需要的行（234ms → 24ms）。
   */
  function prepareSearch(options) {
    const s = normalizeSearchQuery(options);
    const { join, cond } = s.by === 'hash' ? hashWhere(s.query) : ftsWhere(s.query);
    const fromWhere = sql`
      FROM ${sql.raw(DOCS_TABLE)} m ${join}
      WHERE ${cond}${buildSizeCond(s)}
    `;
    const hasSize = s.minSize !== undefined || s.maxSize !== undefined;
    return {
      // count 不需要 docs 的任何列，JOIN 只为剔除「源库已删除但索引未清理」的残留行，
      // 代价是每个匹配 rowid 回 docs 做一次主键查找。无大小筛选时省掉它（残留行会略
      // 增 total，DHT 场景删除极少可接受）；有大小筛选仍需 JOIN 才能按 m.totalSize 过滤。
      buildCount: () =>
        s.by === 'fts' && !hasSize
          ? sql`SELECT count(*) AS total FROM ${sql.raw(FTS_TABLE)} WHERE ${cond}`
          : sql`SELECT count(*) AS total ${fromWhere}`,
      buildPage: (lim, off, useIndexScan = false) => {
        // 预取路径仅在「FTS + 无大小筛选 + 默认 id 排序」下可用：
        //  - hash 检索没有 rowid 有序输出；
        //  - 有大小筛选时过滤在外层，预取的行可能被 totalSize 过滤掉导致结果偏少；
        //  - 非 id 排序（fetchedAt/totalSize/bm25）的排序键不是 rowid，无法提前终止。
        if (s.by === 'fts' && !hasSize && !s.sortBy) {
          const dir = s.order === 'asc' ? 'ASC' : 'DESC';
          return sql`
            SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
            JOIN (SELECT rowid FROM ${sql.raw(FTS_TABLE)}
                  WHERE ${cond} ORDER BY rowid ${sql.raw(dir)}
                  LIMIT ${lim} OFFSET ${off}) f ON m.id = f.rowid
            ORDER BY m.id ${sql.raw(dir)}
          `;
        }
        // 索引反转驱动：宽泛词（total 大）按 totalSize 排序时，从二级索引倒序扫描
        // docs、逐个用 EXISTS 校验 FTS 匹配，凑够 LIMIT+OFFSET 个就停，避免「JOIN
        // 全部匹配行 + 全量排序」。仅在匹配占比高时划算（由 useIndexScan 阈值控制），
        // 精确词仍走下方 JOIN。bm25 无索引，不适用本路径。
        // 注意：**只用于 totalSize**。fetchedAt 索引选择性差（时间戳大量重复），反转
        // 驱动会扫过成片相同时间戳的行，凑 LIMIT 个匹配需扫极多行，实测 111 词反而
        // 从 1044ms 恶化到 9227ms，故 fetchedAt 仍走 JOIN 路径。
        if (useIndexScan && s.by === 'fts' && !hasSize && s.sortBy === 'totalSize') {
          const dir = s.order === 'asc' ? 'ASC' : 'DESC';
          const col = s.sortBy;
          return sql`
            SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
            WHERE EXISTS (
              SELECT 1 FROM ${sql.raw(FTS_TABLE)}
              WHERE ${cond} AND ${sql.raw(FTS_TABLE)}.rowid = m.id
            )
            ORDER BY m.${sql.raw(col)} ${sql.raw(dir)}, m.id ${sql.raw(dir)}
            LIMIT ${lim} OFFSET ${off}
          `;
        }
        return sql`
          SELECT ${sql.raw(SELECT_COLUMNS)} ${fromWhere}
          ${sql.raw(orderSqlFor(s))}
          LIMIT ${lim} OFFSET ${off}
        `;
      },
      wholeSet: s.limit === -1,
      effLimit: s.limit,
      effOffset: s.offset,
    };
  }

  /**
   * 同步检索：先 count 再取页（整集拉取则一次取到 CAP），一次性返回。测试与搜索子进程均使用此函数。
   * 整集拉取（归一化后 limit = -1）限制到 WHOLESET_CAP，避免把百万级结果全部载入内存；
   * 子进程在执行期间若被主进程 SIGKILL，整个进程由操作系统回收，无需本函数干预。
   */
  function searchMagnetsSync(options) {
    const { buildCount, buildPage, wholeSet, effLimit, effOffset } = prepareSearch(options);
    const total = Number(dbRO.all(buildCount())[0]?.total ?? 0);
    // 宽泛词才启用索引反转驱动（匹配占比高，凑 LIMIT 个就停比全量 JOIN + 排序划算）
    const useIndexScan = total > INDEX_SCAN_MIN_TOTAL;
    if (wholeSet) {
      // 一次性取到 CAP 上限，只排一次序。
      // 原实现按 OFFSET 分批翻页，但 ORDER BY 带 bm25 时每一轮都要把整个匹配集
      // 重新排序一遍再丢弃前 n 行——取满 CAP 要重排 CAP/CHUNK 轮，是纯粹的浪费。
      const items = dbRO.all(buildPage(WHOLESET_CAP + 1, 0, useIndexScan)).map(mapRow);
      const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
      if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
      return { total, limit: 'all', offset: 0, items, truncated };
    }
    const items = total ? dbRO.all(buildPage(effLimit, effOffset, useIndexScan)).map(mapRow) : [];
    return { total, limit: effLimit, offset: effOffset, items };
  }

  /**
   * 「最新入库」列表：不经过 FTS、不带任何条件，固定按 id 倒序取一段——
   * 就是「把副本表倒过来看最新入库的几页」。
   *
   * 与 searchMagnetsSync 的区别：没有关键词与 MATCH，也不排序/过滤，
   * 因此不存在「源库已删除但索引未清理的残留行」被 JOIN 剔除的机制
   * （total 会略偏大，DHT 场景删除极少，可接受）。
   *
   * @param {object} [options] 见 normalizeLatestQuery（只有 limit / offset）
   * @returns {{ total: number, limit: number, offset: number, items: Array }}
   */
  function listLatestSync(options) {
    const { limit, offset } = normalizeLatestQuery(options);
    const total = Number(
      dbRO.all(sql`SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)}`)[0]?.total ?? 0
    );
    const items = dbRO.all(sql`
      SELECT ${sql.raw(SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
      ORDER BY m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `).map(mapRow);
    return { total, limit, offset, items };
  }

  return { searchMagnetsSync, listLatestSync };
}

export function createMagnetDb(options = {}) {
  const opts = typeof options === 'string' ? { source: options } : options;
  // 优先级：调用方显式传入 > config.js > 模块内默认值。
  // config.js 的值恒非空，原 env 兜底分支永不生效，已移除（见 config.js 顶部说明）
  const sourcePath = resolveDbPath(
    opts.source ?? CONFIG.sourceDbPath ?? DEFAULT_DB_PATH
  );
  const indexPath = resolveDbPath(
    opts.indexDbPath ?? CONFIG.indexDbPath ?? DEFAULT_INDEX_DB_PATH
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

  // 索引表始终确保存在（空表）：即便 sync:false / worker 内打开的全新索引库，
  // 也能被安全地读取（返回空结果）与增量写入，而不会 no such table 崩溃。
  ensureSchema(db);

  // 源库只读打开（构建时读取），并校验表存在 / 提示 WAL 模式
  const src = openSourceRO(sourcePath);
  try {
    const srcMode = getPragma(src, 'journal_mode').journal_mode;
    if (srcMode !== 'wal') {
      log.warn(`源库非 WAL 模式（${srcMode}）：构建索引时的只读扫描可能与写入进程争用锁`);
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
          log.progress(`已索引 ${done} 行`);
        }
      });
      // 进度按阈值打印，最后一批不足一个阈值时上面不会触发，这里补打总数，
      // 否则「已索引 100000 行」看起来会像是提前停了
      if (done > logged) log.ok(`索引完成，共 ${done} 行`);
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
  // 主进程这条只读连接只服务 countMagnets / 热词榜等轻量查询，固定取「小 cache +
  // 中等 mmap」即可，且它的开销不随并发进程数放大。
  // 搜索子进程的同类配额见 config.js 的 SEARCH_PROCESS_CACHE_SIZE_KB /
  // SEARCH_PROCESS_MMAP_SIZE_MB —— 那些是「每个进程一份」，会随并发数线性放大。
  setPragma(rdb, 'cache_size', -2000);
  setPragma(rdb, 'mmap_size', 33554432);
  // 排序临时 B-Tree 放内存而非磁盘：宽泛词 + totalSize/fetchedAt/bm25 排序时，
  // 匹配量可达数十万，排序临时数据落磁盘（temp_store 默认 FILE）会慢数倍，
  // 实测 mp4 词 20.8 万匹配：6681ms → 836ms。排序只存「排序键 + rowid」，
  // 数十万行也就几 MB，内存安全。
  setPragma(rdb, 'temp_store', 'MEMORY');
  const dbRO = createDrizzle(rdb);

  // reindex worker 的堆上限仅 Node 路径生效（见 spawnIndexWorker 的 resourceLimits）；Bun 走子进程，堆由操作系统兜底

  let reindexWorker = null;
  let indexingPromise = null;
  let indexingMode = null; // 当前维护类型（'full' | 'incremental'），互斥复用时用于结果归一化

  /**
   * 派生 worker 线程执行索引维护（通用，仅 Node 路径使用）。
   * @param {'incremental'|'full'} mode  'incremental'=只补录不清空；'full'=清空重建
   * @param {(p: { done: number, total: number }) => void} [onProgress] 进度回调
   */
  function spawnIndexWorker(mode, onProgress) {
    return new Promise((resolve, reject) => {
      // Bun 1.4 实测可跑通 worker_threads，且 reindex-worker 的 postMessage 逐批实时回传
      //（与 Node 一致）；但 resourceLimits 在 Bun 下不生效、stdout/stderr 选项语义与 Node
      // 不同，故 Bun 只传 workerData，Node 保留 resourceLimits 兜底 OOM。不设 stdout/stderr
      // → worker 直接继承父进程输出，避免「pipe 无人读 → 缓冲写满卡死 worker」的隐患。
      const worker = new Worker(REINDEX_WORKER_URL, {
        workerData: { sourcePath, indexPath, mode },
        ...(isBun
          ? {}
          : {
              // 堆触顶时 worker 会以 ERR_WORKER_OUT_OF_MEMORY 退出，只杀 worker，主进程不受影响
              resourceLimits: {
                maxOldGenerationSizeMb: clampInt(CONFIG.reindexMaxOldSpaceMb, 2048, 256, 65536),
              },
            }),
      });
      reindexWorker = worker;
      if (mode === 'full') log.system(`索引 worker 线程已派生（mode=${mode}），等待进度消息`);

      let settled = false;
      const settle = (ok, value) => {
        if (settled) return;
        settled = true;
        reindexWorker = null;
        if (!ok) worker.terminate(); // 终态即终止，监听器随之回收
        (ok ? resolve : reject)(value);
      };

      // progress 多次 → 用 on 持续监听
      worker.on('message', (msg) => {
        if (msg?.type === 'progress') {
          onProgress?.(msg);
          return;
        }
        if (msg?.ok) {
          // full 模式回执 indexed 数字；incremental 模式回执 { skipped, added }
          settle(true, mode === 'full' ? msg.indexed : msg.result);
        } else {
          settle(false, new Error(msg?.error || 'index failed'));
        }
      });
      // 终态事件 → 用 once，触发一次即自动移除，监听干净
      worker.once('error', (err) => settle(false, err));
      worker.once('exit', (code) => {
        if (!settled) settle(false, new Error(`索引 worker 异常退出（code=${code}）`));
      });
    });
  }

  /**
   * 派生子进程执行索引维护（Bun 编译态 exe 专用 / DHT_INDEX_DRIVER=child 兜底）。
   *
   * 源码态 Bun 已改用 worker 线程（见 runIndex：worker 消息实时回传，fork IPC 会积压
   * 到退出才冲刷）；编译态 exe 内 worker 打包行为未验证，仍走本子进程路径：
   *   - 主进程事件循环零阻塞，页面 / 检索全程可用；
   *   - 超时 / 异常直接 SIGKILL 子进程，由操作系统回收，主进程不受影响；
   *   - 参数经环境变量 DHT_REINDEX_JOB（JSON）传入，进度/结果经 IPC 回传，
   *     消息协议与 worker 线程完全一致（见 reindex-worker.js）。
   * @param {'incremental'|'full'} mode  'incremental'=只补录不清空；'full'=清空重建
   * @param {(p: { done: number, total: number }) => void} [onProgress] 进度回调
   */
  function spawnIndexChild(mode, onProgress) {
    return new Promise((resolve, reject) => {
      const stdio = ['ignore', 'inherit', 'inherit', 'ipc'];
      const env = {
        ...process.env,
        DHT_REINDEX_JOB: JSON.stringify({ sourcePath, indexPath, mode }),
      };
      // 源码运行：fork 磁盘上的执行体；编译产物（bun --compile）内本文件位于虚拟
      // 文件系统、无法 fork，改为 spawn exe 自身并传启动标记自拉起 —— 两种方式的
      // IPC 消息协议一致（见 reindex-worker.js）
      const child = isCompiledExe
        ? spawn(process.execPath, [INDEX_WORKER_FLAG], { stdio, env })
        : fork(REINDEX_WORKER_PATH, [INDEX_WORKER_FLAG], { stdio, env });
      reindexWorker = child;
      log.system(`索引子进程已派生 pid=${child.pid}（mode=${mode}），等待 IPC 回传`);

      let settled = false;
      const settle = (ok, value) => {
        if (settled) return;
        settled = true;
        reindexWorker = null;
        if (!ok) {
          // 终态即终止：SIGKILL 由操作系统回收，正在执行的同步 SQLite 语句也随之中断
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }
        (ok ? resolve : reject)(value);
      };

      // progress 多次 → 用 on 持续监听
      child.on('message', (msg) => {
        if (msg?.type === 'progress') {
          traceIndexing(`父进程收到子进程进度 pid=${child.pid} done=${msg.done}/${msg.total}`);
          onProgress?.(msg);
          return;
        }
        if (msg?.ok) {
          traceIndexing(`父进程收到子进程成功终态 pid=${child.pid}`);
          // full 模式回执 indexed 数字；incremental 模式回执 { skipped, added }
          settle(true, mode === 'full' ? msg.indexed : msg.result);
        } else {
          traceIndexing(`父进程收到子进程失败终态 pid=${child.pid} error=${msg?.error}`);
          settle(false, new Error(msg?.error || 'index failed'));
        }
      });
      // 终态事件 → 用 once，触发一次即自动移除，监听干净
      child.once('error', (err) => {
        log.error(`索引子进程 error 事件: ${err?.message || err}`);
        settle(false, err);
      });
      child.once('exit', (code) => {
        traceIndexing(`子进程 exit 事件 pid=${child.pid} code=${code} settled=${settled}`);
        if (!settled) log.error(`索引子进程已退出但终态消息未达父进程（code=${code}），Promise 将 reject`);
        if (!settled) settle(false, new Error(`索引子进程异常退出（code=${code}）`));
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
    const t = normalizeKeyword(term);
    if (!t) throw new TypeError('addKeywordFilter: term 不能为空，且需包含字母或数字');
    db.run(sql`INSERT OR IGNORE INTO ${sql.raw(KEYWORD_FILTER_TABLE)} (term, created_at)
      VALUES (${t}, ${Date.now()})`);
    return t;
  }

  /**
   * 批量添加热词过滤词（幂等、去重、单事务）。
   * 逐条 INSERT 会让每条各自开启一次事务；导入成百上千条时合并为一个事务既快得多，
   * 也保证「要么全写入、要么全不写」。
   * @param {Iterable<string>} terms 原始词条；空白 / 纯符号等无效项自动跳过
   * @returns {number} 实际写入的条数（已去重）
   */
  function addKeywordFilters(terms) {
    const unique = new Set();
    for (const raw of terms ?? []) {
      const t = normalizeKeyword(raw);
      if (t) unique.add(t);
    }
    if (unique.size === 0) return 0;

    const raw = db.$client ?? db.session?.client;
    const stmt = prepareStmt(
      raw,
      `INSERT OR IGNORE INTO ${KEYWORD_FILTER_TABLE} (term, created_at) VALUES (?, ?)`
    );
    const now = Date.now();
    transaction(raw, (list) => {
      for (const t of list) runStmt(stmt, [t, now]);
    })([...unique]);
    return unique.size;
  }

  /** 删除热词过滤词（删除后该词重新出现在热词榜） */
  function removeKeywordFilter(term) {
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) throw new TypeError('removeKeywordFilter: term 不能为空');
    db.run(sql`DELETE FROM ${sql.raw(KEYWORD_FILTER_TABLE)} WHERE term = ${t}`);
    return t;
  }

  // 检索逻辑抽到模块级 buildSearchApi(dbRO)：主线程与搜索 worker 共用同一套实现，
  // 取消由 HTTP 层把查询放进 worker 线程、断开时 worker.terminate() 实现（见 src/searchPool.js）。
  const search = buildSearchApi(dbRO);

  /**
   * 在当前进程内同步执行全量重建。供 reindex worker 调用；
   * 脚本 / 测试想跳过线程开销时也可直接用。
   * @param {(p: { done: number, total: number }) => void} [onProgress]
   * @returns {number} 索引文档数
   */
  function rebuildSync(onProgress) {
    const s = openSourceRO(sourcePath);
    try {
      // total 只作进度参考：用 id 跨度估算（O(1)，只读首尾叶页），避免 count(*) 对
      // 7GB 级源库做一整趟全表预扫。源库有删除空洞时 span 会略大于实际行数——
      // 与增量补录 total 用 id 跨度的口径一致，进度最后差几个百分点不碍事。
      traceIndexing('rebuildSync: 估算源库 total（min/max id）');
      const ext = getRow(s, `SELECT min(id) AS lo, max(id) AS hi FROM ${TABLE}`);
      const total = ext?.lo == null ? 0 : Number(ext.hi) - Number(ext.lo) + 1;
      traceIndexing(`rebuildSync: total(span)=${total}`);
      let done = 0;
      fullRebuild(db, s, ({ rows }) => {
        done += rows;
        onProgress?.({ done, total });
      });
      traceIndexing(`rebuildSync: 全量重建完成 done=${done}`);
    } finally {
      s.close();
    }
    traceIndexing('rebuildSync: 统计索引库 FTS 文档数');
    const n = Number(dbRO.all(sql`SELECT count(*) AS c FROM ${sql.raw(FTS_TABLE)}`)[0]?.c ?? 0);
    traceIndexing(`rebuildSync: 返回 indexed=${n}`);
    return n;
  }

  /**
   * 全量重建影子索引。
   * - Node 环境：在独立 worker 线程执行，不阻塞事件循环，worker OOM 只杀 worker。
   * - Bun 环境：node:worker_threads 覆盖不全、resourceLimits 不生效，改为独立
   *   子进程执行（见 spawnIndexChild），同样不阻塞事件循环。
   * @param {(p: { done: number, total: number }) => void} [onProgress] 进度回调
   * @returns {Promise<number>} 索引文档数
   */
  /**
   * 全量重建影子索引（清空重建）。
   * @param {(p:{done:number,total:number})=>void} [onProgress]
   * @returns {Promise<number>} 索引文档数
   */
  async function reindex(onProgress) {
    return runIndex('full', onProgress);
  }

  /**
   * 统一的索引维护入口：把「启动同步 / 手动·定时同步 / 重建」收口为同一个 Promise，
   * 由独立 worker 线程（Node）或子进程（Bun）执行，保证主线程零阻塞、
   * 任意时刻只有一个维护操作在跑。
   * @param {'incremental'|'full'} mode  'incremental'=只补录不清空；'full'=清空重建
   * @param {(p:{done:number,total:number})=>void} [onProgress] 进度回调
   * @returns {Promise<number|{skipped:boolean,added:number}>}
   */
  function runIndex(mode, onProgress) {
    // 单实例互斥：已有维护在跑则复用。
    // - incremental 请求被 full 占用时，归一化为 { skipped, added }（视为跳过），
    //   避免手动增量同步误拿到 rebuild 返回的数字。
    // - full 请求被 incremental 占用时，等其结束后再补跑一次真正的全量重建，
    //   确保 full 始终返回文档数（数字），而非增量同步的 { skipped, added } 对象。
    if (indexingPromise) {
      if (mode === 'incremental') {
        return indexingPromise
          .then((r) => (typeof r === 'number' ? { skipped: true, added: 0 } : r))
          .catch(() => ({ skipped: true, added: 0 }));
      }
      if (indexingMode === 'full') return indexingPromise;
      return indexingPromise.then(
        () => runIndex('full', onProgress),
        () => runIndex('full', onProgress)
      );
    }
    const begin = () => { indexingMode = mode; runtimeStats.indexing = { running: true, mode, done: 0, total: 0 }; };
    const wrapped = (p) => {
      runtimeStats.indexing = { running: true, done: p.done, total: p.total, mode };
      onProgress?.(p);
    };
    // 执行载体选择：
    //   - 默认走 worker 线程（Node 与 Bun 同路径）。实测 Bun 1.4 的 worker postMessage
    //     逐批实时回传；而其 child_process fork IPC 会把消息积压到子进程退出才冲刷，
    //     长耗时重建期间父进程收不到任何进度（表现为进度条卡在第一批）。
    //   - Bun 编译态（bun build --compile）下 worker 打包行为未验证，且 exe 自拉起是
    //     成熟路径，故仍走子进程（spawnIndexChild）。
    //   - 兜底开关：DHT_INDEX_DRIVER=child 强制回到子进程路径，便于回退排查。
    const driver = isCompiledExe || process.env.DHT_INDEX_DRIVER === 'child' ? 'child' : 'worker';
    const spawn = driver === 'child' ? spawnIndexChild : spawnIndexWorker;
    begin();
    indexingPromise = spawn(mode, wrapped)
      .then((r) => { runtimeStats.indexing = { running: false, mode: null, done: 0, total: 0 }; return r; })
      .catch((e) => { runtimeStats.indexing = { running: false, mode: null, done: 0, total: 0 }; throw e; })
      .finally(() => { indexingPromise = null; indexingMode = null; });
    return indexingPromise;
  }

  /**
   * 运行期增量补录：按 last_rowid 把源库新增行灌入索引（由 index.js 定时调用，默认每小时一次）。
   * 与 reindex() 互斥（reindexPromise 非空）：重建期间跳过本轮，下一周期再试。
   * 不触发全量重建——tokenizer 变更等结构性变更交由重启或手动 reindex 处理。
   *
   * 注意：回调签名是 { rows, done, total }——rows 为本批落库行数（兼容旧调用方），
   * done/total 为累计进度；total 是预先算出的 id 跨度（源库有删除空洞时略大于实际行数），
   * 供 worker / SSE 把增量同步进度推给前端进度条。
   *
   * @param {(p: { rows: number, done: number, total: number }) => void} [onFlush] 每批落库后回调
   * @returns {{ skipped: boolean, added: number }} 本轮是否因重建而跳过、补录的 id 跨度
   */
  /** 增量补录核心（不清空，只补录新增）；供 worker / 同进程调用，互斥由 runIndex 负责 */
  function syncIncrementalSync(onFlush) {
    const src = openSourceRO(sourcePath);
    try {
      const last = Number(getMeta(db, 'last_rowid') ?? '0');
      const max = maxSourceId(src);
      if (max <= last) return { skipped: false, added: 0 };
      // 预先算出 id 跨度作为进度 total，随每批上报 done/total（进度条用）
      const expect = max - last;
      let acc = 0;
      populate(db, scanById(src, { from: last, size: REBUILD_BATCH }), ({ rows }) => {
        acc += rows;
        onFlush?.({ rows, done: acc, total: expect });
      });
      setMeta(db, 'last_rowid', String(max));
      optimizeFts(db);
      checkpointWAL(db);
      return { skipped: false, added: max - last };
    } finally {
      src.close();
    }
  }

  /**
   * 运行期增量补录（不清空）。走统一 runIndex：单实例互斥、可经 worker 异步执行。
   * @param {(p:{done:number,total:number})=>void} [onProgress]
   * @returns {Promise<{skipped:boolean, added:number}>}
   */
  async function syncIncremental(onProgress) {
    return runIndex('incremental', onProgress);
  }

  /** 关闭连接 */
  function close() {
    if (reindexWorker) {
      // Node 模式是 worker 线程（terminate()），Bun 模式是子进程（SIGKILL）
      if (typeof reindexWorker.terminate === 'function') reindexWorker.terminate();
      else {
        try { reindexWorker.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
      reindexWorker = null;
    }
    closeDb(rdb);
    closeDb(wdb);
  }

  return {
    db,
    // 实际解析后的路径，供调用方（如搜索子进程池）复用，避免各自再猜一遍路径
    indexPath,
    sourcePath,
    countMagnets,
    searchMagnets: search.searchMagnetsSync,
    listLatest: search.listLatestSync,
    topKeywords,
    listKeywordFilters,
    addKeywordFilter,
    addKeywordFilters,
    removeKeywordFilter,
    reindex,
    syncIncremental,
    syncIncrementalSync,
    rebuildSync,
    close,
  };
}

export default createMagnetDb;
