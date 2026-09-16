/**
 * magnets 表数据访问模块（影子索引架构，drizzle-orm 驱动）
 * ------------------------------------------------------------------
 * 源库（data/magnet.db，由其他应用写入）以只读方式打开读取，查询期不触碰源库。
 * 本模块在另一可写库（默认 data/dht.search.db）中维护：
 *   - magnets_fts    contentless FTS5 倒排索引（索引 name 与 files 的纯路径文本）
 *   - magnets_docs   去规范化副本（id + 展示/排序列 + fileCount），供检索 JOIN；
 *                    其 files 列存源库原文，详情接口按需据此构建扁平树
 *   - sync_meta      索引状态（数据水位 / 格式版本 / 维护状态）
 *
 * 常规表用 drizzle 查询构造器；FTS5 虚表无 drizzle 原生支持，检索与 DDL 走参数化 raw SQL。
 * 底层驱动由 ./db-driver.js 自动选择（Node → better-sqlite3，Bun → bun:sqlite）。
 *
 * 暴露能力：
 *   countMagnets()       —— 已索引条数
 *   getMagnetFiles()     —— 某条资源的完整文件树（扁平树）
 *   indexNeedsRebuild()  —— 当前索引库是否需要全量重建
 *   searchMagnets()      —— 检索（FTS5 模糊 / infohash 精确），支持分页与排序
 *   listLatest()         —— 最新入库列表（不经 FTS，按入库顺序从新到旧）
 *   topKeywords() / listKeywordFilters() / addKeywordFilter() / addKeywordFilters()
 *   removeKeywordFilter()—— 热词榜与过滤词维护
 *   reindex()            —— 全量重建影子索引（异步；在独立子进程中执行）
 *   syncIncremental()    —— 增量补录（异步）
 *   rebuildSync()        —— 在当前进程内同步执行全量重建（供子进程执行体 / 脚本使用）
 *   close()              —— 关闭连接
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import { runtimeStats } from './stats.js';
import { clampInt, normalizeKeyword, TOKEN_PATTERN } from './util.js';
import {
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
  probeFtsCapabilities,
} from './db-driver.js';
import { sql, eq } from 'drizzle-orm';
import { syncMeta } from './schema.js';
import { spawnChild } from './child-process.js';
import { ensureSchema, resetIndexTables, hasTable, DEFAULT_FTS_CAPS, INDEX_FORMAT } from './index/ddl.js';
import { createIndexTimer, NOOP_TIMER, formatPhases } from './index/timing.js';
import { transformFiles } from './index/transform.js';
import {
  SCAN_BATCH,
  WRITE_BATCH_ROWS,
  WRITE_BATCH_BYTES,
  RESET_TEMP_STORE,
  RESET_CACHE_KB,
  INDEX_THREADS,
} from './index/tuning.js';
import { INDEX_WORKER_FLAG } from './worker-flags.js';
import {
  CONFIG,
  resolveDbPath,
  DEFAULT_DB_PATH,
  DEFAULT_INDEX_DB_PATH,
  TABLE,
  FTS_TABLE,
  DOCS_TABLE,
  RECORD_COLUMNS,
  KEYWORD_TABLE,
  KEYWORD_FILTER_TABLE,
  TOKENIZER,
  STATE_TABLE,
  STATE_KEYS,
  BUILD_MODES,
} from './store.js';
import { SOURCE_READ_MMAP_MB } from './settings.js';
import { buildSearchApi } from './search/api.js';

// 对外 API 保持不变：检索侧的归一化 / MATCH 表达式 / 实现已拆到 search/，
// 这里 re-export 让 index.js 与 search-child.mjs 无需任何改动。
export { buildMatchExpression, normalizeSearchQuery, normalizeLatestQuery } from './search/query.js';
export { buildSearchApi } from './search/api.js';

/** 热词统计来源列：只统计 name，避开 files JSON 键名（path/size）噪声 */
const KEYWORD_SOURCE = 'name';
/** 热词过滤：低于此长度的 token 丢弃（去单字符噪声） */
const MIN_KEYWORD_LEN = 2;
/** 热词过滤：纯数字 token（年份/大小等噪声）丢弃 */
const NUMERIC_ONLY = /^\d+$/;

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 热词统计专用正则（exec 循环需要可变的 lastIndex，故与检索侧分开实例） */
const KEYWORD_RE = new RegExp(TOKEN_PATTERN.source, 'gu');

/**
 * 从文本提取合格的热词 token，就地累加进 kwMap（小写折叠 + 去噪，同文档去重）。
 *
 * @param {string} text            待统计文本（源库 name 列）
 * @param {Map}    kwMap           term -> { doc, occ } 累计表（随批次 flush 落库）
 * @param {Set}    seen            调用方复用的「本行已计过」集合
 * @param {Set}    filter          用户配置的噪声词集合
 */
function accumulateKeywords(text, kwMap, seen, filter) {
  const s = String(text ?? '');
  KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = KEYWORD_RE.exec(s)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length < MIN_KEYWORD_LEN || NUMERIC_ONLY.test(w)) continue;
    if (filter.has(w)) continue;
    const e = kwMap.get(w) ?? { doc: 0, occ: 0 };
    e.occ += 1;
    if (!seen.has(w)) {
      seen.add(w);
      e.doc += 1;
    }
    kwMap.set(w, e);
  }
}

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
  // mmap 预取窗口（SOURCE_READ_MMAP_MB 可调，0 = 关闭），用于提升顺序扫描吞吐
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

/**
 * 本进程使用的 FTS5 建表能力参数：detail / columnsize 取 DEFAULT_FTS_CAPS 基线，
 * contentless_delete 按引擎探测结果开启（仅在支持时启用）。
 */
