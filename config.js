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
export const SOURCE_DB_PATH = 'G:/active_project/DHT/data/magnet.db';

/** 影子索引库路径：本服务维护的 FTS5 倒排索引 + 去规范化副本都在此库；相对路径基于项目根目录 */
export const INDEX_DB_PATH = 'data/dht.search.db';

/** HTTP 服务监听端口 */
export const PORT = 3000;

/** 单次「整集拉取」最多返回条数，超出则 truncated=true（0 表示不限制，上限由代码兜底为 20000） */
export const MAX_RESULTS = 20000;

/** reindex 全量重建的 V8 老生代堆上限（MB），仅 Node worker 生效；Bun 退化为同进程同步重建 */
export const REINDEX_MAX_OLD_SPACE_MB = 2048;

/** reindex 超时（毫秒），0 表示不限时；超时后 worker 会被终止，主进程不受影响 */
export const REINDEX_TIMEOUT_MS = 0;

/** 搜索结果内存缓存上限（MB），按序列化后的字节数估算总占用 */
export const SEARCH_CACHE_MAX_SIZE_MB = 256;

/** 单条搜索缓存的存活时间（毫秒）—— 1 小时 */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** 运行期自动增量同步间隔（毫秒）—— 1 小时；配 0 可关闭（关闭后仅启动时同步一次） */
export const SYNC_INTERVAL_MS = 60 * 60 * 1000;
