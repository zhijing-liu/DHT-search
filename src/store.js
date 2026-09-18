/**
 * 全局配置与共享约定（store）
 * ------------------------------------------------------------------
 * 集中存放跨模块共享的「配置 + 约定常量」，只放约定不放实现：
 *   - CONFIG           来自 config.js 的运行期配置（具名 export const 聚合）
 *   - 库路径 / 表名     DEFAULT_DB_PATH / DEFAULT_INDEX_DB_PATH / DEFAULT_FILES_DB_PATH，各表名
 *   - 列清单            DOCS_COLUMN_DEFS / RECORD_COLUMNS / DOCS_LIST_SELECT（唯一来源）
 *   - 索引与排序约定    TOKENIZER / DEFAULT_LIMIT / MAX_LIMIT / SORT_COLUMNS
 * 查询实现细节在 search/query.js，token 规则在 util.js，DDL 与老库补列在 index/ddl.js。
 *
 * 双库分工：
 *   热库（INDEX_DB_PATH）—— magnets_docs（窄表：只放检索/排序/筛选要用的列）+ magnets_fts
 *   冷库（FILES_DB_PATH）—— magnets_files（files 原文）+ magnets_preview（预览小列）
 *   拆分理由见 src/index/files-store.js 文件头；清单策略是「扫描路径绝不触碰大列」。
 */

import path from 'node:path';
import { isCompiledExe } from './db-driver.js';
import {
  SOURCE_DB_PATH,
  INDEX_DB_PATH,
  FILES_DB_PATH,
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
  MMAP_ENABLED,
  INDEX_MMAP_SIZE_MB,
  SEARCH_PROCESS_RECYCLE_IMMEDIATE,
  SEARCH_PROCESS_IDLE_MS,
  SEARCH_QUEUE_MAX,
  SEARCH_QUEUE_TIMEOUT_MS,
  FILES_COMPRESS_ENABLED,
  FILES_REWRITE_ON_REBUILD,
} from './settings.js';

const MODULE_DIR = import.meta.dirname;
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
  filesDbPath: FILES_DB_PATH,
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
  searchProcessMmapSizeMb: SEARCH_PROCESS_MMAP_SIZE_MB ?? INDEX_MMAP_SIZE_MB,
  indexMmapSizeMb: INDEX_MMAP_SIZE_MB,
  enableMmap: MMAP_ENABLED,
  searchProcessRecycleImmediate: SEARCH_PROCESS_RECYCLE_IMMEDIATE,
  searchProcessIdleMs: SEARCH_PROCESS_IDLE_MS,
  searchQueueMax: SEARCH_QUEUE_MAX,
  searchQueueTimeoutMs: SEARCH_QUEUE_TIMEOUT_MS,
  filesCompress: FILES_COMPRESS_ENABLED,
  filesRewriteOnRebuild: FILES_REWRITE_ON_REBUILD,
};

/** 把配置里的库路径解析为绝对路径：绝对路径原样使用，相对路径基于项目根目录 */
export const resolveDbPath = (p) => {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
};

/** 源库（其他应用写入）默认路径 */
export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'magnet.db');
/** 影子索引库（热库）默认路径 */
export const DEFAULT_INDEX_DB_PATH = path.join(ROOT_DIR, 'data', 'dht.search.db');
/** 冷库（大对象：files 原文 + 预览小列）默认路径 */
export const DEFAULT_FILES_DB_PATH = path.join(ROOT_DIR, 'data', 'dht.files.db');

/** 源库主表名 */
export const TABLE = 'magnets';
/** 热库中的 contentless FTS5 表名 */
export const FTS_TABLE = 'magnets_fts';
/** 热库中的副本表名（窄表：只放检索 / 排序 / 筛选要用的列） */
export const DOCS_TABLE = 'magnets_docs';

/** 冷库中的 files 原表（按 id 点查，列表路径从不访问） */
export const FILES_TABLE = 'magnets_files';
/** 冷库中的预览小列（列表按需按 id 批量回查，每次仅一页的条数） */
export const PREVIEW_TABLE = 'magnets_preview';

/** 热词统计表名（构建索引时随 populate 统计写入；保持全量，是唯一的统计真相源） */
export const KEYWORD_TABLE = 'keyword_stats';
/**
 * 热词候选表名：按 doc_count 阈值从 keyword_stats 筛出的小表（约 2.5 万行）。
 * 热词榜与联想都只查它——查询路径从此不碰 129 万行的大表。
 * 每次维护收尾重建（实测约 130ms），keyword_stats 完整所以随时可重建。
 */
export const HOT_TABLE = 'keyword_hot';
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
 * 副本表的列定义只有这一处，以下三处都由它派生：
 *   DOCS_COLUMN_DEFS ─┬→ index/ddl.js：建表 SQL + 老库补列语句
 *                     ├→ RECORD_COLUMNS：db.js 读源库的列 + 源表列校验
 *                     └→ DOCS_LIST_SELECT：search/api.js 的检索取列白名单
 *
 * **列顺序刻意「整型列在前、文本列在后」**：SQLite 按列顺序编码记录，读第 N 列要
 * 跳过前 N−1 个 serial type。把 totalSize / fetchedAt / fileCount 放最前，让
 * 「只取排序列」的扫描（count + 大小筛选、列排序回退形状）停在记录头部。
 *
 * **不含 files 与 preview 两个大列**：它们在冷库（见 FILES_TABLE / PREVIEW_TABLE）。
 * 窄表使随机主键回查从磁盘 IO 变成缓存命中。
 */
