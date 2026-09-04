/**
 * 索引维护 worker（通用）
 * ------------------------------------------------------------------
 * 由 db.js 的 runIndex() 派生。在独立线程里打开影子索引库并执行索引维护，
 * 通过 postMessage 回传进度与结果。mode 决定「清不清空」：
 *   - 'incremental'：只补录源库新增行（不清空）
 *   - 'full'：清空重建（DROP/CREATE 后全量灌入）
 *
 * 之所以独立成线程：
 *   - 重建 / 大批量同步是同步长任务，放在主进程会长时间阻塞事件循环，
 *     整个检索服务无响应；
 *   - 重建的堆占用与源库规模正相关，放 worker 后可单独设 resourceLimits
 *     的 maxOldGenerationSizeMb，触顶只杀 worker，主进程不受影响。
 *
 * 消息协议：
 *   → 主进程  { type: 'progress', done, total }
 *   → 主进程  { ok: true, indexed }                       （full 模式）
 *   → 主进程  { ok: true, result: { skipped, added } }    （incremental 模式）
 *   → 主进程  { ok: false, error }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createMagnetDb } from './db.js';

const { sourcePath, indexPath, mode } = workerData;

let api;
try {
  // sync: false —— worker 只为维护索引而来，不必先跑一次增量同步
  api = createMagnetDb({ source: sourcePath, indexDbPath: indexPath, sync: false });
  if (mode === 'full') {
    const indexed = api.rebuildSync((p) => parentPort.postMessage({ type: 'progress', ...p }));
    parentPort.postMessage({ ok: true, indexed });
  } else {
    // 增量同步：onFlush 自带 done/total（total 为预先算出的 id 跨度），直接转发
    const r = api.syncIncrementalSync((p) => {
      parentPort.postMessage({ type: 'progress', done: p.done, total: p.total });
    });
    parentPort.postMessage({ ok: true, result: r });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
} finally {
  try {
    api?.close();
  } catch {
    /* 关闭失败不影响已经回传的结果 */
  }
}
