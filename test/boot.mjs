/**
 * 启动级集成测试（真实起服务 + 走 HTTP）
 * ------------------------------------------------------------------
 * 补 smoke.mjs 覆盖不到的 index.js 接线（如索引库切换前后回收 / 恢复搜索进程池）。
 * 做法：在 test/data/boot/ 造一个自包含的沙箱应用，用空闲端口启动真实服务，按 HTTP 断言：
 *   1. 启动即建库（首次走全量迁移重建 + 原子切换）后检索可用；
 *   2. 手动 reindex（再切换一次）后检索仍然可用；
 *   3. 列表 / 详情接口的契约；
 *   4. SSE 快照里的「下次同步」来自 node-cron。
 *
 * 用法：node test/boot.mjs（或 npm run test:boot）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SANDBOX = path.join(HERE, 'data', 'boot');

let passed = 0;
let failed = 0;

/** 执行一条断言（同步 / 异步均可），失败只记分不抛出，末尾统一汇总 */
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${err?.message ?? err}`);
  }
}

/* ------------------------------------------------------------------ */
/* 沙箱：自包含的应用副本                                              */
/* ------------------------------------------------------------------ */

/** 取一个空闲端口（bind(0) 后立刻释放） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 建沙箱并写入专用 config.js。
 * 配置必须写全 20 个键：src/settings.js 直接解构、没有默认值兜底。
 * 白名单关掉（白名单逻辑由 test/access-control.mjs 的 40 项专项覆盖）。
 */
function writeSandbox(port) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(SANDBOX, 'src'), { recursive: true });
  for (const f of ['index.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(SANDBOX, f));
  }
  fs.writeFileSync(
    path.join(SANDBOX, 'config.js'),
    `// 启动测试专用（随沙箱目录一起删除）
export const SOURCE_DB_PATH = 'boot-src.db';
export const INDEX_DB_PATH = 'boot-index.db';
export const PORT = ${port};
export const WEB_BASE_PATH = '';
export const MAX_RESULTS = 2000;
export const REINDEX_MAX_OLD_SPACE_MB = 512;
export const SOURCE_READ_MMAP_MB = 64;
export const SYNC_CRON = '*/5 * * * *';
export const SYNC_ON_START = false;
export const SEARCH_CACHE_MAX_SIZE_MB = 8;
export const SEARCH_CACHE_TTL_MS = 60000;
export const SEARCH_MAX_PROCESSES = 2;
export const SEARCH_PROCESS_CACHE_SIZE_KB = 1024;
export const SEARCH_PROCESS_MMAP_SIZE_MB = 8;
export const SEARCH_PROCESS_RECYCLE_IMMEDIATE = false;
export const SEARCH_PROCESS_IDLE_MS = 5000;
export const SEARCH_QUEUE_MAX = 8;
export const SEARCH_QUEUE_TIMEOUT_MS = 10000;
export const ACCESS_CONTROL_MODE = 'off';
export const ALLOWED_CLIENTS = ['127.0.0.1', '::1'];
export const TRUST_PROXY = false;
`,
    'utf8'
  );
}

/** 造源库夹具（表结构与真实源库一致；两行足够覆盖检索 / 详情） */
async function writeFixtureSource() {
  const { default: Database } = await import('better-sqlite3');
  const file = path.join(SANDBOX, 'boot-src.db');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const db = new Database(file);
  db.exec(
    "CREATE TABLE magnets (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', infohash TEXT," +
      ' magnet TEXT, files TEXT, totalSize INTEGER NOT NULL DEFAULT 0, fetchedAt INTEGER NOT NULL DEFAULT 0)'
  );
  const ins = db.prepare(
    'INSERT INTO magnets (id, name, infohash, magnet, files, totalSize, fetchedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  ins.run(
    1,
    'Some.Random.Movie.2024.1080p.BluRay.x264-GROUP.mkv',
    'h1',
    'magnet:?xt=urn:btih:h1',
    JSON.stringify([
      { path: 'Some.Random.Movie.2024.1080p.BluRay.x264-GROUP.mkv', size: 8589934592 },
      { path: 'Sample/sample.txt', size: 1024 },
    ]),
    8589935626,
    1700000000000
  );
  ins.run(
    2,
    'Ubuntu.22.04.3.LTS.Desktop.amd64.iso',
    'h2',
    'magnet:?xt=urn:btih:h2',
    JSON.stringify([{ path: 'Ubuntu.22.04.3.LTS.Desktop.amd64.iso', size: 4920119296 }]),
    4920119296,
    1750000000000
  );
  db.exec('PRAGMA journal_mode = WAL');
  db.close();
}

/* ------------------------------------------------------------------ */
/* 起服务 + HTTP 小工具                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(port) {
  const out = [];
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SANDBOX,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (out.join('').includes('服务已启动')) return child;
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出（code=${child.exitCode}）：\n${out.join('')}`);
    }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`服务 30s 内未启动完成：\n${out.join('')}`);
}

