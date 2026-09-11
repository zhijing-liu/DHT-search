/**
 * 统一配置加载层（config.js 的运行时入口）
 * ------------------------------------------------------------------
 * 服务代码一律从本模块导入配置，不要直接 import config.js：
 *   - 源码运行（node/bun 直接跑 index.js / 测试脚本）：加载项目根的 config.js；
 *   - 编译运行（bun build --compile 产物）：优先加载 **exe 同目录**的 config.js ——
 *     发布后改端口 / 库路径 / 白名单等只需编辑该文本文件，重启 exe 即生效，无需重新打包。
 *
 * 为什么必须经此中转：config.js 被几十处静态 import，bun 打包会把静态 import 一并
 * 内联进 exe，导致「打包后改 config.js 不生效」。本模块在编译态改用「运行时动态
 * import 一个变量路径」，打包器无法内联，外置文件才能真正留到运行时读取。
 *
 * exe 同目录的 config.js 不存在时回退到内置默认（bundle 内的 config.js 副本），
 * 保证单个 exe 也能裸跑；构建脚本会把带完整注释的 config.js 复制到 exe 旁作为模板。
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
