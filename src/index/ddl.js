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
import { allRows, execRaw } from '../db-driver.js';
import { log } from '../logger.js';
import {
  FTS_TABLE,
  DOCS_TABLE,
  DOCS_COLUMN_DEFS,
  KEYWORD_TABLE,
  KEYWORD_FILTER_TABLE,
  TOKENIZER,
} from '../store.js';

/**
 * 索引格式版本：写入 sync_meta.files_format，与库中值不一致即触发一次全量重建
 * （v2：FTS 索引文本改为纯路径、docs 增加 fileCount 列、FTS5 表参数纳入探测）。
 */
export const INDEX_FORMAT = 'v2';

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

/** 给已存在的表补齐缺失列（老库平滑升级；新增列必须可空或带默认值） */
function ensureColumns(db, table, columns) {
  const raw = db.$client ?? db.session?.client;
  const existing = new Set(allRows(raw, `PRAGMA table_info(${table})`).map((r) => r.name));
  for (const [name, decl] of columns) {
    if (existing.has(name)) continue;
    execRaw(raw, `ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    log.warn(`索引库 ${table} 补列 ${name}（旧库升级，历史行的新列取默认值）`);
  }
}

/** 由能力快照生成 FTS5 建表参数串（跟在列名之后） */
export function ftsOptionSql(caps = DEFAULT_FTS_CAPS) {
  const parts = [`content=''`, `tokenize='${TOKENIZER}'`];
  if (caps.detail && caps.detail !== 'full') parts.push(`detail=${caps.detail}`);
  if (caps.columnsize === false) parts.push('columnsize=0');
  if (caps.contentlessDelete) parts.push('contentless_delete=1');
  return parts.join(', ');
}

/** FTS5 建表语句（完整 DDL 文本，便于日志与测试断言） */
export function ftsDdl(caps = DEFAULT_FTS_CAPS, { ifNotExists = false, table = FTS_TABLE } = {}) {
  return `CREATE VIRTUAL TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${table} USING fts5(
    name, files, ${ftsOptionSql(caps)}
  )`;
}

/** 表是否已存在（drizzle 在 Bun 下的裸 db.get() 返回行数组而非单行对象，故取 [0]） */
export function hasTable(db, name) {
  return db.all(sql`SELECT 1 FROM sqlite_master WHERE name = ${name}`)[0] != null;
}

/**
 * 幂等建表：全新索引库 / sync:false 打开时使用，并给老库补齐缺失列
 * （格式迁移期间线上仍用旧库回答查询，缺列会直接报 "no such column"）。
 */
export function ensureSchema(db, caps = DEFAULT_FTS_CAPS) {
  // 同步水位表（drizzle 不自动建表，由 raw DDL 维护）
  db.run(sql`CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  // 热词统计表（全量重建时会 DROP 重建，保证干净）
  db.run(sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KEYWORD_TABLE)} ${sql.raw(KEYWORD_STATS_DDL)}`);
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
}

/**
 * 重建用：清空并重建 FTS / docs / keyword_stats。
 * 调用方必须把它包在同一个事务里：DROP 与 CREATE 分处两个事务会让并发查询看到
 * 「表已 DROP、尚未 CREATE」的中间态（no such table）。
 */
export function resetIndexTables(db, caps = DEFAULT_FTS_CAPS) {
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(FTS_TABLE)}`);
  db.run(sql.raw(ftsDdl(caps)));
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(DOCS_TABLE)}`);
  db.run(sql`CREATE TABLE ${sql.raw(DOCS_TABLE)} ${sql.raw(DOCS_COLUMNS_DDL)}`);
  db.run(sql`DROP TABLE IF EXISTS ${sql.raw(KEYWORD_TABLE)}`);
  db.run(sql`CREATE TABLE ${sql.raw(KEYWORD_TABLE)} ${sql.raw(KEYWORD_STATS_DDL)}`);
}
