/**
 * 搜索子进程池连通性验证（spike 试验脚本）
 * ------------------------------------------------------------------
 * 自建一个临时索引库（1 条数据），然后用搜索执行器跑两个任务：
 *   - latest 模式（不经过 FTS）
 *   - FTS 检索
 * 用来验证「统一 spawn 派生」之后，Node 与 Bun 下搜索子进程都能正常拉起、
 * 一问一答、并正常回收。
 *
 * 用法：
 *   node scripts/spike/search-pool.mjs
 *   bun  scripts/spike/search-pool.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createDrizzle, closeDb } from '../../src/db-driver.js';
import { ensureSchema } from '../../src/index/ddl.js';
import { DOCS_TABLE, FTS_TABLE } from '../../src/store.js';
import { createSearchExecutor } from '../../src/searchPool.js';

const file = path.join(os.tmpdir(), `dht-search-pool-${process.pid}.db`);
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;

// 准备一个最小可用的索引库：FTS 一条 + 副本表一条
{
  const raw = openDatabase(file);
  const db = createDrizzle(raw);
  ensureSchema(db);
  raw.exec(
    `INSERT INTO ${FTS_TABLE} (rowid, name, files) VALUES (1, 'probe movie 1080p', 'Probe.movie.1080p.mkv')`
  );
  raw.exec(
    `INSERT INTO ${DOCS_TABLE} (id, name, infohash, magnet, files, totalSize, fetchedAt)
     VALUES (1, 'probe movie 1080p', 'abc', 'magnet:?xt=urn:btih:probe',
             '[{"path":"Probe.movie.1080p.mkv","size":1}]', 1, 1)`
  );
  closeDb(raw);
}

const ex = createSearchExecutor({ maxProcesses: 1, indexPath: file });
let failed = false;
try {
  const t0 = Date.now();
  const latest = await ex.run({ mode: 'latest' }).done;
  console.log(`[${runtime}] latest   -> total=${latest.total}（${Date.now() - t0}ms，进程数 ${ex.size}）`);

  const t1 = Date.now();
  const found = await ex.run({ query: 'probe' }).done;
  console.log(`[${runtime}] search   -> total=${found.total}（${Date.now() - t1}ms，进程数 ${ex.size}）`);
  if (found.total !== 1) throw new Error(`检索结果异常：期望 1，实得 ${found.total}`);
} catch (err) {
  failed = true;
  console.log(`[${runtime}] 失败：${err?.message || err}`);
} finally {
  ex.terminateAll();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* 尽力而为 */ }
  }
}
console.log(`[${runtime}] ${failed ? '结果：失败' : '结果：通过（spawn 派生 + IPC 一问一答正常）'}`);
