/**
 * 全局配置与共享约定（store）
 * ------------------------------------------------------------------
 * 集中存放跨模块共享的「配置 + 约定常量」，与 db.js 的查询实现解耦：
 *   - CONFIG              来自 config.js 的运行期配置（具名 export const 聚合）
 *   - 库路径约定         DEFAULT_DB_PATH / DEFAULT_INDEX_DB_PATH / resolveDbPath
 *   - 表名约定           TABLE / FTS_TABLE / DOCS_TABLE / KEYWORD_TABLE / KEYWORD_FILTER_TABLE
 *   - 索引与排序约定     TOKENIZER / DEFAULT_LIMIT / MAX_LIMIT / SORT_COLUMNS
 *
 * db.js 仅导入使用，不再各自 export；纯查询实现细节（ORDER_SQL /
 * SELECT_COLUMNS / TOKEN_PATTERN 等）仍留在 db.js。
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

/** FTS5 分词器（unicode61：大小写/变音折叠，去变音符） */
export const TOKENIZER = 'unicode61 remove_diacritics 2';

/** 检索默认每页条数 */
export const DEFAULT_LIMIT = 20;
/** 检索每页条数上限 */
export const MAX_LIMIT = 200;

/** 允许参与排序的列白名单（relevance 走 bm25，其余走副本表列） */
export const SORT_COLUMNS = Object.freeze(['fetchedAt', 'totalSize', 'relevance']);
