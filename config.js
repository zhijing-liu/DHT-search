/**
 * 运行期配置（ESM 模块，可直接写注释）
 * ------------------------------------------------------------------
 * 与旧版 config.json 的区别：
 *   - 用 JS 模块代替 JSON，因此能写 // 与 /* *\/ 注释；
 *   - 每个配置项都是独立的 `export const`，便于按需 import 且语义清晰；
 *   - 时间类常量写成 `60 * 60 * 1000` 这类可读表达式，一眼能看出是「1 小时」。
 *
 * 取值优先级（在 db.js 中生效）：
 *   显式参数 > 本文件 > 环境变量（DHT_DB_PATH / DHT_INDEX_DB_PATH）> 模块内默认值。
 *
 * 注意：本文件是「真实生效」的配置。修改后无需重启构建步骤，重启服务即可生效。
 */

/** SQLite 源库路径：由其他采集程序写入的 magnet.db，构建索引时以只读方式打开 */
export const SOURCE_DB_PATH = 'data/magnet.db';

/** 影子索引库路径：本服务维护的 FTS5 倒排索引 + 去规范化副本都在此库；相对路径基于项目根目录 */
export const INDEX_DB_PATH = 'data/dht.search.db';

/** HTTP 服务监听端口 */
export const PORT = 3000;

/**
 * 单次「整集拉取」（limit=all）最多返回条数，超出则 truncated=true
 * （0 表示不限制，上限由代码兜底为 20000）。
 * 注意：分页路径由 db.js 的 MAX_LIMIT（200）约束，与本项无关。
 */
export const MAX_RESULTS = 2000;

/** reindex 全量重建的 V8 老生代堆上限（MB），仅 Node worker 生效；Bun 退化为同进程同步重建 */
export const REINDEX_MAX_OLD_SPACE_MB = 2048;

/** reindex 超时（毫秒），0 表示不限时；超时后 worker 会被终止，主进程不受影响 */
export const REINDEX_TIMEOUT_MS = 0;

/**
 * 搜索结果内存缓存上限（MB）。
 * 缓存存的是序列化后的 JSON 字符串（而非对象），故该值 ≈ 实际堆占用，
 * 不必再按「对象堆占用是 JSON 字节数 3~5 倍」去放大预留。
 */
export const SEARCH_CACHE_MAX_SIZE_MB = 32;

/** 单条搜索缓存的存活时间（毫秒）—— 1 小时 */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** 运行期自动增量同步间隔（毫秒）—— 1 小时；配 0 可关闭（关闭后仅启动时同步一次） */
export const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 最大并发搜索进程数。
 * 进程是「按需 fork」的：服务启动时常驻 0 个，有查询才启动，
 * 客户端断开或空闲超时后回收，空闲足够久则回到 0。
 * 低并发场景 1~2 即可；调大只影响并发能力，不影响空闲时的内存。
 */
export const SEARCH_MAX_PROCESSES = 2;

/**
 * 每个搜索子进程的 SQLite page cache 上限（KiB）。
 * 注意：这是**每个进程一份**的私有内存，总额 = 本值 × SEARCH_MAX_PROCESSES。
 * 检索是分页的（单次 ≤ 200 条），工作集很小，默认 2MB 足够；
 * 只有整集拉取（limit=all）才可能受益于更大的值。
 */
export const SEARCH_PROCESS_CACHE_SIZE_KB = 2048;

/**
 * 每个搜索子进程的 SQLite mmap 上限（MB）；配 0 表示关闭 mmap。
 * 与 page cache 不同，mmap 映射的是**共享 clean page**：多个进程读同一个索引库
 * 不会重复占用一份，且内存紧张时可由 OS 直接回收（不计入进程私有内存）。
 * 因此同样的内存预算，给 mmap 比给 page cache 划算。
 */
export const SEARCH_PROCESS_MMAP_SIZE_MB = 32;

/**
 * 搜索进程是否「立即回收」：查询一完成就 SIGKILL 掉该进程。
 * - `true` ：空闲时进程数恒为 0，内存最省；代价是**每次查询都要付一次 fork
 *            冷启动**（Windows 实测约 1 秒），连续翻页 / 改关键词时体感明显。
 * - `false`：进程保留一段时间供后续查询复用，只有空闲超过 SEARCH_PROCESS_IDLE_MS
 *            才回收 —— 即**只有此时 SEARCH_PROCESS_IDLE_MS 才生效**。
 *            连续操作期间复用热进程，真正空闲后内存同样回到 0。
 */
export const SEARCH_PROCESS_RECYCLE_IMMEDIATE = false;

/**
 * 搜索进程空闲多久后被回收（毫秒）—— 空闲足够久后进程数回到 0；配 0 表示不回收。
 * 注意：**仅在 SEARCH_PROCESS_RECYCLE_IMMEDIATE = false 时生效**；
 * 立即回收模式下进程用完即杀，不存在「空闲进程」，本项被忽略。
 */
export const SEARCH_PROCESS_IDLE_MS = 60 * 1000;

/** 搜索等待队列上限：所有进程忙碌时新查询排队，超出则快速失败（防无界堆积） */
export const SEARCH_QUEUE_MAX = 16;

/** 排队超时（毫秒），超时后快速失败；0 表示不限时 */
export const SEARCH_QUEUE_TIMEOUT_MS = 10 * 1000;
