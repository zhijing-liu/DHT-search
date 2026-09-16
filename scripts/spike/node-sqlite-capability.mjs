/**
 * 实验脚本：内置 node:sqlite 与 better-sqlite3 的能力 / 吞吐对照
 * ------------------------------------------------------------------
 * 用于评估「Node 侧能否改用内置 node:sqlite」，结论见 src/db-driver.js 的文件头。
 * 用法：node scripts/spike/node-sqlite-capability.mjs
 * 只写临时文件（跑完自删），不碰 data/ 下任何真实库。
 */
import fs from 'node:fs';

/* ---------- 1. 能力探测 ---------- */
const caps = {};
try {
  const { DatabaseSync } = await import('node:sqlite');
  caps.import = 'ok（无 flag）';
  const db = new DatabaseSync(':memory:');
  caps.sqlite = db.prepare('SELECT sqlite_version() AS v').get()?.v;

  const tryExec = (sql) => {
    try {
      db.exec(sql);
      return true;
    } catch {
      return false;
    }
  };
  caps.fts5 = tryExec("CREATE VIRTUAL TABLE t1 USING fts5(x, content='', tokenize='unicode61 remove_diacritics 2')");
  caps.contentlessDelete = tryExec("CREATE VIRTUAL TABLE t2 USING fts5(x, content='', contentless_delete=1)");
  caps.detailNone = tryExec("CREATE VIRTUAL TABLE t3 USING fts5(x, content='', detail=none)");
  try {
    const r = db.prepare('PRAGMA threads').get();
    caps.pragmaThreads = r && 'threads' in r ? Number(r.threads) : null;
  } catch {
    caps.pragmaThreads = null;
  }
  db.exec('CREATE TABLE d(a INTEGER, b TEXT)');
  try {
    caps.dbstat = db.prepare("SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE 'd%'").get() != null;
  } catch {
    caps.dbstat = false;
  }
  // 本项目的适配层统一「以数组传参」；node:sqlite 不支持，必须展开
  try {
    db.prepare('SELECT ? AS x').get([1]);
    caps.arrayBind = true;
  } catch (e) {
    caps.arrayBind = `不支持：${e.message}`;
  }
  try {
    db.prepare('SELECT ? AS x').get(1);
    caps.variadicBind = true;
  } catch {
    caps.variadicBind = false;
  }
  db.close();
} catch (e) {
  caps.import = `失败：${e.message}`;
}
console.log(JSON.stringify(caps, null, 0));

/* ---------- 2. 吞吐对照：同样数据量写 docs + FTS ---------- */
const ROWS = 20000;

function makeRows() {
  const arr = [];
  for (let i = 0; i < ROWS; i += 1) {
    arr.push([
      i,
      `Some.Random.Movie.${i}.1080p.BluRay.x264-GROUP.mkv`,
      JSON.stringify([{ path: `Some.Random.Movie.${i}/Sample/part0.mkv`, size: 1024 * 1024 + i }]),
      1024 * 1024 * 700,
      1700000000000 + i,
    ]);
  }
  return arr;
}

async function bench(label, open) {
  const file = `spike-node-sqlite-${label}.db`;
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const db = await open(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, name TEXT, files TEXT, totalSize INTEGER, fetchedAt INTEGER)');
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, files, content='', tokenize='unicode61 remove_diacritics 2')");
  const ins = db.prepare('INSERT INTO m (id, name, files, totalSize, fetchedAt) VALUES (?, ?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO fts (rowid, name, files) VALUES (?, ?, ?)');
  const rows = makeRows();

  const t0 = performance.now();
  db.exec('BEGIN');
  for (const r of rows) {
    ins.run(...r); // 展开传参：两种驱动都支持（数组形式 node:sqlite 不支持）
    insFts.run(r[0], r[1], r[1]);
  }
  db.exec('COMMIT');
  const ms = performance.now() - t0;

  const t1 = performance.now();
  db.exec("INSERT INTO fts (fts, rank) VALUES ('optimize', 4)");
  const mergeMs = performance.now() - t1;
  db.close();

  const size = fs.statSync(file).size;
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  return { label, writeMs: Math.round(ms), mergeMs: Math.round(mergeMs), dbMb: +(size / 1048576).toFixed(1) };
}

const results = [];
try {
  const { DatabaseSync } = await import('node:sqlite');
  results.push(await bench('node-sqlite', (f) => new DatabaseSync(f)));
} catch (e) {
  results.push({ label: 'node-sqlite', error: e.message });
}
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  results.push(await bench('better-sqlite3', (f) => new BetterSqlite3(f)));
} catch (e) {
  results.push({ label: 'better-sqlite3', error: e.message });
}
console.log(JSON.stringify(results, null, 0));
