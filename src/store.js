/**
 * 全局配置与共享约定（store）
 * ------------------------------------------------------------------
 * 集中存放跨模块共享的「配置 + 约定常量」，只放约定不放实现：
 *   - CONFIG           来自 config.js 的运行期配置（具名 export const 聚合）
 *   - 库路径 / 表名     DEFAULT_DB_PATH / DEFAULT_INDEX_DB_PATH / resolveDbPath，各表名
 *   - 列清单            DOCS_COLUMN_DEFS / RECORD_COLUMNS / DOCS_SELECT_COLUMNS（唯一来源）
 *   - 索引与排序约定    TOKENIZER / DEFAULT_LIMIT / MAX_LIMIT / SORT_COLUMNS
 * 查询实现细节在 search/query.js，token 规则在 util.js，DDL 与老库补列在 index/ddl.js。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCompiledExe } from './db-driver.js';
import {
  SOURCE_DB_PATH,
  INDEX_DB_PATH,
  PORT,
  MAX_RESULTS,
  REINDEX_MAX_OLD_SPACE_MB,
  SOURCE_READ_MMAP_MB,
  SYNC_CRON,
  SYNC_ON_START,
  SEARCH_CACHE_MAX_SIZE_MB,
  SEARCH_CACHE_TTL_MS,
  SEARCH_MAX_PROCESSES,
  SEARCH_PROCESS_CACHE_SIZE_KB,
  SEARCH_PROCESS_MMAP_SIZE_MB,
  SEARCH_PROCESS_RECYCLE_IMMEDIATE,
  SEARCH_PROCESS_IDLE_MS,
  SEARCH_QUEUE_MAX,
  SEARCH_QUEUE_TIMEOUT_MS,
} from './settings.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * 根基准目录：相对路径（config.js 的 data/… 路径项）都以它为基。
 * 源码态是仓库根；编译产物（bun --compile）内 import.meta.url 指向虚拟文件系统，
 * 改用 exe 同目录 —— 部署时把 config.js / public/ / data/ 放在 exe 旁边即可。
 */
const ROOT_DIR = isCompiledExe ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');

/**
 * 来自 config.js 的运行期配置。
 * 这里把 config.js 里「独立 export const 变量」重新聚合成 CONFIG.xxx 形式，
 * 仅为向上兼容 db.js / index.js 既有的 CONFIG.xxx 访问方式；
 * 新代码建议直接 `import { PORT } from './settings.js'` 引用具名常量。
 */
export const CONFIG = {
  sourceDbPath: SOURCE_DB_PATH,
  indexDbPath: INDEX_DB_PATH,
  port: PORT,
  maxResults: MAX_RESULTS,
  reindexMaxOldSpaceMb: REINDEX_MAX_OLD_SPACE_MB,
  sourceReadMmapMb: SOURCE_READ_MMAP_MB,
  syncCron: SYNC_CRON,
  syncOnStart: SYNC_ON_START,
  searchCacheMaxSizeMb: SEARCH_CACHE_MAX_SIZE_MB,
  searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
  searchMaxProcesses: SEARCH_MAX_PROCESSES,
  searchProcessCacheSizeKb: SEARCH_PROCESS_CACHE_SIZE_KB,
  searchProcessMmapSizeMb: SEARCH_PROCESS_MMAP_SIZE_MB,
  searchProcessRecycleImmediate: SEARCH_PROCESS_RECYCLE_IMMEDIATE,
  searchProcessIdleMs: SEARCH_PROCESS_IDLE_MS,
  searchQueueMax: SEARCH_QUEUE_MAX,
  searchQueueTimeoutMs: SEARCH_QUEUE_TIMEOUT_MS,
};

/** 把配置里的库路径解析为绝对路径：绝对路径原样使用，相对路径基于项目根目录 */
export function resolveDbPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

/** 源库（其他应用写入）默认路径 */
export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'magnet.db');
/** 影子索引库默认路径 */
export const DEFAULT_INDEX_DB_PATH = path.join(ROOT_DIR, 'data', 'dht.search.db');