let FTS_CAPS = DEFAULT_FTS_CAPS;
let capsLogged = false;
function resolveFtsCaps() {
  const probe = probeFtsCapabilities();
  FTS_CAPS = { ...DEFAULT_FTS_CAPS, contentlessDelete: probe.contentlessDelete === true };
  // 只打印一次：createMagnetDb 会随打开次数反复调用（子进程各自一份进程，
  // 每个进程打印一次），逐次打印会把正常日志刷满
  if (!capsLogged) {
    capsLogged = true;
    log.system(
      `SQLite ${probe.sqliteVersion}；FTS5 detail=none:${probe.detailNone ? 'Y' : 'N'} ` +
        `contentless_delete:${probe.contentlessDelete ? 'Y' : 'N'} ` +
        `排序线程:${probe.threads == null ? '不支持' : INDEX_THREADS}；` +
        `索引格式 ${INDEX_FORMAT}，建表参数 detail=${FTS_CAPS.detail} ` +
        `columnsize=${FTS_CAPS.columnsize ? 1 : 0} contentless_delete=${FTS_CAPS.contentlessDelete ? 1 : 0}`
    );
  }
  return { probe, caps: FTS_CAPS };
}

/** 增量同步触发 FTS 合并的累计行数阈值（自上次合并后累计写入达到该值才做一次部分合并） */
const FTS_MERGE_THRESHOLD = 50000;
/** 写连接（索引维护专用）的基线档位：打开时设定，重建期临时抬高后恢复到此处 */

const WRITE_BASE_CACHE_KB = 32000;
const WRITE_BASE_TEMP_STORE = 'FILE';
/** 索引维护执行体入口（与 db.js 同目录）；spawn 需要字符串路径而非 URL，预先换算一次 */
const REINDEX_WORKER_PATH = fileURLToPath(new URL('./reindex-worker.js', import.meta.url));

/** 重建 / 同步过程追踪：设置 DHT_REINDEX_DEBUG=1 启用（子进程继承父进程 env） */
const TRACE_INDEXING = process.env.DHT_REINDEX_DEBUG === '1';
const traceIndexing = (...args) => {
  if (TRACE_INDEXING) console.log('[reindex]', ...args);
};

/**
 * 按 id 升序分段扫描源表，逐行 yield（流式，不物化整表）。
 * from 为开区间下界，调用方需保证它小于待扫描的最小 id（重建传 min(id) - 1，增量传 last_rowid）。
 *
 * @param {object} src 源库只读连接
 * @param {object} [opts]
 * @param {number} [opts.from=0] 开区间下界
 * @param {number} [opts.size=SCAN_BATCH] 每批读取行数
 * @param {object} [opts.timer] 分段计时器
 * @returns {Generator<object>} 源表行
 */