export const DOCS_COLUMN_DEFS = Object.freeze([
  ['id', 'INTEGER PRIMARY KEY'],
  ['totalSize', 'INTEGER NOT NULL DEFAULT 0'],
  ['fetchedAt', 'INTEGER NOT NULL DEFAULT 0'],
  ['fileCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['name', "TEXT NOT NULL DEFAULT ''"],
  ['infohash', 'TEXT'],
  ['magnet', 'TEXT'],
]);

/** 列名数组（顺序即 DDL 顺序） */
const DOCS_COLUMN_NAMES = Object.freeze(DOCS_COLUMN_DEFS.map(([name]) => name));

/**
 * 索引期派生列：源库没有这些列，由 index/transform.js 在索引时算出。
 *   fileCount → 落在副本表（列表要显示文件数，且是廉价整型列）
 *   preview   → 落在冷库（体积可达 GB 级，列表按页按需回查）
 */
const DERIVED_COLUMNS = Object.freeze(['fileCount', 'preview']);

/**
 * 源库（magnets）必需列 = 副本表列 − 派生列 + files。
 * files 不进副本表（改存冷库），但索引期必须读它来派生 ftsText / fileCount / preview。
 */
export const RECORD_COLUMNS = [
  ...DOCS_COLUMN_NAMES.filter((n) => !DERIVED_COLUMNS.includes(n)),
  'files',
].join(', ');

/**
 * 列表路径取列：副本表全列，带 `m.` 前缀（检索 SQL 的别名指向副本表）。
 * preview 不在其中——它由冷库按页回查后附着（见 search/api.js 的 attachPreviews）。
 */
export const DOCS_LIST_SELECT = DOCS_COLUMN_NAMES.map((name) => `m.${name}`).join(', ');

/* ------------------------------------------------------------------ */
/* 冷库表（magnets_files / magnets_preview）列清单                     */
/* ------------------------------------------------------------------ */

/** 冷库 files 表的存储格式：0 = 原始 UTF-8 文本，1 = zlib deflate */
export const FILES_FMT = Object.freeze({ raw: 0, zlib: 1 });

/**
 * 冷库 files 表列定义。
 * `srclen` 是源库 files 原文的字节长度，用作「内容是否变过」的廉价指纹：
 * 全量重建时靠它逐批比对，只重写真正变过的行，其余整批跳过——既保留了
 * 「重建不必重写几个 GB 大对象」的收益，又不会让源库的 UPDATE 静默失效。
 */
export const FILES_COLUMN_DEFS = Object.freeze([
  ['id', 'INTEGER PRIMARY KEY'],
  ['fmt', 'INTEGER NOT NULL DEFAULT 0'],
  ['srclen', 'INTEGER NOT NULL DEFAULT 0'],
  ['files', 'BLOB NOT NULL'],
]);

/** 冷库预览表列定义（preview 与 files 分表：详情读 files，列表只读 preview） */
export const PREVIEW_COLUMN_DEFS = Object.freeze([
  ['id', 'INTEGER PRIMARY KEY'],
  ['preview', 'TEXT NOT NULL'],
]);

/* ------------------------------------------------------------------ */
/* 二级索引（副本表）—— 排序 / 点查的驱动索引                          */
/* ------------------------------------------------------------------ */
/**
 * 复合 + 显式 DESC：索引条目本身就是 (col, id) 有序的，正向扫描即降序输出，
 * 省掉一次反向扫描或额外排序。检索侧用 INDEXED BY 强制走它（见 search/api.js）。
 */
export const DOCS_INDEX_DEFS = Object.freeze([
  ['totalSize', 'idx_magnets_docs_totalSize'],
  ['fetchedAt', 'idx_magnets_docs_fetchedAt'],
]);

/** infohash 表达式索引名（lower(infohash)：hash 检索点查 + 前缀 LIKE） */
export const DOCS_INFOHASH_INDEX = 'idx_magnets_docs_infohash_lower';

/**
 * keyword_stats 的热度索引：(doc_count DESC, occurrences DESC)。
 * 现在只服务「生成 keyword_hot」这一步——沿它做范围扫描，只取前 2.5 万行，
 * 因此每次重建 keyword_hot 只要约 130ms。查询路径不再直接读 keyword_stats。
 */
export const KEYWORD_RANK_INDEX = 'idx_keyword_stats_rank';

/** keyword_hot 的热度索引：热词榜（/api/hot）沿它取 top N */
export const HOT_RANK_INDEX = 'idx_keyword_hot_rank';

/** keyword_hot 列定义 */
export const HOT_COLUMN_DEFS = Object.freeze([
  ['term', 'TEXT PRIMARY KEY'],
  ['doc_count', 'INTEGER NOT NULL DEFAULT 0'],
]);

/**
 * 前缀查询的上界后缀：U+10FFFF 是 Unicode 最大码位，任何字符都小于它，
 * 故 `term >= q AND term < q || SUFFIX` 精确等价于「以 q 开头」。
 */
export const TERM_PREFIX_MAX = '\u{10FFFF}';

/** 联想候选的默认条数与上限 */
export const SUGGEST_DEFAULT_LIMIT = 10;
export const SUGGEST_MAX_LIMIT = 50;

/**
 * 下发到前端的整份热词表的**防御性硬上限**。
 *
 * 实际收录范围由 settings 的 HOT_MIN_DOC_COUNT 决定（默认 ≥50，实测约 2.6 万词），
 * 上限只用于兜底「阈值被配得过低」的情况，避免把整张 129 万行的表吐给前端。
 *
 * 联想完全在前端做（零延迟 + 可做中文分词 / 多词权重），所以词表要一次性下发；
 * 顺序即热度排名，故只传 term 不传计数。
 * 实测：2.6 万条 → 纯文本 208KB，gzip 后约 110KB（一次性，之后不再请求）。
 */
export const HOT_WORDS_MAX = 100000;

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
