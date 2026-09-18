/**
 * 冷库（大对象）访问层：data/dht.files.db
 * ------------------------------------------------------------------
 * v4 起把两个「大列」从热库副本表移到这里：
 *
 *   magnets_files(id PK, fmt, files BLOB)   —— files 原文（zlib 压缩）
 *   magnets_preview(id PK, preview TEXT)    —— 列表预览小列
 *
 * 为什么拆（313 万行实测，搜索子进程 cache_size=2MB）：
 *
 *   files 8.27GB + preview，占副本表体积的 94%；把它们移出后副本表 12.0GB → 0.68GB。
 *   所有慢查询的形状都是「取到 N 个匹配 rowid → 逐个回表主键查找」，成本取决于
 *   副本表的页数（8.8GB≈220 万页 vs 0.68GB≈17 万页）：前者必然随机磁盘 IO，后者
 *   整个装得进缓存。实测三条典型查询：
 *     count(JOIN+大小筛选) 31.6s → 0.87s ｜ 按 fetchedAt 排序 30.8s → 1.27s
 *     ｜ 按 totalSize 排序 OFFSET 100000 30.7s → 1.40s
 *
 * 为什么是「独立库」而不是「同库另一张表」：查询提速两者等价（SQLite 按页缓存、
 * 按 B-tree 定位），独立库额外拿到——热库瘦身（备份 / VACUUM / mmap 覆盖率高一个量级）、
 * 全量重建不必重写几个 GB 的大对象（只追加缺失 id）、可放到另一块盘。
 *
 * 为什么不外置成「一个 id 一个文件」：files 长尾极重（76% 的行 < 512B，只有 331 行
 * > 1MB），一刀切外置会让绝大多数行变慢（多三次系统调用且失去事务性），并在 NTFS
 * 下制造几百万个小文件。压缩后最大单条约 1.5MB，稳稳在 SQLite 的舒适区内。
 *
 * 一致性：冷库只按 id 点查、只追加，不参与热库的原子切换（swapIndex）。
 * 热库有而冷库无的行，详情退化为「无文件列表」，不影响检索正确性。
 */

import zlib from 'node:zlib';
import {
  openDatabase,
  createDrizzle,
  setPragma,
  getRow,
  allRows,
  prepareStmt,
  runStmt,
  transaction,
  execRaw,
  closeDb,
} from '../db-driver.js';
import {
  FILES_TABLE,
  PREVIEW_TABLE,
  FILES_COLUMN_DEFS,
  PREVIEW_COLUMN_DEFS,
  FILES_FMT,
} from '../store.js';

/* ------------------------------------------------------------------ */
/* 建表                                                                */
/* ------------------------------------------------------------------ */

/** 由列定义拼建表语句（与 ddl.js 的副本表同一套路） */
const ddlOf = (table, defs) =>
  `CREATE TABLE IF NOT EXISTS ${table} (\n    ${defs
    .map(([name, decl]) => `${name} ${decl}`)
    .join(',\n    ')}\n  )`;

/**
 * 冷库的页大小：大 blob 用大页能显著缩短 overflow 页链（16KB 页下单条 1MB 只需
 * 64 个溢出页，4KB 页要 256 个）。仅对「尚未建表的新库」生效，已有库静默忽略
 * （改页大小需要 VACUUM，不值得为它重写几个 GB）。
 */
const FILES_PAGE_SIZE = 16384;

/**
 * 打开冷库连接。写连接用于索引维护，读连接用于详情 / 预览点查。
 *
 * @param {string} filePath
 * @param {{ readonly?: boolean, cacheSizeKb?: number }} [opts]
 * @returns {{ raw: object, db: object }} raw = 原生连接，db = drizzle 包装
 */
export function openFilesDb(filePath, { readonly = false, cacheSizeKb = 2048 } = {}) {
  const raw = openDatabase(filePath, { readonly });
  setPragma(raw, 'busy_timeout', 5000);
  setPragma(raw, 'cache_size', -Math.max(1, Math.trunc(cacheSizeKb)));
  if (!readonly) {
    setPragma(raw, 'journal_mode', 'WAL');
    setPragma(raw, 'synchronous', 'NORMAL');
  }
  if (readonly) setPragma(raw, 'query_only', 'ON');
  // 新库才有机会生效；已有库此语句被忽略（见 FILES_PAGE_SIZE 注释）
  try {
    execRaw(raw, `PRAGMA page_size = ${FILES_PAGE_SIZE}`);
  } catch {
    /* 驱动不支持时按默认页大小继续 */
  }
  return { raw, db: createDrizzle(raw) };
}

/** 幂等建表（全新库 / 只读打开时都能安全调用），并给老库补齐缺失列 */
export function ensureFilesSchema(raw) {
  execRaw(raw, ddlOf(FILES_TABLE, FILES_COLUMN_DEFS));
  execRaw(raw, ddlOf(PREVIEW_TABLE, PREVIEW_COLUMN_DEFS));
  // 老库补列（冷库 v4 首发之后新增的列走这里，避免 no such column）
  const existing = new Set(
    allRows(raw, `PRAGMA table_info(${FILES_TABLE})`).map((r) => r.name)
  );
  for (const [name, decl] of FILES_COLUMN_DEFS) {
    if (name === 'id' || existing.has(name)) continue;
    execRaw(raw, `ALTER TABLE ${FILES_TABLE} ADD COLUMN ${name} ${decl}`);
  }
}

