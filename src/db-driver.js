/**
 * 统一 SQLite 驱动适配层
 * ------------------------------------------------------------------
 * 自动检测运行时：Node → better-sqlite3 + drizzle-orm/better-sqlite3；
 * Bun 等 → bun:sqlite + drizzle-orm/bun-sqlite。用动态 import 加载对应驱动，
 * 保证 Bun 下不会去加载 better-sqlite3 的原生模块。
 *
 * 约定：绑定参数统一以数组传入（抹平两种驱动的签名差异）；只暴露上层用到的最小接口，
 * PRAGMA / pluck / open 等差异都在此抹平。
 *
 * 附：Node 内置的 node:sqlite 已评估（能力够，但仍是实验特性、会把最低 Node 版本抬到
 * 23.4+，且同样需要按驱动分支），暂不替换 —— 复现脚本 scripts/spike/node-sqlite-capability.mjs。
 */

const isBun = typeof Bun !== 'undefined';

/**
 * 是否运行在 bun build --compile 编译产物中：判据是 import.meta.url 指向 Bun 的虚拟
 * 文件系统（/$bunfs/ 或 Windows 的 ~BUN/）。不能用 argv[1] / existsSync 判别——编译产物里
 * 它们同样成立。
 */
const VIRTUAL_FS_MARKERS = ['/$bunfs/', '%7EBUN/', '~BUN/'];
export const isCompiledExe =
  isBun && VIRTUAL_FS_MARKERS.some((marker) => import.meta.url.includes(marker));

let Database;
let drizzle;

if (isBun) {
  ({ Database } = await import('bun:sqlite'));
  ({ drizzle } = await import('drizzle-orm/bun-sqlite'));
} else {
  // 包名不能写成字面量：bun --compile 会把字面量动态 import 解析成构建期依赖（报
  // Could not resolve），而编译环境里没有 better-sqlite3。join 拼接后打包器无法折叠。
  const nodeSqlite = ['better-sqlite', '3'].join('');
  Database = (await import(nodeSqlite)).default;
  // 同理：drizzle 的 Node 驱动内部硬 import better-sqlite3，也不能写成字面量
  const nodeDriver = ['drizzle-orm/better-sqlite', '3'].join('');
  ({ drizzle } = await import(nodeDriver));
}

export { isBun, Database };

/* ------------------------------------------------------------------ */
/* 连接管理                                                            */
/* ------------------------------------------------------------------ */

/** 打开连接：抹平构造选项差异（bun 无 fileMustExist，缺失即报错） */
export function openDatabase(filePath, { readonly = false } = {}) {
  if (isBun) return new Database(filePath, { readonly, create: true });
  return new Database(filePath, readonly ? { readonly: true, fileMustExist: true } : {});
}

/** 用对应驱动把原生连接包成 drizzle 实例 */
export function createDrizzle(rawDb) {
  return drizzle(rawDb);
}

/* ------------------------------------------------------------------ */
/* PRAGMA                                                              */
/* ------------------------------------------------------------------ */

/**
 * 设置 PRAGMA。统一走 raw SQL 的 exec（bun 无 .pragma()，better-sqlite3 无 .run()）。
 * name / value 均为内部常量（白名单），无注入风险。
 */
export function setPragma(rawDb, name, value) {
  rawDb.exec(`PRAGMA ${name} = ${value}`);
}

/** 读 PRAGMA 当前值；直接复用 getRow 抹平两种驱动的差异 */
export function getPragma(rawDb, name) {
  return getRow(rawDb, `PRAGMA ${name}`);
}

/* ------------------------------------------------------------------ */
/* 原生语句执行（参数统一为数组）                                       */
/* ------------------------------------------------------------------ */

/** 执行 DDL / 多语句 */
export function execRaw(rawDb, sql) {
  rawDb.exec(sql);
}

/** 取单行 */
export function getRow(rawDb, sql, params = []) {
  return isBun ? rawDb.query(sql).get(params) : rawDb.prepare(sql).get(params);
}

/** 取全部行 */
export function allRows(rawDb, sql, params = []) {
  return isBun ? rawDb.query(sql).all(params) : rawDb.prepare(sql).all(params);
}

/** 等价 better-sqlite3 的 .pluck().all()：只取每行首列 */
export function pluckAll(rawDb, sql, params = []) {
  return allRows(rawDb, sql, params).map((row) => Object.values(row)[0]);
}

/** 预编译一条语句（bun 的 query 自带字节码缓存，正好替代手工复用 prepare 的优化） */
export function prepareStmt(rawDb, sql) {
  return isBun ? rawDb.query(sql) : rawDb.prepare(sql);
}

/** 执行预编译语句（写），返回 { lastInsertRowid, changes } */
export function runStmt(stmt, params = []) {
  return stmt.run(params);
}

/** 事务：两种驱动都是 db.transaction(fn) 返回可调用包装 */
export function transaction(rawDb, fn) {
  return rawDb.transaction(fn);
}

/* ------------------------------------------------------------------ */
/* 连接状态                                                            */
/* ------------------------------------------------------------------ */

/** 关闭连接（Bun 的 close 后状态位不更新，故用幂等 try/catch，不依赖状态判断） */
export function closeDb(rawDb) {
  try {
    rawDb.close();
  } catch {
    /* 已关闭或无需关闭 */
  }
}

/** 是否仍处于打开状态（better-sqlite3 用 .open；Bun 无该属性，用 SELECT 1 探测） */
export function isOpen(rawDb) {
  if (isBun) {
    try {
      rawDb.query('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
  return rawDb.open;
}

/* ------------------------------------------------------------------ */
/* 引擎能力探测                                                        */
/* ------------------------------------------------------------------ */

/**
 * SQLite 引擎版本（日志与能力判定用）。
 * @returns {string} 形如 '3.50.4'；查询失败时返回 'unknown'
 */
function sqliteVersion(rawDb) {
  try {
    return String(getRow(rawDb, 'SELECT sqlite_version() AS v')?.v ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

let ftsCapsCache = null;

/**
 * 探测 FTS5 能力（进程内只探测一次并缓存）：在内存库上真的建一次表，测当前引擎的实际
 * 行为（捆绑的 SQLite 版本随包变化，按版本号假设会让建表直接失败）。
 *
 * @returns {{ sqliteVersion: string, contentlessDelete: boolean, detailNone: boolean,
 *             detailColumn: boolean, threads: number|null }}
 */
export function probeFtsCapabilities() {
  if (ftsCapsCache) return ftsCapsCache;

  const raw = openDatabase(':memory:');
  try {
    const tryCreate = (options) => {
      try {
        raw.exec(`CREATE VIRTUAL TABLE caps_probe USING fts5(x, ${options})`);
        raw.exec('DROP TABLE caps_probe');
        return true;
      } catch {
        return false;
      }
    };

    let threads = null;
    try {
      const row = getRow(raw, 'PRAGMA threads');
      if (row && 'threads' in row) threads = Number(row.threads);
    } catch {
      /* 未编译 / 不支持该 PRAGMA：保持 null */
    }

    ftsCapsCache = {
      sqliteVersion: sqliteVersion(raw),
      contentlessDelete: tryCreate("content='', contentless_delete=1"),
      detailNone: tryCreate("content='', detail=none"),
      detailColumn: tryCreate("content='', detail=column"),
      threads,
    };
  } finally {
    closeDb(raw);
  }
  return ftsCapsCache;
}
