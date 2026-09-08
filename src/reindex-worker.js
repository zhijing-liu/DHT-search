/**
 * 索引维护执行体（worker 线程 / 子进程双模式通用）
 * ------------------------------------------------------------------
 * 由 db.js 的 runIndex() 派生，在独立的执行单元（线程或进程）里打开影子索引库
 * 并执行索引维护。mode 决定「清不清空」：
 *   - 'incremental'：只补录源库新增行（不清空）
 *   - 'full'：清空重建（DROP/CREATE 后全量灌入）
 *
 * 启动方式（进度/结果经统一的消息协议回传，父进程侧无感知差异）：
 *   1. worker 线程（Node 主路径）：new Worker() 派生，参数经 workerData 传入，
 *      回传经 parentPort.postMessage；派生即执行；
 *   2. 子进程（Bun 主路径）：Bun 对 node:worker_threads 覆盖不全（resourceLimits
 *      不生效、terminate() 无法中断卡在原生调用里的同步语句），用 child_process
 *      拉起本执行体，参数经环境变量 DHT_REINDEX_JOB（JSON）传入，回传经
 *      process.send。源码态是 fork 本文件；编译态（bun build --compile）磁盘上
 *      没有本文件，父进程 spawn exe 自身并带 INDEX_WORKER_FLAG 参数自拉起。
 *
 * 是否执行由「worker 线程 或 命令行含 INDEX_WORKER_FLAG」守卫，
 * 被普通 import（如 exe 打包入口静态引入）时无副作用。
 *
 * 之所以不能放在主进程里同步执行：
 *   - 重建 / 大批量同步是一连串同步的 SQLite 原生调用（bun:sqlite / better-sqlite3
 *     均为同步 API），放在主进程会把事件循环整个卡死在 C++ 里——重建/同步期间
 *     页面与检索全部无响应；
 *   - 重建的堆占用与源库规模正相关，独立线程/进程触顶只影响自身，主进程不受波及。
 *
 * 消息协议：
 *   → 父级  { type: 'progress', done, total }
 *   → 父级  { ok: true, indexed }                       （full 模式）
 *   → 父级  { ok: true, result: { skipped, added } }    （incremental 模式）
 *   → 父级  { ok: false, error }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createMagnetDb } from './db.js';
import { INDEX_WORKER_FLAG } from './worker-flags.js';

// fork 模式的父进程会设置 DHT_REINDEX_JOB（JSON 参数）；worker 线程模式无此变量。
// 以环境变量为主判据而不是 parentPort：Bun 下 worker_threads 实现不完整，
// 不能假设 parentPort 在非 worker 环境里一定为 null。
const isWorkerThread = process.env.DHT_REINDEX_JOB == null;
/** 过程追踪（临时调试用）：DHT_REINDEX_DEBUG=1 时在本执行体 stdout 输出明细 */
const DBG = process.env.DHT_REINDEX_DEBUG === '1';
const trace = (...args) => { if (DBG) console.log('[reindex-worker]', ...args); };

function main() {
  const { sourcePath, indexPath, mode } = isWorkerThread
    ? workerData
    : JSON.parse(process.env.DHT_REINDEX_JOB || '{}');
  trace(`执行体启动 mode=${mode} worker=${isWorkerThread} indexPath=${indexPath}`);

  /** 统一回传通道：worker 线程走 postMessage，子进程走 process.send */
  const post = (msg) => {
    if (isWorkerThread) parentPort.postMessage(msg);
    else if (process.send) process.send(msg);
  };

  let api;
  try {
    // sync: false —— 执行体只为维护索引而来，不必先跑一次增量同步
    api = createMagnetDb({ source: sourcePath, indexDbPath: indexPath, sync: false });
    trace('createMagnetDb 打开完成，开始执行索引维护');
    if (mode === 'full') {
      trace('开始 rebuildSync（全量重建）');
      const indexed = api.rebuildSync((p) => {
        trace(`rebuildSync flush: done=${p.done}/${p.total} t=${Date.now()}`);
        post({ type: 'progress', ...p });
      });
      trace(`rebuildSync 完成 indexed=${indexed}`);
      post({ ok: true, indexed });
    } else {
      // 增量同步：onFlush 自带 done/total（total 为预先算出的 id 跨度），直接转发
      const r = api.syncIncrementalSync((p) => {
        post({ type: 'progress', done: p.done, total: p.total });
      });
      post({ ok: true, result: r });
    }
  } catch (err) {
    trace(`执行体捕获异常: ${err?.message ?? String(err)}`);
    post({ ok: false, error: err?.message ?? String(err) });
  } finally {
    try {
      api?.close();
    } catch {
      /* 关闭失败不影响已经回传的结果 */
    }
    trace('执行体退出');
    // 子进程模式：结果已发出，稍作停留让 IPC 帧冲刷完毕后自行退出，进程不残留
    if (!isWorkerThread) setTimeout(() => process.exit(0), 100);
  }
}

// worker 线程模式：派生即执行；子进程 / exe 自拉起模式：只认命令行标记
if (isWorkerThread || process.argv.includes(INDEX_WORKER_FLAG)) main();
