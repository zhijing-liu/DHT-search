/**
 * 索引库 DDL 的唯一来源
 * ------------------------------------------------------------------
 * 与 `src/schema.js` 的分工：那个文件是 drizzle 表定义（供查询构造器引用字段），
 * 本文件才是建表语句的唯一来源。两个入口：
 *   ensureSchema(db, caps)      幂等：CREATE ... IF NOT EXISTS（全新库 / sync:false 打开时）
 *   resetIndexTables(db, caps)  重建：DROP + CREATE（FTS / docs / keyword_stats）
 *
 * 刻意不包含 sync_meta（数据水位，重建时绝不能清）与 keyword_filter（用户配置，重建不清）。
 * FTS5 参数由 capabilities 决定：detail / columnsize 见 DEFAULT_FTS_CAPS，
 * contentless_delete 在引擎支持时开启。
 */
import { sql } from 'drizzle-orm';
import { allRows, execRaw, prepareStmt, transaction } from '../db-driver.js';
import { log } from '../logger.js';
import {
  FTS_TABLE,
  DOCS_TABLE,
  DOCS_COLUMN_DEFS,
  DOCS_INDEX_DEFS,
  DOCS_INFOHASH_INDEX,
  KEYWORD_TABLE,
  KEYWORD_RANK_INDEX,
  HOT_TABLE,
  HOT_COLUMN_DEFS,
  HOT_RANK_INDEX,
  KEYWORD_FILTER_TABLE,
  TOKENIZER,
} from '../store.js';

/**
 * 索引格式版本：写入 sync_meta.files_format，与库中值不一致即触发一次全量重建
 * （用于 FTS 索引文本形态、docs 列集合、FTS5 表参数等结构性变更的自动迁移）。
 */
export const INDEX_FORMAT = 'v4';

/** FTS5 建表参数默认值（detail / columnsize 保留 full + 1：降档会使 bm25 失效） */
export const DEFAULT_FTS_CAPS = Object.freeze({
  detail: 'full', // 'full' | 'column' | 'none'
  columnsize: true, // false → columnsize=0（不存每列 token 数）
  contentlessDelete: false, // true → contentless_delete=1（允许按 rowid 删除）
});

/**
 * 副本表（magnets_docs）建表 SQL 片段：由 store.js 的列清单派生，新建与重建共用。
 */
const DOCS_COLUMNS_DDL = `(\n    ${DOCS_COLUMN_DEFS.map(([name, decl]) => `${name} ${decl}`).join(',\n    ')}\n  )`;

/** 老库补列用的列清单：去掉主键列（ALTER TABLE 不能后加主键） */
const DOCS_ADDITIVE_COLUMNS = DOCS_COLUMN_DEFS.filter(([name]) => name !== 'id');

/** 热词统计表列定义 */
const KEYWORD_STATS_DDL = `(
    term TEXT PRIMARY KEY,
    doc_count INTEGER NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 0
  )`;

/** 由列定义拼建表语句 */
const ddlOf = (table, defs) =>
  `CREATE TABLE IF NOT EXISTS ${table} (\n    ${defs.map(([name, decl]) => `${name} ${decl}`).join(',\n    ')}\n  )`;

/** 热词候选表 keyword_hot 的建表语句 */
const HOT_DDL = ddlOf(HOT_TABLE, HOT_COLUMN_DEFS);

