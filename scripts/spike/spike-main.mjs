/**
 * spike-main：派生 worker 跑超长查询，1.5s 后 terminate。
 * 通过三个信号区分结果：
 *   - worker 是否打印「查询正常结束」+ 发回消息  => 自然跑完
 *   - worker 的 exit 事件是否在 terminate 后很快触发 => 被真正杀掉
 *   - 6s 时 worker 是否仍存活 => terminate 在 Bun 下无效
 * 最后在主线程打开同一 DB 做 sanity，验证崩溃恢复。
 */
import { Worker } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), 'spike.db');
// 清空上一轮残留，保证本轮是干净的 30000 行
for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
  try { fs.rmSync(p); } catch {}
}
console.log('[main] dbPath =', dbPath, '(已清空)');

let exitCode = null;
let finished = false;
const worker = new Worker(new URL('./spike-worker.mjs', import.meta.url), {
  workerData: { dbPath },
});

worker.on('message', (m) => {
  if (m?.ok) finished = true;
  console.log('[main] worker 消息:', m);
});
worker.on('error', (e) => console.log('[main] worker error:', e?.message ?? e));
worker.on('exit', (code) => {
  exitCode = code;
  console.log('[main] worker 已退出，exit code =', code);
});

console.log('[main] 1.5s 后将 terminate worker ...');
setTimeout(() => {
  console.log('[main] >>> 现在 terminate worker');
  worker.terminate();
}, 1500);

setTimeout(() => {
  console.log('\n========== 结论 ==========');
  if (finished) {
    console.log('❓ worker 自行跑完了查询 => terminate 没来得及/没能中断');
  } else if (exitCode !== null) {
    console.log('✅ terminate 杀掉了 worker，长查询被中断（CPU 已释放）');
  } else {
    console.log('❌ 6s 后 worker 仍存活 => Bun 下 terminate 未能杀掉 bun:sqlite 查询');
  }

  console.log('[main] 在主线程打开同一 DB 做 sanity check ...');
  try {
    const db = new Database(dbPath, { readonly: true });
    const c = db.query('SELECT count(*) AS c FROM t').get()?.c ?? -1;
    console.log(`[main] sanity count = ${c} => DB 仍可正常查询 ✅`);
    db.close();
  } catch (e) {
    console.log('[main] sanity 失败 ❌:', e?.message ?? e);
  }
  console.log('[main] demo 结束');
  process.exit(0);
}, 6000);
