/**
 * 全局配置与共享约定（store）
 * ------------------------------------------------------------------
 * 集中存放跨模块共享的「配置 + 约定常量」，与 db.js 的查询实现解耦：
 *   - CONFIG              来自 config.json 的运行期配置（缺失/非法回退 {}）
 *   - 库路径约定         DEFAULT_DB_PATH / DEFAULT_INDEX_DB_PATH / resolveDbPath
 *   - 表名约定           TABLE / FTS_TABLE / DOCS_TABLE / KEYWORD_TABLE / KEYWORD_FILTER_TABLE
 *   - 索引与排序约定     TOKENIZER / DEFAULT_LIMIT / MAX_LIMIT / SORT_COLUMNS
 *
 * db.js 仅导入使用，不再各自 export；纯查询实现细节（ORDER_SQL /
 * SELECT_COLUMNS / TOKEN_PATTERN 等）仍留在 db.js。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 读取 config.json（不存在或非法时返回空对象，不阻塞启动） */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 来自 config.json 的运行期配置 */
export const CONFIG = loadConfig();

/** 把配置里的库路径解析为绝对路径：绝对路径原样使用，相对路径基于模块目录 */
export function resolveDbPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(MODULE_DIR, p);
}

/** 源库（其他应用写入）默认路径 */
export const DEFAULT_DB_PATH = path.join(MODULE_DIR, 'data', 'magnet.db');
/** 影子索引库默认路径 */
export const DEFAULT_INDEX_DB_PATH = path.join(MODULE_DIR, 'data', 'dht.search.db');

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
