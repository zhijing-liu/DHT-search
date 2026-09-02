/**
 * spike-worker：故意跑一条超长查询，验证「主线程 terminate 能否杀掉
 * 正在执行的 bun:sqlite 原生查询」。
 *
 * 交叉连接 30000 x 30000 = 9 亿行聚合，确保查询明显 > 演示窗口（>10s）。
 * 查完主动 db.close()，以便区分「被 terminate 杀掉」与「自然结束但连接未关」。
 */
import { workerData, parentPort } from 'node:worker_threads';
import { Database } from 'bun:sqlite';

const db = new Database(workerData.dbPath, { readonly: false, create: true });
db.exec('CREATE TABLE IF NOT EXISTS t(x INTEGER)');

const cnt = Number(db.query('SELECT count(*) AS c FROM t').get()?.c ?? 0);
if (cnt === 0) {
  const ins = db.query('INSERT INTO t(x) VALUES (?)');
  const tx = db.transaction((n) => {
    for (let i = 0; i < n; i++) ins.run(i);
  });
  tx(30000);
  console.log('[worker] 已生成 30000 行数据');
}

console.log('[worker] 开始执行超长查询（CPU 应跑满）...');
const start = performance.now();
try {
  const row = db
    .query('SELECT count(*) AS c FROM t A, t B WHERE (A.x*A.x + B.x*B.x) > -1')
    .get();
  const elapsed = performance.now() - start;
  db.close(); // 关键：查完主动关闭，避免连接挂着导致 worker 不退出
  console.log(`[worker] 查询【正常结束】 rows=${row.c} elapsed=${elapsed.toFixed(0)}ms`);
  parentPort?.postMessage({ ok: true, elapsed });
} catch (e) {
  console.log('[worker] 查询异常(若被 terminate 属预期):', e?.message ?? e);
  parentPort?.postMessage({ ok: false, error: String(e) });
}
