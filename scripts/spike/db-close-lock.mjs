/**
 * 探测「关闭 SQLite 连接后文件能否立刻改名」（spike 试验脚本）
 * ------------------------------------------------------------------
 * 用于定位 Windows 下影子库切换 EBUSY 的根因：
 *   - 若退避后即可成功 → 只是句柄释放有延迟，切换处加退避重试即可；
 *   - 若一直失败 → 句柄真的没释放（换方案：内容替换而不是文件改名）。
 *
 * 用法：
 *   node scripts/spike/db-close-lock.mjs
 *   bun  scripts/spike/db-close-lock.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDb } from '../../src/db-driver.js';

const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
const file = path.join(os.tmpdir(), `dht-lock-probe-${process.pid}.db`);

const db = openDatabase(file);
db.exec('CREATE TABLE t (x INTEGER)');
db.exec('INSERT INTO t VALUES (1)');
closeDb(db);

const attempts = [];
let moved = false;
for (let i = 0; i < 6; i += 1) {
  try {
    fs.renameSync(file, `${file}.moved`);
    moved = true;
    attempts.push(`+${i * 100}ms OK`);
    break;
  } catch (err) {
    attempts.push(`+${i * 100}ms ${err.code || err.message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
console.log(`[${runtime}] ${attempts.join(' | ')} → ${moved ? '可改名' : '始终被锁'}`);
for (const f of [file, `${file}.moved`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 尽力而为 */ }
}