function* scanById(src, { from = 0, size = SCAN_BATCH, timer = NOOP_TIMER } = {}) {
  let cursor = from;
  for (;;) {
    traceIndexing(`scanById 读源库: id>${cursor} limit=${size}`);
    // 只计 allRows 本身：源库读取（含 mmap 预取等待）与后续 JS 处理必须分开统计，
    // 否则「读盘慢」与「JS 慢」会混成一个数字，无法定位瓶颈
    const rows = timer.measure('scan', () =>
      allRows(
        src,
        `SELECT ${RECORD_COLUMNS} FROM ${TABLE} WHERE id > ? ORDER BY id LIMIT ?`,
        [cursor, size]
      )
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
 * 用源库行填充 FTS 与副本表，按批提交（复用 prepared statement）。
 * 原生 SQL 里的字面量一律用单引号（本构建禁用了双引号字符串字面量）。
 *
 * @param {db}        db            可写连接（drizzle 实例）
 * @param {Iterable}  rowsIterable  源行迭代器（数组或 scanById() 生成器）
 * @param {(info: { rows: number, lastId: number|null }) => void} [onFlush]
 *   每批落库后回调：rows 为本批行数，lastId 为本批最大 id（供换算扫描位置）
 * @param {object}    [timer]       分段计时器（createIndexTimer()），未传则零开销
 * @param {object}    [opts]
 * @param {boolean}   [opts.watermark=false] 是否每批同事务推进数据水位（增量 / 重建都开）
 */
function populate(db, rowsIterable, onFlush, timer = NOOP_TIMER, { watermark = false } = {}) {
  // drizzle 实例上的 $client 即底层原生连接（bun:sqlite 或 better-sqlite3）
  const raw = db.$client ?? db.session?.client;

  const insertFts = prepareStmt(raw, `INSERT INTO ${FTS_TABLE} (rowid, name, files) VALUES (?, ?, ?)`);
  // 副本表用 OR REPLACE（重复 id 覆盖）；contentless FTS5 不支持 REPLACE，FTS 侧必须普通 INSERT
  const insertDoc = prepareStmt(raw, `INSERT OR REPLACE INTO ${DOCS_TABLE}
      (id, name, infohash, magnet, files, fileCount, totalSize, fetchedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const upsertKw = prepareStmt(raw, `INSERT INTO ${KEYWORD_TABLE} (term, doc_count, occurrences) VALUES (?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET
       doc_count = doc_count + excluded.doc_count,
       occurrences = occurrences + excluded.occurrences`);
  // 数据水位推进语句：与数据同事务执行，保证「数据可见」与「水位已推进」原子一致
  const writeWatermark = watermark
    ? prepareStmt(
        raw,
        `INSERT INTO ${STATE_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
    : null;

  // entries = [{ row: 源行, ftsText: FTS 检索文本(纯路径), fileCount: 文件条目数 }]
  // 写入分三段计时：FTS 分词 / docs B-Tree 写入 / 热词 upsert
  const runBatch = transaction(raw, (entries, kws) => {
    // FTS 列只收纯路径文本（整个 JSON 会把 path/size 键名与体积数字也索引进去）
    timer.measure('fts', () => {
      for (const e of entries) runStmt(insertFts, [e.row.id, e.row.name, e.ftsText]);
    });
    timer.measure('docs', () => {
      for (const e of entries) {
        const r = e.row;
        // files 存源库原文（列表只下发 fileCount + 预览，详情接口再按需建树）
        runStmt(insertDoc, [r.id, r.name, r.infohash, r.magnet, r.files, e.fileCount, r.totalSize, r.fetchedAt]);
      }
    });
    timer.measure('keyword', () => {
      for (const [term, k] of kws) runStmt(upsertKw, [term, k.doc, k.occ]);
    });
    if (writeWatermark) {
      // 本批最大 id（不假设 entries 有序，取一次最大值即可）
      let lastId = null;
      for (const e of entries) if (lastId === null || e.row.id > lastId) lastId = e.row.id;
      if (lastId !== null) runStmt(writeWatermark, [STATE_KEYS.dataWatermark, String(lastId)]);
    }
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
    // exclude 而非 measure：本调用包着 fts/docs/keyword 三段（已各自计时），
    // 只有「扣除它们之后的净耗时」才应记为 txn —— 即 COMMIT 与 WAL 落页
    timer.exclude('txn', () => runBatch(buf, kwMap));
    traceIndexing(`populate 写入批次完成: rows=${buf.length}`);
    // lastId 供调用方换算「已扫到哪个 id」：进度按已扫区间推进，与写入行数无关
    onFlush?.({ rows: buf.length, lastId: buf[buf.length - 1]?.row.id ?? null });
    buf = [];
    bytes = 0;
    kwMap.clear();
  };

  for (const r of rowsIterable) {
    // 索引期只做「parse + 拼路径 + 计数」这一份最小转换（见 index/transform.js）；
    // 放在事务外，避免拉长写锁持有时间。
    const { ftsText, fileCount } = transformFiles(r.files);
    buf.push({ row: r, ftsText, fileCount });
    // 字节阈值按**源原文**估算：写进 docs 的就是原文，事务体量应与它同口径
    bytes += (r.name?.length ?? 0) + (r.files?.length ?? 0);
    // 热词统计：同一文档内去重，doc_count 只计一次（就地累加，不分配中间数组）
    seen.clear();
    accumulateKeywords(r[KEYWORD_SOURCE], kwMap, seen, filter);
    // 写批阈值（与读批 SCAN_BATCH 无关，见 index/tuning.js）：先到先生效
    if (buf.length >= WRITE_BATCH_ROWS || bytes >= WRITE_BATCH_BYTES) flush();
  }
  flush();
}

/**
 * 向 FTS5 发一条特殊命令（`INSERT INTO fts(fts, rank) VALUES(...)`）。
 * 命令字走 sql.raw 拼为 SQL 字面量；取值只有两个内部常量，无注入面。
 *
 * @param {'optimize'|'merge'} command optimize=全量重建收尾一次性合并；merge=增量收尾按等级部分合并
 * @param {number} [level=4] 合并等级，4 为 FTS5 推荐的默认值
 */
function ftsCommand(db, command, level = 4) {
  db.run(sql`INSERT INTO ${sql.raw(FTS_TABLE)} (${sql.raw(FTS_TABLE)}, rank)
    VALUES (${sql.raw(`'${command}'`)}, ${level})`);
}

/**
 * 把 WAL 合并回主库并截断（TRUNCATE），避免 -wal 无限增长拖慢读查询。
 * 仅在写连接上调用（db 为 drizzle 可写实例）。
 */
function checkpointWAL(db) {
  const raw = db.$client ?? db.session?.client;
  execRaw(raw, 'PRAGMA wal_checkpoint(TRUNCATE)');
}

/** 影子库路径：正式索引库路径 + '.build'（重建写它，完成后原子切换） */
function buildDbPath(indexPath) {
  return `${indexPath}.build`;
}

/** 索引库改名的重试次数与间隔（对抗 Windows 上的瞬时文件锁：句柄延迟释放 / 杀毒扫描） */
const SWAP_RETRIES = 20;
const SWAP_RETRY_MS = 100;

/**
 * 同步操作的重试包装（仅用于索引库改名这类「失败多半是瞬时锁」的动作）。
 * @template T
 * @param {() => T} fn
 * @param {number} attempts 总尝试次数（含首次）
 * @param {number} delayMs  每次失败后的等待
 * @returns {Promise<T>}
 */
async function retryAsync(fn, attempts, delayMs) {
  for (let i = 0; ; i += 1) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** 删除一个 SQLite 库文件及其 WAL / SHM 伴生文件（尽力而为，用于清理影子库与备份残留） */
function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* 清不掉不影响主流程（下次切换前还会再清一次） */
    }
  }
}

/**
 * 一次索引「通过」（pass）—— 重建与增量补录的唯一实现，差别由 reset 参数化：
 *
 *   reset=true （重建）：DDL 重置 → 从 min(id)-1 起扫 → 建二级索引 → 写结构水位
 *   reset=false（增量）：保留现有数据 → 从数据水位 last_rowid 起扫 → 只推进数据水位
 *
 * 两层水位：数据水位 last_rowid 每批随事务推进（断点续跑）；结构水位 tokenizer /
 * files_format 只在重建成功收尾时写（中途失败留在旧值，下次启动仍判定需重建）。
 *
 * @param {object} db
 * @param {object} src   源库只读连接（打开/关闭由调用方负责）
 * @param {{ reset: boolean }} opts reset=true 重建（清空 + 写结构水位），false 增量补录
 * @param {(p: object) => void} [onFlush] 每个阶段开始时 / 每批落库后回调，见下方 report()
 * @param {object} [timer] 分段计时器（createIndexTimer()），可选
 * @returns {{ rows: number, total: number, from: number, max: number, changed: boolean }}
 *   rows=实际写入行数；total=id 跨度；from=扫描起点（开区间）；max=源库最大 id；changed=是否有新行
 */
function indexPass(db, src, { reset }, onFlush, timer = NOOP_TIMER) {
  const raw = db.$client ?? db.session?.client;

  // 维护状态：崩溃（SIGKILL）时走不到收尾的归位写，build_mode 会留在 full / incremental，
  // 下次启动据此识别「上次维护被中断」（仅用于提示与观测，正确性由两层水位保证）
  setMeta(db, STATE_KEYS.buildMode, reset ? BUILD_MODES.full : BUILD_MODES.incremental);

  // 重建期写盘策略（仅对重建安全：整份索引可整体重跑；增量不能这样设，丢了就是真丢）：
  // 关自动 checkpoint（新页顺序追加到 WAL，末尾一次性回写）+ 跳过落盘等待
  if (reset) {
    setPragma(raw, 'wal_autocheckpoint', 0);
    setPragma(raw, 'synchronous', 'OFF');
    // 排序 / FTS 合并用的临时结构放内存
    setPragma(raw, 'temp_store', RESET_TEMP_STORE);
    // 重建反复访问 B-Tree 内部页，缓存抬到 RESET_CACHE_KB
    setPragma(raw, 'cache_size', -RESET_CACHE_KB);
  }

  let done = 0;
  let from = 0;
  let max = 0;
  let total = 0;
  let scanned = 0; // 已扫过的 id 区间长度（进度按它算完成度：写入行数不含 id 空洞）
  // 「第 N/M 步」的计数只含必然执行的阶段：增量的 merge 是条件步骤（未达合并阈值不执行），
  // 不列入计数，否则会出现「第 1/3 步 → 第 3/3 步」的跳号；它仍会以阶段名上报
  const steps = reset ? ['schema', 'scan', 'index', 'merge', 'checkpoint'] : ['scan', 'checkpoint'];
  /**
   * 上报当前阶段。
   * 只有 scan 阶段带 scanned / total：其余阶段（建索引 / 合并 FTS / 回写）没有可换算的
   * 比例，故不下发比例字段，避免调用方画出失真的进度条。
   * @param {string} step 阶段名（见 steps）
   * @param {number} [rows] 本批写入行数（仅 scan 阶段有效）
   */
  const report = (step, rows = 0) => {
    const base = { rows, done, step, stepIndex: steps.indexOf(step) + 1, stepCount: steps.length };
    onFlush?.(step === 'scan' ? { ...base, scanned, total } : base);
  };
  try {
    if (reset) {
      // schema 重置（FTS / docs / keyword_stats）必须整体在一个事务里：与查询并发时，
      // DROP 与 CREATE 分处两个事务会暴露「表已 DROP」的中间态（no such table）
      report('schema');
      timer.measure('schema', () => raw.transaction(() => resetIndexTables(db, FTS_CAPS))());
    }

    // 起点（keyset 开区间）：重建从 min(id) - 1 起（从 0 起会漏掉 id <= 0 的行），增量从数据水位起。
    // 进度分母用 id 跨度而非 count(*)（O(1)，避免对源库做整趟全表预扫）
    const ext = getRow(src, `SELECT min(id) AS lo, max(id) AS hi FROM ${TABLE}`);
    from = reset
      ? (ext?.lo == null ? 0 : Number(ext.lo) - 1)
      : Number(getMeta(db, STATE_KEYS.dataWatermark) ?? '0');
    max = Number(ext?.hi ?? 0);
    total = max - from;
    // 未 populate 时也要报一次：增量同步没有新行时同样处在「扫描」这一步
    report('scan');

    if (max > from) {
      traceIndexing(`indexPass: reset=${reset} 开始 populate（from=${from} total=${total}）`);
      // watermark: true —— 数据水位在每批事务内与数据一起提交（断点续跑）
      populate(db, scanById(src, { from, size: SCAN_BATCH, timer }), ({ rows, lastId }) => {
        done += rows;
        if (lastId != null) scanned = Number(lastId) - from;
        report('scan', rows);
      }, timer, { watermark: true });
      traceIndexing(`indexPass: populate 完成 rows=${done}`);
    }

    if (reset) {
      // 二级索引在灌数据之后建（空表带索引会让每条 INSERT 都维护 B-Tree，慢 2~3 倍）
      //  - totalSize：按大小排序（两步法）使用，见 search/api.js 的 plainColSort
      //  - lower(infohash)：hash 检索（?by=hash）走点查；无此索引会对 313 万行全表扫，
      //    表达式索引同时服务前缀 LIKE。实测 EXPLAIN 由 SCAN 变为 COVERING INDEX 查找
      //  - 刻意不建 fetchedAt 索引：两步法「WHERE m.id IN(...) ORDER BY m.fetchedAt」下
      //    planner 永远走 TEMP B-TREE（宽词 21s→21s 零收益），加了只增写放大
      report('index');
      timer.measure('index', () => {
        db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_totalSize`)} ON ${sql.raw(DOCS_TABLE)}(totalSize)`);
        db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_infohash_lower`)} ON ${sql.raw(DOCS_TABLE)}(lower(infohash))`);
      });
      // 结构水位：只有整库重建成功走到这里才写，中途失败留在旧值，下次启动仍判定需重建
      setMeta(db, STATE_KEYS.tokenizer, TOKENIZER);
      setMeta(db, STATE_KEYS.filesFormat, INDEX_FORMAT);
      // 数据水位取源库当前 max：覆盖重建期间新增的行
      setMeta(db, STATE_KEYS.dataWatermark, String(maxSourceId(src)));
    } else {
      // 自修复：已存在但未触发整库重建的库（部署前建、INDEX_FORMAT 未变）可能缺新二级索引；
      // IF NOT EXISTS 保证只对缺失索引建一次（建 313 万行索引是一次性开销），之后仅为目录探查
      db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_totalSize`)} ON ${sql.raw(DOCS_TABLE)}(totalSize)`);
      db.run(sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${DOCS_TABLE}_infohash_lower`)} ON ${sql.raw(DOCS_TABLE)}(lower(infohash))`);
      if (max > from) {
        // 数据水位取扫描前的 max（本轮补录到的行）。只在真有新增时推进：写小会导致下次重扫
        setMeta(db, STATE_KEYS.dataWatermark, String(max));
      }
    }

    // FTS 合并：重建一次彻底合并（optimize）；增量按「自上次合并后累计写入行数」节流做部分合并
    if (reset) {
      report('merge');
      timer.measure('merge', () => ftsCommand(db, 'optimize'));
      setMeta(db, STATE_KEYS.ftsPending, '0');
    } else if (done > 0) {
      const pending = Number(getMeta(db, STATE_KEYS.ftsPending) ?? '0') + done;
      if (pending >= FTS_MERGE_THRESHOLD) {
        report('merge');
        timer.measure('merge', () => ftsCommand(db, 'merge'));
        setMeta(db, STATE_KEYS.ftsPending, '0');
      } else {
        setMeta(db, STATE_KEYS.ftsPending, String(pending));
      }
    }
  } finally {
    if (reset) {
      // 异常也要恢复基线档位（增量维护共用这条写连接）
      setPragma(raw, 'wal_autocheckpoint', 1000);
      setPragma(raw, 'synchronous', 'NORMAL');
      setPragma(raw, 'cache_size', -WRITE_BASE_CACHE_KB);
      setPragma(raw, 'temp_store', WRITE_BASE_TEMP_STORE);
    }
    // 维护正常结束（含业务异常）时归位；被 SIGKILL 时不会执行到这里，build_mode 留痕
    setMeta(db, STATE_KEYS.buildMode, BUILD_MODES.idle);
  }

  // checkpoint 放在恢复 synchronous=NORMAL 之后：让 WAL 中累积的页以 durable 方式写回
  if (reset || done > 0) {
    report('checkpoint');
    timer.measure('checkpoint', () => checkpointWAL(db));
  }

  return { rows: done, total, from, max, changed: max > from };
}

/**
 * 索引结构是否需要全量重建：索引表缺失 / tokenizer 变更 / 索引格式版本变更。
 * 这三类变更靠增量补录无法自愈，必须整库重灌。
 */
function needsFullRebuild(db) {
  if (!hasTable(db, FTS_TABLE) || !hasTable(db, DOCS_TABLE)) return true;
  if (getMeta(db, STATE_KEYS.tokenizer) !== TOKENIZER) return true;
  return getMeta(db, STATE_KEYS.filesFormat) !== INDEX_FORMAT;
}

/**
 * 启动同步：索引表缺失 / tokenizer 变更 / files 格式变更时全量重建，否则按 last_rowid
 * 增量补录源库新增行。两种情形都由 indexPass 实现，这里只剩一个 reset 判定。
 */
function syncIndex(db, src, onFlush) {
  const timer = createIndexTimer();
  try {
    indexPass(db, src, { reset: needsFullRebuild(db) }, onFlush, timer);
  } finally {
    runtimeStats.indexing.phases = timer.snapshot();
    traceIndexing(`syncIndex 分段耗时: ${timer.summary()}`);
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
export function createMagnetDb(options = {}) {
  const opts = typeof options === 'string' ? { source: options } : options;
  // 优先级：调用方显式传入 > config.js > 模块内默认值
  const sourcePath = resolveDbPath(
    opts.source ?? CONFIG.sourceDbPath ?? DEFAULT_DB_PATH
  );
  const indexPath = resolveDbPath(
    opts.indexDbPath ?? CONFIG.indexDbPath ?? DEFAULT_INDEX_DB_PATH
  );

  fs.mkdirSync(path.dirname(path.resolve(indexPath)), { recursive: true });

  // 引擎能力探测（进程内一次）：结果只决定 contentless_delete ——
  // 不支持该选项的引擎建表会直接失败，必须实际试一次
  const { probe, caps } = resolveFtsCaps();

  /* ------------------------------------------------------------------ */
  /* 索引库连接（生命周期与「原子切换」绑定：切换后必须整体重开）          */
  /* ------------------------------------------------------------------ */
  let wdb = null;
  let db = null;
  let rdb = null;
  let dbRO = null;
  let search = null;
  /** 切换索引库文件前的钩子，由 HTTP 层注册（回收持有旧库句柄的搜索子进程） */
  let beforeSwap = null;
  /** 切换完成（或失败回滚）后的钩子：让 HTTP 层解除前一个钩子造成的暂停 */
  let afterSwap = null;

  /** 打开索引库的可写 / 只读连接：首次打开与原子切换后重开共用同一段逻辑 */
  function openIndexConnections() {
    // 可写连接：仅供 syncIndex / reindex 等索引维护使用
    wdb = openDatabase(indexPath);
    setPragma(wdb, 'busy_timeout', 5000);
    setPragma(wdb, 'journal_mode', 'WAL');
    // temp_store 基线取 FILE（重建期临时抬高，见 indexPass）
    setPragma(wdb, 'mmap_size', 0);
    setPragma(wdb, 'cache_size', -WRITE_BASE_CACHE_KB);
    setPragma(wdb, 'synchronous', 'NORMAL');
    setPragma(wdb, 'temp_store', WRITE_BASE_TEMP_STORE);
    // 排序辅助线程（CREATE INDEX 多路归并）：引擎未支持时 probe.threads 为 null，设置会被忽略
    if (INDEX_THREADS > 0 && probe.threads != null) setPragma(wdb, 'threads', INDEX_THREADS);
    db = createDrizzle(wdb);

    // 建表语句收敛在 index/ddl.js（幂等）：全新 / 子进程内打开的库也能被安全读写
    ensureSchema(db, caps);

    // 上次维护是否被中断（build_mode 非 idle 即上次没走完）
    const interrupted = getMeta(db, STATE_KEYS.buildMode);
    if (interrupted && interrupted !== BUILD_MODES.idle) {
      log.warn(`上次索引维护（${interrupted}）未正常结束，将按水位续跑或重建`);
    }

    // 查询专用只读连接：检索 / 计数只在此连接上执行 SELECT
    rdb = openDatabase(indexPath, { readonly: true });
    setPragma(rdb, 'query_only', 'ON');
    // 维护子进程在并发写，读连接遇写锁应等待而非立刻抛 SQLITE_BUSY
    setPragma(rdb, 'busy_timeout', 5000);
    // 主进程只读连接只服务计数 / 热词榜等轻量查询（搜索子进程的配额见 config.js）
    setPragma(rdb, 'cache_size', -2000);
    setPragma(rdb, 'mmap_size', 33554432);
    // 排序临时 B-Tree 放内存：宽泛词排序的匹配量可达数十万，落盘慢数倍
    setPragma(rdb, 'temp_store', 'MEMORY');
    dbRO = createDrizzle(rdb);

    // 检索实现绑定当前只读连接 —— 切换索引库后必须重建，否则仍指向被替换掉的旧文件
    search = buildSearchApi(dbRO);
  }

  /** 释放索引库连接（原子切换前必须调用：Windows 下持有句柄无法改名文件） */
  function closeIndexConnections() {
    if (rdb) {
      closeDb(rdb);
      rdb = null;
      dbRO = null;
      search = null;
    }
    if (wdb) {
      closeDb(wdb);
      wdb = null;
      db = null;
    }
  }

  openIndexConnections();

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
    // 列校验：显式检查而不是等扫描时由 SQL 顺带抛出——空源库不会触发扫描，会漏检
    const sourceCols = new Set(allRows(src, `PRAGMA table_info(${TABLE})`).map((r) => r.name));
    const missingCols = RECORD_COLUMNS.split(', ').filter((c) => !sourceCols.has(c));
    if (missingCols.length) {
      throw new Error(`源库 ${TABLE} 表缺少列：${missingCols.join(', ')}（期望列：${RECORD_COLUMNS}）`);
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
      // 末批不足一个阈值时上面不会触发，这里补打总数
      if (done > logged) log.ok(`索引完成，共 ${done} 行`);
    }
  } finally {
    src.close();
  }

  // 索引维护子进程的堆上限经 --max-old-space-size 传入（Node）；Bun 无等价硬上限，仅加 --smol

  let reindexWorker = null;
  let indexingPromise = null;
  let indexingMode = null; // 当前维护类型（'full' | 'incremental'），互斥复用时用于结果归一化

  /**
   * 派生执行体子进程运行索引维护（唯一载体，派生细节见 src/child-process.js）。
   * 堆上限经 --max-old-space-size 传入（Node）；参数经环境变量 DHT_REINDEX_JOB（JSON）传入，
   * 进度 / 结果经 IPC 回传（见 reindex-worker.js）。
   *
   * @param {'incremental'|'full'} mode  'incremental'=只补录不清空；'full'=清空重建
   * @param {(p: { done: number; total: number }) => void} [onProgress] 进度回调
   * @param {object} [opts]
   * @param {string} [opts.targetPath] 子进程要写入的索引库路径，默认正式库；
   *        重建时传影子库路径，构建完成后由主进程原子切换（见 swapIndex）
   */
  function spawnIndexChild(mode, onProgress, { targetPath = indexPath } = {}) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        DHT_REINDEX_JOB: JSON.stringify({ sourcePath, indexPath: targetPath, mode }),
      };
      const child = spawnChild({
        entryPath: REINDEX_WORKER_PATH,
        flag: INDEX_WORKER_FLAG,
        heapMb: clampInt(CONFIG.reindexMaxOldSpaceMb, 2048, 256, 65536),
        env,
      });
      reindexWorker = child;
      log.system(`索引子进程已派生 pid=${child.pid}（mode=${mode}），等待 IPC 回传`);

      /** 等子进程真正退出后再执行交付（Windows 下文件句柄随进程退出才彻底释放） */
      const deliverAfterExit = (done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        const guard = setTimeout(done, 5000); // 兜底：不让调用方因等待退出而永久挂起
        child.once('exit', () => {
          clearTimeout(guard);
          done();
        });
      };

      let settled = false;
      const settle = (ok, value) => {
        if (settled) return;
        settled = true;
        reindexWorker = null;
        if (!ok) {
          // 终态即终止：SIGKILL 由操作系统回收，卡在原生调用里的语句也随之中断
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }
        // 无论成败都等子进程退出再交付：它可能继承索引库文件句柄，
        // Windows 下会让切换（rename）与影子库清理失败（EBUSY）
        deliverAfterExit(() => (ok ? resolve : reject)(value));
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
          // 分段耗时由子进程随终态回传（计时器活在子进程里）
          if (msg.phases) runtimeStats.indexing.phases = msg.phases;
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

  /**
   * 索引库原子切换期间的守卫：连接此时为 null（关闭 → 改名 → 重开，最坏数秒），
   * 把解引用错误统一转成 503，避免调用方拿到难以诊断的 `Cannot read properties of null`。
   */
  function requireIndexReady() {
    if (!db || !dbRO || !search) {
      throw Object.assign(new Error('索引库正在切换，请稍后重试'), { status: 503 });
    }
  }

  /** 已索引条数（与检索结果一致） */
  function countMagnets() {
    requireIndexReady();
    const row = dbRO.all(sql`SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)}`)[0];
    return Number(row?.total ?? 0);
  }

  /**
   * 取某条 magnet 的完整文件树（扁平树）。
   * 转发给 search.getMagnetFilesSync：索引库切换后 search 会重建，这里不会指向旧连接。
   */
  function getMagnetFiles(id) {
    requireIndexReady();
    return search.getMagnetFilesSync(id);
  }

  /**
   * 当前索引库是否需要一次全量重建（索引表缺失 / tokenizer 变更 / 索引格式版本过期）。
   * HTTP 层在启动时用它决定是否跑一次迁移重建。
   */
  function indexNeedsRebuild() {
    return needsFullRebuild(db);
  }

  /**
   * 热词榜：按文档频率降序返回 top N 关键词。
   * @param {number} [limit=50] 返回条数，钳制 1..1000
   * @returns {Array<{term: string, doc_count: number, occurrences: number}>}
   */
  function topKeywords(limit = 50) {
    requireIndexReady();
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
    requireIndexReady();
    return dbRO.all(sql`
      SELECT term, created_at
      FROM ${sql.raw(KEYWORD_FILTER_TABLE)}
      ORDER BY term
    `);
  }

  /** 添加热词过滤词（幂等，小写归一；增量统计与热词榜均立即生效） */
  function addKeywordFilter(term) {
    requireIndexReady();
    const t = normalizeKeyword(term);
    if (!t) throw new TypeError('addKeywordFilter: term 不能为空，且需包含字母或数字');
    db.run(sql`INSERT OR IGNORE INTO ${sql.raw(KEYWORD_FILTER_TABLE)} (term, created_at)
      VALUES (${t}, ${Date.now()})`);
    return t;
  }

  /**
   * 批量添加热词过滤词（幂等、去重、单事务）。
   * @param {Iterable<string>} terms 原始词条；空白 / 纯符号等无效项自动跳过
   * @returns {number} 实际写入的条数（已去重）
   */
  function addKeywordFilters(terms) {
    requireIndexReady();
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

  /**
   * 删除热词过滤词（删除后该词重新出现在热词榜）。
   * 归一化只做「去空白 + 小写」：normalizeKeyword 会拒掉不含字母数字的词，此处不适用。
   */
  function removeKeywordFilter(term) {
    requireIndexReady();
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) throw new TypeError('removeKeywordFilter: term 不能为空');
    db.run(sql`DELETE FROM ${sql.raw(KEYWORD_FILTER_TABLE)} WHERE term = ${t}`);
    return t;
  }

  /**
   * 在当前进程内同步执行全量重建。供索引维护子进程（reindex-worker）调用；
   * 脚本 / 测试想跳过进程开销时也可直接用。
   * 进度分母（id 跨度）与回调口径由 indexPass 统一提供。
   * @param {(p: { done: number, total: number }) => void} [onProgress]
   * @returns {number} 索引文档数
   */
  function rebuildSync(onProgress) {
    const s = openSourceRO(sourcePath);
    const timer = createIndexTimer();
    try {
      const r = indexPass(db, s, { reset: true }, onProgress, timer);
      traceIndexing(`rebuildSync: 全量重建完成 rows=${r.rows} total=${r.total}`);
    } finally {
      s.close();
      // 分段耗时写进本进程的 runtimeStats；子进程路径由 reindex-worker.js 随终态回传
      runtimeStats.indexing.phases = timer.snapshot();
      traceIndexing(`rebuildSync 分段耗时: ${timer.summary()}`);
    }
    traceIndexing('rebuildSync: 统计索引库 FTS 文档数');
    const n = Number(dbRO.all(sql`SELECT count(*) AS c FROM ${sql.raw(FTS_TABLE)}`)[0]?.c ?? 0);
    traceIndexing(`rebuildSync: 返回 indexed=${n}`);
    return n;
  }

  /**
   * 全量重建影子索引（清空重建）：在独立子进程中构建影子库，完成后由主进程原子切换。
   * 不阻塞事件循环，子进程 OOM / 崩溃不影响主进程，且可被 SIGKILL 中断
   * （派生细节见 src/child-process.js，切换细节见 swapIndex）。
   * @param {(p: { done: number, total: number }) => void} [onProgress] 进度回调
   * @returns {Promise<number>} 索引文档数
   */
  async function reindex(onProgress) {
    return runIndex('full', onProgress);
  }

  /**
   * 统一的索引维护入口：把「启动同步 / 手动·定时同步 / 重建」收口为同一个 Promise，
   * 由独立子进程执行，保证主线程零阻塞、任意时刻只有一个维护操作在跑。
   * @param {'incremental'|'full'} mode  'incremental'=只补录不清空；'full'=清空重建
   * @param {(p:{done:number,total:number})=>void} [onProgress] 进度回调
   * @returns {Promise<number|{skipped:boolean,added:number}>}
   */
  function runIndex(mode, onProgress) {
    // 单实例互斥：已有维护在跑则复用（incremental 被占用时归一化为 { skipped, added }；
    // full 被占用时等其结束再补跑一次真正的重建，保证 full 始终返回文档数）
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
    // 用展开而非整体替换：phases（分段耗时）由被调用的索引函数写入
    const begin = () => {
      indexingMode = mode;
      runtimeStats.indexing = {
        ...runtimeStats.indexing,
        running: true, mode, done: 0, scanned: 0, total: 0,
        step: null, stepIndex: 0, stepCount: 0, startedAt: Date.now(),
      };
    };
    // 进度字段透传（阶段名 + 计数），SSE 与前端据此显示「正在做什么、第几步」
    const wrapped = (p) => {
      runtimeStats.indexing = {
        ...runtimeStats.indexing,
        running: true, mode,
        done: p.done, scanned: p.scanned ?? 0, total: p.total ?? 0,
        step: p.step ?? null, stepIndex: p.stepIndex ?? 0, stepCount: p.stepCount ?? 0,
      };
      onProgress?.(p);
    };
    // 执行载体唯一：spawn 子进程（见 src/child-process.js）
    begin();
    indexingPromise = runIndexTask(mode, wrapped)
      .then((r) => {
        // 分段耗时留日志：重建必记；增量只在真补录了行时记，免得空转的定时同步刷满日志
        const didWork = mode === 'full' || (r && typeof r === 'object' && Number(r.added) > 0);
        if (didWork && runtimeStats.indexing.phases) {
          log.system(
            `索引${mode === 'full' ? '重建' : '同步'}分段耗时: ${formatPhases(runtimeStats.indexing.phases)}`
          );
        }
        runtimeStats.indexing = { ...runtimeStats.indexing, running: false, mode: null, done: 0, total: 0 };
        return r;
      })
      .catch((e) => { runtimeStats.indexing = { ...runtimeStats.indexing, running: false, mode: null, done: 0, total: 0 }; throw e; })
      .finally(() => { indexingPromise = null; indexingMode = null; });
    return indexingPromise;
  }

  /**
   * 执行一次索引维护：
   *   incremental —— 子进程直接写正式索引库（可从中断处续跑）；
   *   full        —— 子进程构建影子库，成功后由主进程原子切换。
   * 影子库使重建期间正式库不被触碰，检索照常可用；构建失败只需删掉影子文件。
   */
  async function runIndexTask(mode, onProgress) {
    if (mode !== 'full') return spawnIndexChild('incremental', onProgress);

    const buildPath = buildDbPath(indexPath);
    removeDbFiles(buildPath); // 清掉上次残留的影子库（构建失败 / 进程崩溃留下的）
    let indexed;
    try {
      indexed = await spawnIndexChild('full', onProgress, { targetPath: buildPath });
    } catch (err) {
      removeDbFiles(buildPath); // 半成品直接丢弃：正式库从未被改写过
      throw err;
    }
    await swapIndex(buildPath);
    return indexed;
  }

  /**
   * 用构建好的影子库原子替换正式索引库。
   *
   * 顺序（Windows 下持有句柄无法改名，且 rename 不能覆盖已存在目标）：
   *   1. beforeSwap 回调（HTTP 层回收持有旧库句柄的搜索子进程并暂停派发）；
   *   2. 关闭本进程的读写连接；
   *   3. 正式库 → .old 备份 → 影子库 → 正式库 → 清理备份与残留文件；
   *   4. 重开连接（指向新库）；
   *   5. afterSwap 回调（在 finally 里，成功与失败都走到）。
   * 第 3 步任一环节失败都会把备份挪回原位，保证线上索引不丢失。
   */
  async function swapIndex(buildPath) {
    const backup = `${indexPath}.old`;
    try {
      beforeSwap?.();
    } catch (err) {
      // 回收读者失败不该阻断切换：连接关闭那一步仍会释放本进程的句柄
      log.warn(`索引切换前回收读者失败（继续切换）：${err?.message || err}`);
    }
    closeIndexConnections();
    try {
      // Windows 下改名要求目标无句柄，句柄释放可能有极短延迟，故退避重试
      await retryAsync(() => {
        fs.rmSync(backup, { force: true });
        if (fs.existsSync(indexPath)) fs.renameSync(indexPath, backup);
      }, SWAP_RETRIES, SWAP_RETRY_MS);
      await retryAsync(() => fs.renameSync(buildPath, indexPath), SWAP_RETRIES, SWAP_RETRY_MS);
      fs.rmSync(backup, { force: true });
      // 影子库主文件已被改名，-wal/-shm 理论上为空（子进程收尾做过 TRUNCATE checkpoint）
      removeDbFiles(buildPath);
      log.system('索引库已切换到新构建的副本（重建期间线上未受影响）');
    } catch (err) {
      // 回滚：把备份挪回原位，正式库仍是可用的旧版本
      try {
        if (!fs.existsSync(indexPath) && fs.existsSync(backup)) fs.renameSync(backup, indexPath);
      } catch {
        /* 回滚本身失败也要把原始错误抛出去 */
      }
      throw err;
    } finally {
      try {
        openIndexConnections();
      } finally {
        // 无论重开连接成功与否都要解除 beforeSwap 的暂停，否则搜索池会一直不派发
        try {
          afterSwap?.();
        } catch (err) {
          log.warn(`索引切换后恢复读者失败：${err?.message || err}`);
        }
      }
    }
  }

  /**
   * 增量补录核心（不清空，只补录新增）：按数据水位把源库新增行灌入索引；
   * 索引结构过期时改跑一次全量重建（增量无法自愈），互斥由 runIndex 负责。
   *
   * @param {(p: { rows: number, done: number, total: number }) => void} [onFlush] 每批落库后回调
   * @returns {{ skipped: boolean, added: number }} added 为补录的 id 跨度（结构过期改跑重建时为写入行数）
   */
  function syncIncrementalSync(onFlush) {
    const src = openSourceRO(sourcePath);
    const timer = createIndexTimer();
    try {
      const reset = needsFullRebuild(db);
      if (reset) traceIndexing('syncIncrementalSync: 索引结构过期，改跑全量重建');
      const r = indexPass(db, src, { reset }, onFlush, timer);
      // added 口径：正常增量返回 id 跨度；因结构过期改跑重建时返回实际写入行数
      return { skipped: false, added: reset ? r.rows : r.changed ? r.total : 0 };
    } finally {
      src.close();
      runtimeStats.indexing.phases = timer.snapshot();
      traceIndexing(`syncIncrementalSync 分段耗时: ${timer.summary()}`);
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

  /**
   * 注册「切换索引库之前」的钩子。
   * HTTP 层用它回收持有旧库只读句柄的搜索子进程 —— Windows 下句柄不释放就无法改名文件。
   * @param {() => void} fn
   */
  function setBeforeSwap(fn) {
    beforeSwap = typeof fn === 'function' ? fn : null;
  }

  /**
   * 注册「切换索引库之后」的钩子（成功与失败回滚都会调用）。
   * 与 setBeforeSwap 成对：前置钩子若暂停 / 回收了读者，必须在这里恢复。
   * @param {() => void} fn
   */
  function setAfterSwap(fn) {
    afterSwap = typeof fn === 'function' ? fn : null;
  }

  /** 关闭连接 */
  function close() {
    if (reindexWorker) {
      // 统一为子进程：SIGKILL 由操作系统回收，卡在原生调用里的维护语句也能被中断
      try { reindexWorker.kill('SIGKILL'); } catch { /* 已退出 */ }
      reindexWorker = null;
    }
    closeIndexConnections();
  }

  return {
    // 用 getter 暴露可写连接：原子切换会重开连接，快照式的 db 会指向已关闭的旧对象
    get db() {
      return db;
    },
    // 实际解析后的路径，供调用方（如搜索子进程池）复用，避免各自再猜一遍路径
    indexPath,
    sourcePath,
    countMagnets,
    getMagnetFiles,
    indexNeedsRebuild,
    // 检索入口用转发而不是直接引用函数：切换索引库后 search 会被重建（绑定新连接）
    searchMagnets: (options) => search.searchMagnetsSync(options),
    listLatest: (options) => search.listLatestSync(options),
    setBeforeSwap,
    setAfterSwap,
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