/** 给已存在的表补齐缺失列（老库平滑升级；新增列必须可空或带默认值） */
const ensureColumns = (db, table, columns) => {
  const raw = db.$client ?? db.session?.client;
  const existing = new Set(allRows(raw, `PRAGMA table_info(${table})`).map((r) => r.name));
  for (const [name, decl] of columns) {
    if (existing.has(name)) continue;
    execRaw(raw, `ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    log.warn(`索引库 ${table} 补列 ${name}（旧库升级，历史行的新列取默认值）`);
  }
};

/** 由能力快照生成 FTS5 建表参数串（跟在列名之后） */
export const ftsOptionSql = (caps = DEFAULT_FTS_CAPS) => {
  const parts = [`content=''`, `tokenize='${TOKENIZER}'`];
  if (caps.detail && caps.detail !== 'full') parts.push(`detail=${caps.detail}`);
  if (caps.columnsize === false) parts.push('columnsize=0');
  if (caps.contentlessDelete) parts.push('contentless_delete=1');
  return parts.join(', ');
};

/** FTS5 建表语句（完整 DDL 文本，便于日志与测试断言） */
const ftsDdl = (caps = DEFAULT_FTS_CAPS, { ifNotExists = false, table = FTS_TABLE } = {}) =>
  `CREATE VIRTUAL TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${table} USING fts5(
    name, files, ${ftsOptionSql(caps)}
  )`;

/** 表是否已存在（drizzle 在 Bun 下的裸 db.get() 返回行数组而非单行对象，故取 [0]） */
export const hasTable = (db, name) =>
  db.all(sql`SELECT 1 FROM sqlite_master WHERE name = ${name}`)[0] != null;

/**
 * 副本表的二级索引（幂等，缺失才建）。
 *
 * (col DESC, id DESC) 复合形式：索引条目自带次排序键，正向扫描即得到查询要的顺序，
 * 省掉一次反向扫描或额外排序；检索侧用 INDEXED BY 强制走它（见 search/api.js）。
 *
 * 这三个索引是「列排序快路径」的唯一保障：没有它们，planner 会退化成
 * 「取全部匹配 rowid → 逐个回表主键查找 → TEMP B-TREE 排序」，宽词时极慢。
 *
 * @param {object} db drizzle 可写连接
 */
export const ensureDocsIndexes = (db) => {
  for (const [col, indexName] of DOCS_INDEX_DEFS) {
    db.run(
      sql`CREATE INDEX IF NOT EXISTS ${sql.raw(indexName)}
          ON ${sql.raw(DOCS_TABLE)}(${sql.raw(col)} DESC, id DESC)`
    );
  }
  db.run(
    sql`CREATE INDEX IF NOT EXISTS ${sql.raw(DOCS_INFOHASH_INDEX)}
        ON ${sql.raw(DOCS_TABLE)}(lower(infohash))`
  );
};

/**
 * 热词榜的驱动索引（幂等，缺失才建）。
 *
 * 没有它时 /api/hot 的计划是：全表扫 keyword_stats（129 万行）+ 每行一次黑名单点查
 * + 129 万行的 TEMP B-TREE 排序，实测 445ms——而且是同步调用，直接阻塞主进程。
 *
 * 有了 (doc_count DESC, occurrences DESC)，planner 沿索引顺序扫描、边扫边用黑名单
 * 过滤，凑够 LIMIT 就停。黑名单占热词比例约 0.19%，取 1000 条只需扫约 1002 行，
 * 实测 445ms → 3ms；建索引本身约 530ms（一次性，在维护线程里付）。
 *
 * **必须在灌数据之后建**：populate 的热词写入是 upsert（doc_count 累加），
 * 带索引时每次更新都要删旧条目再插新条目，会明显拖慢写入。
 *
 * @param {object} db drizzle 可写连接
 */
export const ensureKeywordIndexes = (db) => {
  db.run(
    sql`CREATE INDEX IF NOT EXISTS ${sql.raw(KEYWORD_RANK_INDEX)}
        ON ${sql.raw(KEYWORD_TABLE)}(doc_count DESC, occurrences DESC)`
  );
};

/** 全部二级索引的幂等确保入口：调用方只需关心这一个 */
export const ensureIndexes = (db) => {
  ensureDocsIndexes(db);
  ensureKeywordIndexes(db);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS ${sql.raw(HOT_RANK_INDEX)}
        ON ${sql.raw(HOT_TABLE)}(doc_count DESC)`
  );
};

/**
 * 幂等确保 keyword_hot 表存在（内容由 rebuildHotTable 填充）。
 * 全新库 / 尚未生成过时这张表是空的，查询返回空而不是 no such table。
 */
export const ensureHotTable = (db) => {
  db.run(sql.raw(HOT_DDL));
};

/**
 * 重建热词候选表：从完整统计 keyword_stats 里筛出 doc_count ≥ 阈值的词。
 *
 * 筛选走 KEYWORD_RANK_INDEX 的范围扫描（只取前 N 行而不是全表 129 万行），
 * 因此一次重建约 130ms——增量同步后也能随手重建，无须攒到全量重建。
 *
 * DELETE + INSERT 在同一事务内：并发查询要么看到旧榜单、要么看到新榜单，
 * 不会看到「清空后未填充」的空窗。
 *
 * @param {object} db    可写 drizzle 连接
 * @param {number} minDocCount 收录阈值（doc_count ≥ 该值）
 * @returns {number} 收录的词的条数
 */
export const rebuildHotTable = (db, minDocCount) => {
  const raw = db.$client ?? db.session?.client;
  const threshold = Number.isFinite(Number(minDocCount)) && Number(minDocCount) >= 1
    ? Math.floor(Number(minDocCount))
    : 1;
  const rows = allRows(
    raw,
    `SELECT term, doc_count FROM ${KEYWORD_TABLE} WHERE doc_count >= ? ORDER BY doc_count DESC`,
    [threshold]
  );
  transaction(raw, () => {
    execRaw(raw, `DELETE FROM ${HOT_TABLE}`);
    const ins = prepareStmt(raw, `INSERT INTO ${HOT_TABLE} (term, doc_count) VALUES (?, ?)`);
    for (const r of rows) ins.run([r.term, r.doc_count]);
  })();
  return rows.length;
};

/**
 * 幂等建表：全新索引库 / sync:false 打开时使用，并给老库补齐缺失列
 * （格式迁移期间线上仍用旧库回答查询，缺列会直接报 "no such column"）。
 *
 * @param {object} db
 * @param {object} [caps]
 * @param {{ indexes?: boolean }} [opts] indexes=false 时跳过二级索引的幂等确保。
 *   用于「本次启动就要全量重建」的库：那种情况下建索引纯属白等（重建会重建），
 *   而它是在打开连接时同步执行的，会实打实阻塞启动。
 */
export const ensureSchema = (db, caps = DEFAULT_FTS_CAPS, { indexes = true } = {}) => {
  // 同步水位表（drizzle 不自动建表，由 raw DDL 维护）
  db.run(sql`CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  // 热词统计表（全量重建时会 DROP 重建，保证干净）
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KEYWORD_TABLE)} ${sql.raw(KEYWORD_STATS_DDL)}`);
  // 热词候选表：查询路径实际读的那张小表，内容由 rebuildHotTable 填充
  ensureHotTable(db);
  // 热词过滤表（用户配置；reindex 不清除）
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KEYWORD_FILTER_TABLE)} (
    term TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT 0
  )`);
  // 副本表 + FTS5 虚表：始终确保存在（空表），使 sync:false / worker 内打开的全新
  // 索引库也能被安全读取（返回空结果）与增量写入，而不会 no such table 崩溃
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(DOCS_TABLE)} ${sql.raw(DOCS_COLUMNS_DDL)}`);
  // 老库补列（历史行的新列取默认值，重建后即被真实数据覆盖）
  ensureColumns(db, DOCS_TABLE, DOCS_ADDITIVE_COLUMNS);
  db.run(sql.raw(ftsDdl(caps, { ifNotExists: true })));
  // 二级索引同样幂等确保：已有索引时只是目录探查，却能让「全新库 / 索引被删掉的旧库」
  // 一打开就具备列排序快路径与热词榜快路径，不必等下一次重建
  if (indexes) ensureIndexes(db);
};

/**
 * 重建用：清空并重建 FTS / docs / keyword_stats。
 * 调用方必须把它包在同一个事务里：DROP 与 CREATE 分处两个事务会让并发查询看到
 * 「表已 DROP、尚未 CREATE」的中间态（no such table）。
 */
export const resetIndexTables = (db, caps = DEFAULT_FTS_CAPS) => {
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(FTS_TABLE)}`);
  db.run(sql.raw(ftsDdl(caps)));
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(DOCS_TABLE)}`);
  db.run(sql`CREATE TABLE ${sql.raw(DOCS_TABLE)} ${sql.raw(DOCS_COLUMNS_DDL)}`);
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(KEYWORD_TABLE)}`);
  db.run(sql`CREATE TABLE ${sql.raw(KEYWORD_TABLE)} ${sql.raw(KEYWORD_STATS_DDL)}`);
};
