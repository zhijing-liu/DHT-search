/**
 * spike-chunk：演示「协作式分块 + 中断标志」在 Bun 主线程上实现可取消搜索。
 *
 * 与 worker 方案的本质区别：查询不再是一条不返回的同步长语句，而是按页
 * LIMIT/OFFSET 分批，批间 await setImmediate 让出事件循环；每批后检查
 * aborted 标志（真实场景由 req.on('close') 置位）。用户中断时，当前页跑完即停，
 * 不再取后续页、不再 mapRow，CPU 随即释放。
 *
 * 两阶段对照：
 *   Phase 1 - 1.5s 模拟用户刷新/停止 => 应提前中断
 *   Phase 2 - 不中断                 => 应完整跑完 30000 行
 * 同时打印「事件循环存活 tick」证明主线程未被卡死（worker 方案做不到这点）。
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), 'spike-chunk.db');
for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
  try { fs.rmSync(p); } catch {}
}

const db = new Database(dbPath, { create: true });
db.exec('CREATE TABLE t(x INTEGER, name TEXT)');
const ins = db.query('INSERT INTO t(x, name) VALUES (?, ?)');
db.transaction((n) => {
  for (let i = 0; i < n; i++) ins.run(i, 'name-' + i);
})(30000);
console.log('[setup] 已生成 30000 行');

let aborted = false;

/** 协作式分块搜索：可经 aborted 标志中途取消 */
async function chunkedSearch({ pageSize, perRowWork, label }) {
  const results = [];
  let offset = 0;
  let pages = 0;
  const start = performance.now();
  while (true) {
    if (aborted) {
      console.log(`[${label}] 检测到 aborted，于第 ${pages} 页后停止`);
      break;
    }
    const rows = db.query('SELECT x, name FROM t LIMIT ? OFFSET ?').all(pageSize, offset);
    if (rows.length === 0) break;
    // 模拟 mapRow 的 CPU 成本
    for (const r of rows) {
      let s = 0;
      for (let k = 0; k < perRowWork; k++) s += Math.sqrt(k % 97);
      results.push(s + r.x);
    }
    pages++;
    offset += pageSize;
    await new Promise((r) => setImmediate(r)); // 让出事件循环，允许中断信号被处理
  }
  return { rows: results.length, pages, elapsed: performance.now() - start };
}

// Phase 1：模拟用户在 1.5s 时刷新/停止页面
console.log('\n=== Phase 1：模拟用户在 1.5s 时刷新/停止 ===');
const tick = setInterval(() => console.log('[main] 事件循环存活 tick'), 400);
const abortTimer = setTimeout(() => {
  aborted = true;
  console.log('[sim] 用户刷新/停止 => aborted = true');
}, 1500);
const r1 = await chunkedSearch({ pageSize: 1000, perRowWork: 80000, label: 'P1' });
clearInterval(tick);
clearTimeout(abortTimer);
console.log(
  `P1 结果：${r1.rows} 行 / ${r1.pages} 页 / ${r1.elapsed.toFixed(0)}ms ` +
    `=> ${r1.rows < 30000 ? '✅ 中断生效，提前停止并释放 CPU' : '❌ 未触发中断'}`
);

// Phase 2：不中断，正常跑完整表
aborted = false;
console.log('\n=== Phase 2：不中断，正常跑完 ===');
const r2 = await chunkedSearch({ pageSize: 1000, perRowWork: 80000, label: 'P2' });
console.log(
  `P2 结果：${r2.rows} 行 / ${r2.pages} 页 / ${r2.elapsed.toFixed(0)}ms ` +
    `=> ${r2.rows === 30000 ? '✅ 完整跑完' : '❌'}`
);

db.close();
console.log('\n[main] demo 结束');
process.exit(0);
