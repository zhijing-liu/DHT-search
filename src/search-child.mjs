/**
 * 搜索子进程：在独立进程内执行检索，主线程在客户端断开时 SIGKILL 掉本进程，
 * 即可中断其正在执行的同步 SQLite 查询。
 *
 * 为什么必须是「进程」而不是「线程」
 * ------------------------------------------------------------------
 * better-sqlite3 / bun:sqlite 都是同步 API，一条查询会把整个执行单元阻塞在 C++
 * 里。worker.terminate() 走的是 V8 的 Isolate::TerminateExecution —— 终止标志要等
 * 执行权回到 JS 才被检查，卡在原生调用里的查询根本收不到信号。实测：
 *   - Node + better-sqlite3：terminate() 到 worker 真正退出 = 23328ms（＝查询跑完）
 *   - Bun + bun:sqlite     ：6s 后 worker 仍存活
 * 两个运行时都无法中断。唯一能打断同步原生调用的是操作系统级 kill，实测
 * kill(SIGKILL) -> exit 在两个运行时均为 6ms。
 *
 * 本进程以只读方式打开索引库（query_only=ON），被 SIGKILL 不会造成任何数据损坏。
 *
 * 与主进程共用同一套检索实现（buildSearchApi），Bun / Node 下逻辑一致。
 */
import { openDatabase, createDrizzle, setPragma } from './db-driver.js';
import { CONFIG, resolveDbPath, DEFAULT_INDEX_DB_PATH } from './store.js';
import { buildSearchApi } from './db.js';

const indexPath = resolveDbPath(
  // 优先用主进程经环境变量传来的实际索引路径（见 searchPool.js），
  // 否则与主进程一致：取 config.js 的 indexDbPath（CONFIG 恒非空，env 兜底永不生效）
  process.env.DHT_SEARCH_INDEX_DB_PATH ?? CONFIG.indexDbPath ?? DEFAULT_INDEX_DB_PATH
);

/**
 * 本进程的内存配额（来自 config.js，缺省值与其保持一致）：
 *   - cacheSizeKb：SQLite page cache，是**每个进程一份**的私有内存；
 *   - mmapSizeMb ：mmap 窗口，映射共享 clean page，多进程读同一库不重复占用，
 *                  且可被 OS 回收，故同样的预算给 mmap 比给 page cache 划算。
 * 检索是分页的（单次 ≤ MAX_LIMIT 条），工作集很小，默认「小 cache + 中等 mmap」。
 */
const CACHE_SIZE_KB =
  Number(CONFIG.searchProcessCacheSizeKb) > 0 ? Math.trunc(Number(CONFIG.searchProcessCacheSizeKb)) : 2048;
const MMAP_SIZE_MB =
  Number(CONFIG.searchProcessMmapSizeMb) >= 0 ? Math.trunc(Number(CONFIG.searchProcessMmapSizeMb)) : 32;

// 只读连接：与主进程查询连接同构；query_only 杜绝误写，busy_timeout 等待重建写锁
const rdb = openDatabase(indexPath, { readonly: true });
setPragma(rdb, 'query_only', 'ON');
setPragma(rdb, 'busy_timeout', 5000);
// SQLite 的 cache_size 负数值单位才是 KiB，故这里取负
setPragma(rdb, 'cache_size', -CACHE_SIZE_KB);
setPragma(rdb, 'mmap_size', MMAP_SIZE_MB * 1024 * 1024);
// 排序临时数据放内存：宽泛词 + 非 id 排序（totalSize/fetchedAt/bm25）时匹配量可达
// 数十万，落磁盘排序慢数倍（实测 20.8 万匹配 6681ms→836ms）。排序只存排序键+rowid，
// 数十万行仅几 MB，内存安全。
setPragma(rdb, 'temp_store', 'MEMORY');
const dbRO = createDrizzle(rdb);

const { searchMagnetsSync } = buildSearchApi(dbRO);

process.on('message', (msg) => {
  const { id, params } = msg;
  try {
    const result = searchMagnetsSync(params);
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
