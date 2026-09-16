/**
 * 索引重建基准 · 单次运行子进程（由 test/bench-index.mjs 派生，一般不单独使用）
 * ------------------------------------------------------------------
 * 每个变体另开进程的原因：调优参数在模块加载时读环境变量（同进程内改不了），
 * 且峰值内存是进程级单调量，一次运行一个进程才干净。
 *
 * 输入（环境变量）：DHT_BENCH_SOURCE 合成源库路径、DHT_BENCH_INDEX 全新索引库路径。
 * 输出：stdout 一行 JSON，供父进程汇总成对比表。
 */
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { createMagnetDb } from '../src/db.js';
import { runtimeStats } from '../src/stats.js';

const source = process.env.DHT_BENCH_SOURCE;
const indexPath = process.env.DHT_BENCH_INDEX;
if (!source || !indexPath) {
  console.error('缺少 DHT_BENCH_SOURCE / DHT_BENCH_INDEX');
  process.exit(2);
}
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(indexPath + suffix, { force: true });
  } catch {
    /* 不存在即忽略 */
  }
}

const t0 = performance.now();
const api = createMagnetDb({ source, indexDbPath: indexPath, sync: false });
// 全新索引库 → needsFullRebuild 为真 → 这里跑的就是**全量重建**，且是**同进程**执行，
// 因此 runtimeStats.indexing.phases 能直接读到分段耗时（子进程 reindex 路径拿不到）
const r = api.syncIncrementalSync();
const ms = performance.now() - t0;

/** 峰值常驻内存（MB）：libuv 在 Windows 上 ru_maxrss 返回**字节**，其余平台返回 KB */
const raw = process.resourceUsage().maxRSS;
const peakMb = (raw > 1e8 ? raw / 1048576 : raw / 1024).toFixed(0);

/** FTS 表单独占用的页（dbstat 未编译时返回 null） */
let ftsBytes = null;
try {
  const row = api.db.all(sql`SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE 'magnets_fts%'`)[0];
  ftsBytes = Number(row?.b ?? 0) || null;
} catch {
  ftsBytes = null;
}

api.close();

console.log(
  JSON.stringify({
    rows: r.added,
    ms: Math.round(ms),
    peakMb: Number(peakMb),
    dbMb: +(fs.statSync(indexPath).size / 1048576).toFixed(1),
    ftsMb: ftsBytes == null ? null : +(ftsBytes / 1048576).toFixed(1),
    phases: runtimeStats.indexing.phases ?? {},
  })
);
