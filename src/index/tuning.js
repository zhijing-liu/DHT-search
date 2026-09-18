/**
 * 索引流水线调优参数（批大小 / 重建期 PRAGMA / 排序线程）
 * ------------------------------------------------------------------
 * 读批与写批分开设：读批（SCAN_BATCH）决定源库侧一次物化多少行，只影响内存峰值；
 * 写批（WRITE_BATCH_*）决定一个事务提交多少行，影响提交次数与写侧内存。
 *
 * 各项均支持环境变量临时覆盖（仅压测调参用，基准见 test/bench-index.mjs）。
 */
import os from 'node:os';

/** 正整数环境变量覆盖；非法或 <= 0 时回退默认值 */
const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/** 非负整数环境变量覆盖（0 有意义，例如「关闭多线程排序」） */
const envCount = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
};

/** 源库扫描批大小（一次 allRows 取多少行）；只影响源库侧一次物化的行数与内存峰值 */
export const SCAN_BATCH = envInt('DHT_SCAN_BATCH', 10000);

/**
 * 写事务的行数上限。整批脏页应落在重建期页缓存内（超出会外溢，同时抬高耗时与内存峰值）；
 * 与下面的字节上限先到先生效。
 */
export const WRITE_BATCH_ROWS = envInt('DHT_WRITE_BATCH_ROWS', 5000);

/**
 * 写事务的字节上限（按源 files 文本长度估算），与行数上限先到先生效。
 * 取值需与 RESET_CACHE_KB 配套（默认 24MB < 32MB）；对中文会低估约一倍，偏安全。
 */
export const WRITE_BATCH_BYTES = envInt('DHT_WRITE_BATCH_BYTES', 24 * 1024 * 1024);

/** 重建期临时页存放位置（SQLite `temp_store`）：MEMORY = 留在内存（默认），FILE = 交给磁盘 */
export const RESET_TEMP_STORE = process.env.DHT_RESET_TEMP_STORE === 'FILE' ? 'FILE' : 'MEMORY';

/** 重建期页缓存大小（KB，对应 `PRAGMA cache_size = -N`）；与 WRITE_BATCH_BYTES 配套 */
export const RESET_CACHE_KB = envInt('DHT_RESET_CACHE_KB', 32000);

/** 排序辅助线程数（`PRAGMA threads`，0 = 关闭）；引擎未支持该特性时调用方会跳过设置 */
export const INDEX_THREADS = envCount(
  'DHT_INDEX_THREADS',
  Math.min(4, Math.floor((os.availableParallelism?.() ?? 2) / 2))
);