/** 关闭冷库连接（幂等） */
export function closeFilesDb(raw) {
  closeDb(raw);
}

/* ------------------------------------------------------------------ */
/* 压缩编解码                                                          */
/* ------------------------------------------------------------------ */

/**
 * 低于此长度不压缩：省下的字节还不够抵消 zlib 头与膨胀风险，
 * 而 76% 的行都落在这个区间（中位 ~250B）。
 */
const COMPRESS_MIN_BYTES = 256;

/** 统一转成 Buffer（bun:sqlite 返回 Uint8Array，其 toString 不接受编码参数） */
function toBuffer(value) {
  if (value == null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/**
 * 编码一条 files 原文。
 * @param {string|null|undefined} rawText 源库 files 列原文
 * @param {boolean} compress 是否启用压缩
 * @returns {{ fmt: number, data: Buffer }}
 */
function encodeFiles(rawText, compress = true) {
  const text = String(rawText ?? '');
  const buf = Buffer.from(text, 'utf8');
  if (!compress || buf.length < COMPRESS_MIN_BYTES) return { fmt: FILES_FMT.raw, data: buf };
  return { fmt: FILES_FMT.zlib, data: zlib.deflateSync(buf, { level: 1 }) };
}

/**
 * 解码一条 files 原文（容错：格式标记未知 / 数据损坏时按原文处理，不让详情接口抛错）。
 * @param {number} fmt 存储格式（见 FILES_FMT）
 * @param {Buffer|Uint8Array} data
 * @returns {string}
 */
export function decodeFiles(fmt, data) {
  const buf = toBuffer(data);
  if (!buf || buf.length === 0) return '';
  if (fmt === FILES_FMT.zlib) {
    try {
      return zlib.inflateSync(buf).toString('utf8');
    } catch {
      return ''; // 压缩数据损坏：详情降级为空树，好过整页报错
    }
  }
  return buf.toString('utf8');
}

/* ------------------------------------------------------------------ */
/* 写入（索引期批量）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 创建冷库批写入器。
 *
 * 追加语义（mode='append'，默认）：先取冷库当前 max(id) 作为水位。水位以上的 id 是新增行，
 * 直接写入；水位以内的行用「源文长度指纹 srclen」逐批比对，只有指纹变了（源库改过这行）
 * 才重写。这样一次全量重建对冷库的写入量从「几 GB」降到「仅新增 + 真正变过的行」，
 * 同时不会因为「只追加」而让源库的 UPDATE 静默失效。
 *
 * @param {object} raw       冷库原生可写连接
 * @param {object} [opts]
 * @param {'append'|'rewrite'} [opts.mode='append'] rewrite = 无条件全量重写（不比对，最慢但最直白）
 * @param {boolean} [opts.compress=true]
 */
export function createFilesWriter(raw, { mode = 'append', compress = true } = {}) {
  // 「写不写」由下面的指纹比对决定；一旦决定写就用 REPLACE——
  // IGNORE 会让「files 变了但 preview 被忽略」这类半更新状态出现，两者必须同进同退
  const insertFiles = prepareStmt(
    raw,
    `INSERT OR REPLACE INTO ${FILES_TABLE} (id, fmt, srclen, files) VALUES (?, ?, ?, ?)`
  );
  const insertPreview = prepareStmt(
    raw,
    `INSERT OR REPLACE INTO ${PREVIEW_TABLE} (id, preview) VALUES (?, ?)`
  );
  // 追加模式下的比对水位（rewrite 模式恒为 0，即无条件全写）
  const watermark =
    mode === 'rewrite'
      ? 0
      : Number(getRow(raw, `SELECT coalesce(max(id), 0) AS m FROM ${FILES_TABLE}`)?.m ?? 0);
  // 水位 > 0 说明冷库里已有行，重建时需要逐批比对指纹
  const verify = watermark > 0;

  let buf = [];

  return {
    /** 比对水位：调用方无需再判空（0 表示不跳过任何行） */
    watermark,
    /** 缓冲一行（真正落库在 flush） */
    add(id, filesText, previewText) {
      if (!verify && Number(id) <= watermark) return;
      const { fmt, data } = encodeFiles(filesText, compress);
      buf.push([id, fmt, data, String(filesText ?? '').length, previewText]);
    },
    /** 把缓冲整批提交（单事务） */
    flush() {
      if (buf.length === 0) return;
      const batch = buf;
      buf = [];
      let rows = batch;
      if (verify) {
        // 一次 IN 查询取回本批已有行的长度指纹（批大小远小于 SQLite 的参数上限），
        // 只重写「指纹不同」的行 —— 未命中 = 冷库里还没有该行，同样要写
        const stale = new Map();
        const ids = batch.map((e) => e[0]);
        for (const r of allRows(
          raw,
          `SELECT id, srclen FROM ${FILES_TABLE} WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        )) {
          stale.set(Number(r.id), Number(r.srclen));
        }
        rows = batch.filter((e) => stale.get(Number(e[0])) !== e[3]);
        if (rows.length === 0) return;
      }
      transaction(raw, (list) => {
        for (const [id, fmt, data, srclen, preview] of list) {
          runStmt(insertFiles, [id, fmt, srclen, data]);
          runStmt(insertPreview, [id, preview]);
        }
      })(rows);
    },
  };
}

