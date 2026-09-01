/**
 * 统一 SQLite 驱动适配层
 * ------------------------------------------------------------------
 * 自动检测运行时：
 *   - Node 环境           -> better-sqlite3  + drizzle-orm/better-sqlite3
 *   - 非 Node（Bun 等）    -> bun:sqlite       + drizzle-orm/bun-sqlite
 *
 * 通过 typeof Bun 判定，并用「动态 import」加载对应驱动，保证在 Bun 下
 * 永远不会去加载 better-sqlite3 的 .node 原生文件（否则一 import 就崩）。
 *
 * 设计约束：
 *   - 所有绑定参数统一以「数组」传入（runStmt/getRow/allRows 等），
 *     规避两种驱动对「展开参数 vs 数组」的签名差异。
 *   - 仅暴露 db.js 真正用到的最小接口；PRAGMA / pluck / iterate / open
 *     等原生差异全部在此抹平。
 *
 * 本模块为 ESM 且含顶层 await（package.json 已 "type":"module"），
 * Node >=14.8 与 Bun 均支持。
 */

const isBun = typeof Bun !== 'undefined';

let Database;
let drizzle;

if (isBun) {
  ({ Database } = await import('bun:sqlite'));
  ({ drizzle } = await import('drizzle-orm/bun-sqlite'));
} else {
  Database = (await import('better-sqlite3')).default;
  ({ drizzle } = await import('drizzle-orm/better-sqlite3'));
}

export { isBun, Database, drizzle };

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
 * 设置 PRAGMA。bun 没有 .pragma() 方法，统一走 raw SQL。
 * 用 rawDb.exec 而非 rawDb.run：bun:sqlite 有 .run()，但 better-sqlite3 的
 * Database 没有 .run()（只有 .prepare().run() / .exec()），而 .exec() 两者都有。
 * name / value 均为内部常量（白名单），无注入风险。
 */
export function setPragma(rawDb, name, value) {
  rawDb.exec(`PRAGMA ${name} = ${value}`);
}

/** 读 PRAGMA 当前值，返回含 name 列的行对象（两种驱动都支持 .journal_mode 等列名访问） */
export function getPragma(rawDb, name) {
  return isBun
    ? rawDb.query(`PRAGMA ${name}`).get()
    : rawDb.prepare(`PRAGMA ${name}`).get();
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
export function getStmt(stmt, params = []) {
  return stmt.get(params);
}
export function allStmt(stmt, params = []) {
  return stmt.all(params);
}

/** 事务：两种驱动都是 db.transaction(fn) 返回可调用包装 */
export function transaction(rawDb, fn) {
  return rawDb.transaction(fn);
}

/* ------------------------------------------------------------------ */
/* 连接状态                                                            */
/* ------------------------------------------------------------------ */

/**
 * 关闭连接。Bun 的 Database 没有可靠的 .open / .closed 属性（close 后状态不更新），
 * 故统一用幂等 try/catch 直接 close，避免依赖状态位。
 */
export function closeDb(rawDb) {
  try {
    rawDb.close();
  } catch {
    /* 已关闭或无需关闭 */
  }
}

/**
 * 是否仍处于打开状态。better-sqlite3 用 .open；Bun 无该属性，
 * 用一次无副作用 SELECT 1 探测（关闭后会抛错）。
 */
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
