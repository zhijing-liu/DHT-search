/**
 * 全量重建 worker
 * ------------------------------------------------------------------
 * 由 db.js 的 reindex() 派生。在独立线程里打开影子索引库并执行 fullRebuild，
 * 通过 postMessage 回传进度与结果。
 *
 * 之所以独立成线程：
 *   - 重建是同步长任务，放在主进程会长时间阻塞事件循环，整个检索服务无响应；
 *   - 重建的堆占用与源库规模正相关，放 worker 后可单独设 resourceLimits
 *     的 maxOldGenerationSizeMb，触顶只杀 worker，主进程不受影响。
 *
 * 消息协议：
 *   → 主进程  { type: 'progress', done, total }
 *   → 主进程  { ok: true, indexed }  或  { ok: false, error }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createMagnetDb } from './db.js';

const { sourcePath, indexPath } = workerData;

let api;
try {
  // sync: false —— worker 只为重建而来，不必先跑一次增量同步
  api = createMagnetDb({ source: sourcePath, indexDbPath: indexPath, sync: false });
  const indexed = api.rebuildSync((p) => {
    parentPort.postMessage({ type: 'progress', ...p });
  });
  parentPort.postMessage({ ok: true, indexed });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
} finally {
  try {
    api?.close();
  } catch {
    /* 关闭失败不影响已经回传的结果 */
  }
}
