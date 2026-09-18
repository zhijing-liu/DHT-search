/**
 * 索引维护执行体（子进程）
 * ------------------------------------------------------------------
 * 由 db.js 的 spawnIndexChild 派生（派生细节见 src/child-process.js）。
 * 参数经环境变量 DHT_REINDEX_JOB（JSON）传入，进度与结果经 process.send 回传：
 *   → 父级  { type: 'progress', step, stepIndex, stepCount, done, scanned?, total? }
 *   → 父级  { ok: true, indexed, phases }                    （full 模式）
 *   → 父级  { ok: true, result: { skipped, added }, phases } （incremental 模式）
 *   → 父级  { ok: false, error }
 *
 * phases 是分段计时快照（见 index/timing.js）：计时器活在本进程里，故随终态回传。
 * 独立于主进程执行的理由：维护是一连串同步 SQLite 调用，会把事件循环卡在 C++ 里；
 * 且只有进程级 kill 能真正中断它。
 * 是否执行由「命令行含 INDEX_WORKER_FLAG」守卫，被普通 import 时无副作用。
 */
import { createMagnetDb } from './db.js';
import { runtimeStats } from './stats.js';
import { INDEX_WORKER_FLAG } from './worker-flags.js';

/** 过程追踪：DHT_REINDEX_DEBUG=1 时在本执行体 stdout 输出明细（与主进程同一开关） */
const DBG = process.env.DHT_REINDEX_DEBUG === '1';
const trace = (...args) => { if (DBG) console.log('[reindex-worker]', ...args); };

const main = () => {
  const { sourcePath, indexPath, filesPath, mode } = JSON.parse(process.env.DHT_REINDEX_JOB || '{}');
  trace(`执行体启动 mode=${mode} indexPath=${indexPath} filesPath=${filesPath}`);

  /** 回传通道：子进程 IPC */
  const post = (msg) => {
    process.send?.(msg);
  };

  let api;
  try {
    // sync: false —— 执行体只为维护索引而来，不必先跑一次增量同步。
    // filesDbPath 显式传入正式冷库：本进程写的是影子索引库，但冷库全进程共用一份。
    api = createMagnetDb({ source: sourcePath, indexDbPath: indexPath, filesDbPath: filesPath, sync: false });
    trace('createMagnetDb 打开完成，开始执行索引维护');
    if (mode === 'full') {
      trace('开始 rebuildSync（全量重建）');
      const indexed = api.rebuildSync((p) => {
        trace(`rebuildSync flush: done=${p.done}/${p.total} t=${Date.now()}`);
        post({ type: 'progress', ...p });
      });
      trace(`rebuildSync 完成 indexed=${indexed}`);
      post({ ok: true, indexed, phases: runtimeStats.indexing.phases });
    } else {
      // 增量同步：进度原样转发（含阶段名与扫描计数）
      const r = api.syncIncrementalSync((p) => {
        post({ type: 'progress', ...p });
      });
      post({ ok: true, result: r, phases: runtimeStats.indexing.phases });
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
    // 结果已发出，稍作停留让 IPC 帧冲刷完毕后自行退出，进程不残留
    setTimeout(() => process.exit(0), 100);
  }
};

// 只认命令行标记：被普通 import 时 main() 不执行
if (process.argv.includes(INDEX_WORKER_FLAG)) main();
