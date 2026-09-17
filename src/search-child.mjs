/**
 * 搜索子进程：在独立进程内执行检索，主进程在客户端断开时 SIGKILL 本进程，即可中断其
 * 正在执行的同步 SQLite 查询（worker 线程的 terminate() 拦不住卡在原生调用里的查询）。
 *
 * 以只读方式打开索引库（query_only=ON），被 SIGKILL 不会造成数据损坏；
 * 与主进程共用同一套检索实现（buildSearchApi）。
 * 派生方式与命令行标记守卫见 src/child-process.js 与 worker-flags.js；被普通 import
 * 时 main() 不执行。
 */
import { openDatabase, createDrizzle, setPragma } from './db-driver.js';
import { CONFIG, resolveDbPath, DEFAULT_INDEX_DB_PATH, DEFAULT_FILES_DB_PATH } from './store.js';
import { buildSearchApi } from './db.js';
import { openFilesDb } from './index/files-store.js';
import { SEARCH_WORKER_FLAG } from './worker-flags.js';

function main() {
  const indexPath = resolveDbPath(
    // 优先用主进程经环境变量传来的实际索引路径（见 searchPool.js），
    // 否则与主进程一致：取 config.js 的 indexDbPath（CONFIG 恒非空，env 兜底永不生效）
    process.env.DHT_SEARCH_INDEX_DB_PATH ?? CONFIG.indexDbPath ?? DEFAULT_INDEX_DB_PATH
  );
  const filesPath = resolveDbPath(
    process.env.DHT_SEARCH_FILES_DB_PATH ?? CONFIG.filesDbPath ?? DEFAULT_FILES_DB_PATH
  );

  /**
   * 本进程的 SQLite 内存配额（来自 config.js，缺省值与其保持一致）：
   * cacheSizeKb 是每进程一份的私有内存，mmapSizeMb 映射的是可回收的共享页。
   */
  const CACHE_SIZE_KB =
    Number(CONFIG.searchProcessCacheSizeKb) > 0 ? Math.trunc(Number(CONFIG.searchProcessCacheSizeKb)) : 2048;
  // mmap 窗口：统一由 INDEX_MMAP_SIZE_MB 控制（ENABLE_MMAP=false 或 0 时关闭）
  const MMAP_SIZE_MB =
    CONFIG.enableMmap !== false ? (Number(CONFIG.indexMmapSizeMb) > 0 ? Math.trunc(Number(CONFIG.indexMmapSizeMb)) : 256) : 0;

  // 只读连接：与主进程查询连接同构；query_only 杜绝误写，busy_timeout 等待重建写锁
  const rdb = openDatabase(indexPath, { readonly: true });
  setPragma(rdb, 'query_only', 'ON');
  setPragma(rdb, 'busy_timeout', 5000);
  // SQLite 的 cache_size 负数值单位才是 KiB，故这里取负
  setPragma(rdb, 'cache_size', -CACHE_SIZE_KB);
  setPragma(rdb, 'mmap_size', MMAP_SIZE_MB * 1024 * 1024);
  // 排序临时数据放内存（宽泛词非 id 排序时匹配量可达数十万，落盘慢数倍；数据仅排序键+rowid）
  setPragma(rdb, 'temp_store', 'MEMORY');
  const dbRO = createDrizzle(rdb);

  // 冷库：只按 id 取本页的预览（几十行点查），因此给它极小的页缓存配额，
  // 热库的缓存预算不被挤占。只读打开（连接层已禁写，无需 query_only 之外的保护）；
  // 打开失败（冷库尚未生成）时降级为 null —— 检索照常工作，只是预览为空。
  let filesRO = null;
  try {
    filesRO = openFilesDb(filesPath, { readonly: true, cacheSizeKb: 512 }).db;
  } catch (err) {
    console.warn(`[search-child] 冷库不可用，本进程预览将为空: ${err?.message ?? err}`);
  }

  const { searchMagnetsSync, listLatestSync } = buildSearchApi(dbRO, filesRO);

  process.on('message', (msg) => {
    const { id, params } = msg;
    try {
      // params.mode 是任务类型开关：'latest' = 最新入库列表，其余 = 关键词检索
      const result = params?.mode === 'latest' ? listLatestSync(params) : searchMagnetsSync(params);
      process.send({ id, type: 'result', result });
    } catch (e) {
      process.send({
        id,
        type: 'error',
        error: e?.message || 'search failed',
        code: e?.code,
      });
    }
  });
}

// 只有被显式标记为搜索子进程时才执行（fork / exe 自拉起都带此标记）
if (process.argv.includes(SEARCH_WORKER_FLAG)) main();