async function api(port, urlPath, init) {
  const resp = await fetch(`http://127.0.0.1:${port}${urlPath}`, init);
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如 SSE）保留 text */
  }
  return { status: resp.status, json, text };
}

/** 轮询等索引就绪（首次启动的迁移重建在后台跑，2 行数据通常毫秒级完成） */
async function waitIndexed(port, want, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api(port, '/api/count');
    last = r.json?.count ?? null;
    if (last === want) return;
    await sleep(200);
  }
  throw new Error(`等待索引到 ${want} 行超时（当前 ${last}）`);
}

/** 读 SSE 的第一帧（运行状态快照） */
async function readStatsSnapshot(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/stats/stream`, { signal: ctrl.signal });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/data: (\{.*\})/);
      if (m) return JSON.parse(m[1]);
    }
    return null;
  } catch {
    return null; // 超时 abort / 连接中断
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n[boot] 真实启动 + HTTP 集成（覆盖 index.js 接线）');
  const port = await freePort();
  writeSandbox(port);
  await writeFixtureSource();

  let child = null;
  try {
    child = await startServer(port);
    await waitIndexed(port, 2);

    // 1) 启动即建库（首次走全量迁移重建 + 原子切换）后检索必须可用。
    //    若切换钩子把搜索池置成「关闭中」，这里会拿到「服务正在关闭」
    const s1 = await api(port, '/api/search?q=ubuntu');
    await check('启动建库（含原子切换）后检索可用', () => {
      assert.equal(s1.status, 200, `HTTP ${s1.status}: ${s1.text.slice(0, 200)}`);
      assert.equal(s1.json.items.length, 1);
      assert.equal(s1.json.items[0].id, 2);
    });

    await check('列表行含 fileCount + preview（列表瘦身契约）', () => {
      assert.equal(s1.json.items[0].fileCount, 1);
      assert.deepEqual(s1.json.items[0].preview, [
        { path: 'Ubuntu.22.04.3.LTS.Desktop.amd64.iso', size: 4920119296 },
      ]);
    });

    await check('详情接口返回扁平树', async () => {
      const r = await api(port, '/api/magnet/1/files');
      assert.equal(r.status, 200);
      assert.equal(r.json.nodes.length, 3); // 根级文件 + Sample 目录 + 目录内文件
    });

    // 2) 手动重建（第二次原子切换）后检索仍可用 —— 切换钩子缺陷的回归断言
    const re = await api(port, '/api/reindex', { method: 'POST' });
    await check('手动 reindex 成功', () => {
      assert.equal(re.status, 200, `HTTP ${re.status}: ${re.text.slice(0, 200)}`);
      assert.ok(re.json.indexed > 0, `indexed=${re.json.indexed}`);
    });
    await waitIndexed(port, 2);
    const s2 = await api(port, '/api/search?q=ubuntu');
    await check('重建（原子切换）之后检索仍然可用', () => {
      assert.equal(s2.status, 200, `HTTP ${s2.status}: ${s2.text.slice(0, 200)}`);
      assert.equal(s2.json.items.length, 1);
    });
    await check('切换后能连续多次检索（搜索池未被永久关闭）', async () => {
      for (let i = 0; i < 3; i += 1) {
        const r = await api(port, '/api/search?q=ubuntu');
        assert.equal(r.status, 200, `第 ${i + 1} 次检索 HTTP ${r.status}: ${r.text.slice(0, 120)}`);
      }
    });

    // 3) 面板「下次同步」由 node-cron 提供（v4 的 getNextRun）
    const snap = await readStatsSnapshot(port);
    await check('SSE 快照的 nextSyncAt 来自调度器', () => {
      assert.ok(snap, '未取到 SSE 快照');
      assert.equal(snap.syncCron, '*/5 * * * *');
      assert.ok(Number.isFinite(snap.nextSyncAt), `nextSyncAt=${snap.nextSyncAt}`);
      assert.ok(snap.nextSyncAt > Date.now() - 60000, 'nextSyncAt 应是将来时刻');
    });
  } finally {
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      await sleep(500); // 等子进程（含搜索子进程）释放文件句柄再删目录
    }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }

  console.log(`\nboot: ${passed} 项断言通过${failed ? `，${failed} 项失败` : ''}`);
  if (failed) process.exitCode = 1;
}

await main();
