/**
 * 索引维护执行体（双模式通用）
 * ------------------------------------------------------------------
 * 由 db.js 的 runIndex() 派生，在独立的执行单元（线程或进程）里打开影子索引库
 * 并执行索引维护。mode 决定「清不清空」：
 *   - 'incremental'：只补录源库新增行（不清空）
 *   - 'full'：清空重建（DROP/CREATE 后全量灌入）
 *
 * 两种启动方式（按环境变量 DHT_REINDEX_JOB 判别）：
 *   1. worker 线程（Node 主路径）：new Worker() 派生，参数经 workerData 传入，
 *      进度/结果经 parentPort.postMessage 回传；
 *   2. 子进程（Bun 主路径）：Bun 对 node:worker_threads 覆盖不全（resourceLimits
 *      不生效、terminate() 无法中断卡在原生调用里的同步语句），退化为
 *      child_process.fork 派生本文件为独立进程，参数经环境变量 DHT_REINDEX_JOB
 *      （JSON）传入，进度/结果经 process.send 回传。
 *
 * 之所以不能放在主进程里同步执行：
 *   - 重建 / 大批量同步是一连串同步的 SQLite 原生调用（bun:sqlite / better-sqlite3
 *     均为同步 API），放在主进程会把事件循环整个卡死在 C++ 里——重建/同步期间
 *     页面与检索全部无响应；
 *   - 重建的堆占用与源库规模正相关，独立线程/进程触顶只影响自身，主进程不受波及。
 *
 * 消息协议（两种模式完全一致，主进程侧无感知差异）：
 *   → 父级  { type: 'progress', done, total }
 *   → 父级  { ok: true, indexed }                       （full 模式）
 *   → 父级  { ok: true, result: { skipped, added } }    （incremental 模式）
 *   → 父级  { ok: false, error }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createMagnetDb } from './db.js';

// fork 模式的父进程会设置 DHT_REINDEX_JOB（JSON 参数）；worker 线程模式无此变量。
// 以环境变量为主判据而不是 parentPort：Bun 下 worker_threads 实现不完整，
// 不能假设 parentPort 在非 worker 环境里一定为 null。
const isWorkerThread = process.env.DHT_REINDEX_JOB == null;
const { sourcePath, indexPath, mode } = isWorkerThread
  ? workerData
  : JSON.parse(process.env.DHT_REINDEX_JOB || '{}');

/** 统一回传通道：worker 线程走 postMessage，子进程走 process.send */
function post(msg) {
  if (isWorkerThread) parentPort.postMessage(msg);
  else if (process.send) process.send(msg);
}

let api;
try {
  // sync: false —— 执行体只为维护索引而来，不必先跑一次增量同步
  api = createMagnetDb({ source: sourcePath, indexDbPath: indexPath, sync: false });
  if (mode === 'full') {
    const indexed = api.rebuildSync((p) => post({ type: 'progress', ...p }));
    post({ ok: true, indexed });
  } else {
    // 增量同步：onFlush 自带 done/total（total 为预先算出的 id 跨度），直接转发
    const r = api.syncIncrementalSync((p) => {
      post({ type: 'progress', done: p.done, total: p.total });
    });
    post({ ok: true, result: r });
  }
} catch (err) {
  post({ ok: false, error: err?.message ?? String(err) });
} finally {
  try {
    api?.close();
  } catch {
    /* 关闭失败不影响已经回传的结果 */
  }
  // 子进程模式：结果已发出，稍作停留让 IPC 帧冲刷完毕后自行退出，进程不残留
  if (!isWorkerThread) setTimeout(() => process.exit(0), 100);
}
