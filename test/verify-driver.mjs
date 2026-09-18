/**
 * db-driver.js 可行性验证脚本
 * ------------------------------------------------------------------
 * 在目标运行时（Bun 或 Node）下，逐一验证 db.js 将来会调用的每个驱动方法
 * 与 FTS5 全套特性是否可用。
 *
 * 用法：
 *   bun verify-driver.mjs      # 验证 bun:sqlite 路径
 *   node verify-driver.mjs     # 验证 better-sqlite3 路径（需已安装）
 *
 * 有任何 FAIL 就把输出贴回，再决定 db-driver.js 怎么改。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import {
  isBun,
  Database,
  openDatabase,
  createDrizzle,
  setPragma,
  getPragma,
  execRaw,
  getRow,
  allRows,
  pluckAll,
  prepareStmt,
  runStmt,
  transaction,
  closeDb,
  isOpen,
} from '../src/db-driver.js';

const HERE = import.meta.dirname;
const TMP = path.join(HERE, 'data', 'verify-driver.tmp.db');
for (const s of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(TMP + s, { force: true });
  } catch {
    /* 清理，忽略 */
  }
}

let pass = 0;
let fail = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${e?.stack || e?.message || e}`);
    fail += 1;
  }
};

console.log(`\n[环境] ${isBun ? 'Bun (bun:sqlite)' : 'Node (better-sqlite3)'}\n`);

// 确保测试库所在目录存在（better-sqlite3 不会自动创建父目录）
fs.mkdirSync(path.dirname(TMP), { recursive: true });

const wdb = openDatabase(TMP);

/* ---- 1. PRAGMA / WAL ---- */
console.log('\n[1] PRAGMA 与 WAL');
check('setPragma busy_timeout', () => setPragma(wdb, 'busy_timeout', 5000));
check('setPragma journal_mode = WAL 生效', () => {
  setPragma(wdb, 'journal_mode', 'WAL');
  const m = String(getPragma(wdb, 'journal_mode').journal_mode).toLowerCase();
  if (m !== 'wal') throw new Error('期望 wal，实际 ' + m);
});
check('setPragma cache_size / mmap_size / synchronous / temp_store', () => {
  setPragma(wdb, 'cache_size', -32000);
  setPragma(wdb, 'mmap_size', 0);
  setPragma(wdb, 'synchronous', 'NORMAL');
  setPragma(wdb, 'temp_store', 'FILE');
});

/* ---- 2. DDL + 插入 + 数组绑定 ---- */
console.log('\n[2] execRaw / prepareStmt / runStmt（数组绑定）');
check('execRaw 建普通表', () =>
  execRaw(wdb, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, v INTEGER)'),
);
const insT = prepareStmt(wdb, 'INSERT INTO t (id, name, v) VALUES (?, ?, ?)');
check('runStmt 数组绑定插入', () => {
  runStmt(insT, [1, 'alice', 10]);
  runStmt(insT, [2, 'bob', 20]);
  const r = getRow(wdb, 'SELECT name, v FROM t WHERE id = ?', [1]);
  if (r?.name !== 'alice' || r?.v !== 10) throw new Error(JSON.stringify(r));
});
check('allRows 数组绑定', () => {
  const rows = allRows(wdb, 'SELECT name FROM t WHERE id > ? ORDER BY id', [0]);
  if (rows.length !== 2) throw new Error('行数 ' + rows.length);
});
check('pluckAll 取首列', () => {
  const names = pluckAll(wdb, 'SELECT name FROM t ORDER BY id');
  if (JSON.stringify(names) !== JSON.stringify(['alice', 'bob'])) {
    throw new Error(JSON.stringify(names));
  }
});
check('getRow 无参数', () => {
  const r = getRow(wdb, 'SELECT count(*) AS c FROM t');
  if (Number(r?.c) !== 2) throw new Error('c=' + r?.c);
});

/* ---- 3. better-sqlite3 特有 API 探测 ---- */
console.log('\n[3] better-sqlite3 特有 API 探测');
if (isBun) {
  check('bun:sqlite 无 .pluck()（确认需 pluckAll 封装）', () => {
    const stmt = wdb.query('SELECT name FROM t');
    if (typeof stmt.pluck === 'function') {
      throw new Error('bun 竟有 pluck()，封装可简化');
    }
  });
} else {
  check('better-sqlite3 有 .pluck()', () => {
    if (typeof wdb.prepare('SELECT name FROM t').pluck !== 'function') {
      throw new Error('better-sqlite3 缺少 pluck()');
    }
  });
}

/* ---- 4. 事务 ---- */
console.log('\n[4] transaction');
const insTx = prepareStmt(wdb, 'INSERT INTO t (id, name, v) VALUES (?, ?, ?)');
const tx = transaction(wdb, (rows) => {
  for (const r of rows) runStmt(insTx, r);
});
check('transaction 包装可调用 + 参数透传', () => {
  tx([[3, 'c', 30], [4, 'd', 40]]);
  const c = Number(getRow(wdb, 'SELECT count(*) AS c FROM t').c);
  if (c !== 4) throw new Error('count=' + c);
});
check('transaction 异常回滚', () => {
  const bad = transaction(wdb, () => {
    runStmt(insTx, [5, 'e', 50]);
    throw new Error('force-rollback');
  });
  let threw = false;
  try {
    bad([[5, 'e', 50]]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('未抛错');
  const c = Number(getRow(wdb, 'SELECT count(*) AS c FROM t').c);
  if (c !== 4) throw new Error('回滚失败 count=' + c);
});

/* ---- 5. 只读连接 + query_only ---- */
console.log('\n[5] 只读连接 / query_only');
const rdb = openDatabase(TMP, { readonly: true });
check('setPragma query_only = ON', () => setPragma(rdb, 'query_only', 'ON'));
check('只读连接可读', () => {
  const r = getRow(rdb, 'SELECT name FROM t WHERE id = ?', [1]);
  if (r?.name !== 'alice') throw new Error(JSON.stringify(r));
});
check('只读连接禁止写入', () => {
  let blocked = false;
  try {
    runStmt(prepareStmt(rdb, 'INSERT INTO t (id) VALUES (?)'), [99]);
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error('写入未被禁止');
});

/* ---- 6. closeDb（幂等） ---- */
console.log('\n[6] closeDb 幂等');
check('closeDb 可重复调用不抛错', () => {
  closeDb(rdb);
  closeDb(rdb);
});
check('closeDb 后 isOpen 为假', () => {
  if (isOpen(rdb)) throw new Error('rdb 应已关闭');
});

/* ---- 7. drizzle 查询层 ---- */
console.log('\n[7] drizzle 查询层');
const db = createDrizzle(wdb);
const raw = db.$client ?? db.session?.client;
check('drizzle 实例暴露 $client（热路径所需）', () => {
  if (!raw) throw new Error('无 $client');
  const hasApi = typeof raw.query === 'function' || typeof raw.prepare === 'function';
  if (!hasApi) throw new Error('$client 无 query/prepare');
});

// 诊断：drizzle 裸 SQL 执行器（db.get / db.all / db.run）在 Bun 下的真实返回形状
const drizzleGet = db.get(sql`SELECT count(*) AS c FROM t`);
console.log('  [diag] db.get(sql`SELECT count(*) AS c FROM t`) =>', JSON.stringify(drizzleGet));
const drizzleAll = db.all(sql`SELECT 1 AS x`);
console.log('  [diag] db.all(sql`SELECT 1 AS x`) =>', JSON.stringify(drizzleAll));
const drizzleRun = db.run(sql`CREATE TABLE IF NOT EXISTS u(id INTEGER)`);
console.log('  [diag] db.run(CREATE) =>', JSON.stringify(drizzleRun));

// 对照：用 $client + 包装层（已在组2验证可用）——db.js 将走这条路径
check('$client 路径 getRow 可取 count', () => {
  const r = getRow(raw, 'SELECT count(*) AS c FROM t');
  if (Number(r?.c) !== 4) throw new Error('c=' + r?.c);
});

// 查询构造器（db.select / db.insert）是否可用（db.js 用于 sync_meta / count）
execRaw(raw, 'CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)');
const { syncMeta } = await import('../src/schema.js');
check('drizzle db.insert().values().run()', () => {
  db.insert(syncMeta).values({ key: 'k', value: '1' }).run();
});
check('drizzle db.select().from().get()', () => {
  const r = db.select().from(syncMeta).get();
  if (!r || r.key !== 'k') throw new Error(JSON.stringify(r));
});

/* ---- 8. FTS5 contentless + bm25 + merge（最高风险） ---- */
console.log('\n[8] FTS5（contentless / unicode61 / bm25 / merge）');
check('FTS5 contentless 虚表可建', () =>
  execRaw(
    wdb,
    `CREATE VIRTUAL TABLE fts5_test USING fts5(
       name, files, content='', tokenize='unicode61 remove_diacritics 2'
     )`,
  ),
);
check('FTS5 按 rowid 写入', () => {
  runStmt(prepareStmt(wdb, 'INSERT INTO fts5_test (rowid, name, files) VALUES (?, ?, ?)'), [
    1, 'hello world', 'a',
  ]);
  runStmt(prepareStmt(wdb, 'INSERT INTO fts5_test (rowid, name, files) VALUES (?, ?, ?)'), [
    2, 'world of foo', 'b',
  ]);
});
check('FTS5 MATCH + bm25 排序可用', () => {
  const rows = allRows(
    wdb,
    `SELECT rowid FROM fts5_test WHERE fts5_test MATCH ? ORDER BY bm25(fts5_test)`,
    ['world'],
  );
  if (rows.length !== 2) throw new Error('命中 ' + rows.length);
});
check('FTS5 merge 技巧（INSERT ... (fts,rank) VALUES ("merge", N)）', () =>
  execRaw(wdb, `INSERT INTO fts5_test(fts5_test, rank) VALUES('merge', 4096)`),
);
check('total_changes() 可用', () => {
  const c = getRow(wdb, 'SELECT total_changes() AS c').c;
  if (typeof c !== 'number') throw new Error('类型 ' + typeof c);
});

/* ---- 9. WAL 并发可见性（在线重建依赖：读者看到写者提交） ---- */
console.log('\n[9] WAL 读者可见性');
check('新开只读连接读到写者已提交数据', () => {
  runStmt(insT, [6, 'reader-sees', 60]);
  const r2 = openDatabase(TMP, { readonly: true });
  setPragma(r2, 'query_only', 'ON');
  const r = getRow(r2, 'SELECT name FROM t WHERE id = ?', [6]);
  closeDb(r2);
  if (r?.name !== 'reader-sees') throw new Error(JSON.stringify(r));
});

/* ---- 清理（best-effort，避免 Windows 文件锁导致脚本崩溃） ---- */
closeDb(wdb);
for (const s of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(TMP + s, { force: true });
  } catch {
    /* 文件可能被运行时短暂锁定，忽略 */
  }
}

console.log(`\n========== 结果：PASS ${pass} / FAIL ${fail} ==========\n`);
if (fail > 0) process.exit(1);
