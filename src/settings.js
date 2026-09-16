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
} = loaded;