/** 源库主表名 */
export const TABLE = 'magnets';
/** 影子索引库中的 contentless FTS5 表名 */
export const FTS_TABLE = 'magnets_fts';
/** 影子索引库中的去规范化副本表名（展示/排序用） */
export const DOCS_TABLE = 'magnets_docs';

/** 热词统计表名（构建索引时随 populate 统计写入） */
export const KEYWORD_TABLE = 'keyword_stats';
/** 热词过滤表名（用户配置的噪声词；reindex 不清除） */
export const KEYWORD_FILTER_TABLE = 'keyword_filter';

/** 索引状态表名（同步水位 / 格式版本 / 维护状态），key/value 结构 */
export const STATE_TABLE = 'sync_meta';

/* ------------------------------------------------------------------ */
/* 副本表（magnets_docs）列清单 —— 全站唯一来源                        */
/* ------------------------------------------------------------------ */
/**
 * 每项为 [列名, 类型与约束]。`id` 是主键、建表时必在，不参与老库补列。
 *
 * 副本表的列定义只有这一处，以下四处都由它派生：
 *   DOCS_COLUMN_DEFS ─┬→ index/ddl.js：建表 SQL + 老库补列语句
 *                     ├→ RECORD_COLUMNS：db.js 读源库的列 + 源表列校验
 *                     └→ DOCS_SELECT_COLUMNS：search/api.js 的检索取列白名单
 */
export const DOCS_COLUMN_DEFS = Object.freeze([
  ['id', 'INTEGER PRIMARY KEY'],
  ['name', "TEXT NOT NULL DEFAULT ''"],
  ['infohash', 'TEXT'],
  ['magnet', 'TEXT'],
  ['files', 'TEXT'],
  ['fileCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['totalSize', 'INTEGER NOT NULL DEFAULT 0'],
  ['fetchedAt', 'INTEGER NOT NULL DEFAULT 0'],
]);

/** 列名数组（顺序即 DDL 顺序） */
export const DOCS_COLUMN_NAMES = Object.freeze(DOCS_COLUMN_DEFS.map(([name]) => name));

/** 索引期派生列：源库没有这些列，由 index/transform.js 在索引时算出 */
const DERIVED_COLUMNS = Object.freeze(['fileCount']);

/** 源库（magnets）必需列 = 副本表列清单 − 派生列；读源库的 SELECT 与源表列校验共用 */
export const RECORD_COLUMNS = DOCS_COLUMN_NAMES.filter((n) => !DERIVED_COLUMNS.includes(n)).join(', ');

/**
 * 带 `m.` 前缀的列清单：检索 JOIN 的取列白名单（别名 m 指向副本表）。
 * 含 `files` 是因为服务端要据此挑预览，响应体里会丢掉它、只下发 `preview`。
 */
export const DOCS_SELECT_COLUMNS = DOCS_COLUMN_NAMES.map((name) => `m.${name}`).join(', ');

/**
 * 索引状态表的键。按写入时机分三类，混用会破坏失败恢复：
 *   dataWatermark            每批与数据同事务推进（断点续跑的起点）
 *   tokenizer / filesFormat  只在重建成功收尾才写（中途失败留在旧值即触发重跑）
 *   buildMode / ftsPending   维护过程状态（中断识别、FTS 合并节流）
 */
export const STATE_KEYS = Object.freeze({
  dataWatermark: 'last_rowid',
  tokenizer: 'tokenizer',
  filesFormat: 'files_format',
  buildMode: 'build_mode',
  ftsPending: 'fts_pending',
});

/** 维护状态取值（STATE_KEYS.buildMode） */
export const BUILD_MODES = Object.freeze({ idle: 'idle', full: 'full', incremental: 'incremental' });

/** FTS5 分词器（unicode61：大小写/变音折叠，去变音符） */
export const TOKENIZER = 'unicode61 remove_diacritics 2';

/** 检索默认每页条数 */
export const DEFAULT_LIMIT = 20;
/** 检索每页条数上限 */
export const MAX_LIMIT = 200;

/** 允许参与排序的列白名单（relevance 走 bm25，其余走副本表列） */
export const SORT_COLUMNS = Object.freeze(['fetchedAt', 'totalSize', 'relevance']);
