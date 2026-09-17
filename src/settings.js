/**
 * 统一配置加载层（config.js 的运行时入口）
 * ------------------------------------------------------------------
 * 服务代码一律从本模块导入配置，不要直接 import config.js（直接 import 会被 bun 打包
 * 内联进 exe，导致「打包后改配置不生效」）：
 *   - 源码运行：加载项目根的 config.js；
 *   - 编译运行：优先加载 exe 同目录的 config.js（不存在则回退内置副本，保证单个 exe 可裸跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCompiledExe } from './db-driver.js';

let loaded = null;
if (isCompiledExe) {
  const externalPath = path.join(path.dirname(process.execPath), 'config.js');
  if (fs.existsSync(externalPath)) {
    try {
      loaded = await import(pathToFileURL(externalPath).href);
      console.log(`[settings] 已加载外置配置: ${externalPath}`);
    } catch (err) {
      console.warn(`[settings] 外置配置加载失败，回退内置默认: ${err?.message ?? err}`);
    }
  }
}
if (!loaded) loaded = await import('../config.js');

export const {
  SOURCE_DB_PATH,
  INDEX_DB_PATH,
  FILES_DB_PATH,
  PORT,
  WEB_BASE_PATH,
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
  ACCESS_CONTROL_MODE,
  ALLOWED_CLIENTS,
  TRUST_PROXY,
  ENABLE_MMAP,
  FILES_COMPRESS,
  FILES_REWRITE_ON_REBUILD: FILES_REWRITE_ON_REBUILD_RAW,
} = loaded;

/** mmap 总开关：默认开启（仅显式 false 才关闭），避免缺失配置时静默关掉加速 */
export const MMAP_ENABLED = ENABLE_MMAP !== false;

/**
 * 冷库 files 是否压缩存储（zlib level 1）。
 * 路径文本重复度高，实测 5× 左右压缩率；只在详情接口付一次解压开销，
 * 列表路径完全不受影响。默认开启（仅显式 false 才关闭）。
 */
export const FILES_COMPRESS_ENABLED = FILES_COMPRESS !== false;

/**
 * 全量重建时是否重写冷库已有行。
 * 默认 false = 只追加缺失 id（files 按 id 不可变，重建不必重写 8GB 大对象，
 * 这是拆分冷库最大的重建收益）。源库会 UPDATE 既有行时改 true，代价是每次重建全量重写。
 */
export const FILES_REWRITE_ON_REBUILD = FILES_REWRITE_ON_REBUILD_RAW === true;

/**
 * 索引库读连接 mmap 窗口（MB）：统一控制主进程只读连接与搜索子进程。
 * 未设置新项时回退旧配置 SEARCH_PROCESS_MMAP_SIZE_MB；再缺失则用 256 兜底。
 */
export const INDEX_MMAP_SIZE_MB = (() => {
  const v = loaded.INDEX_MMAP_SIZE_MB ?? loaded.SEARCH_PROCESS_MMAP_SIZE_MB;
  return Number.isFinite(Number(v)) ? Number(v) : 256;
})();
