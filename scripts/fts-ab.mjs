#!/usr/bin/env node
/**
 * FTS5 参数 A/B 基准（格式 v2 的决策工具）
 * ------------------------------------------------------------------
 * 对同一份样本、同一批查询，逐个配置实测：写入耗时、索引体积，以及 bm25 排序一致性
 * （相对 full/cs1 基准的 top-10 Jaccard 与 top-1 命中率）。
 *
 * 用法：
 *   node scripts/fts-ab.mjs                       # 默认取源库前 2 万行
 *   node scripts/fts-ab.mjs --rows=50000
 *   node scripts/fts-ab.mjs --text=paths          # 对比「纯路径文本」而非原始 JSON
 *   node scripts/fts-ab.mjs --queries=movie,1080p # 指定查询词
 *   node scripts/fts-ab.mjs --src=D:/x/magnet.db
 *
 * 源库不存在时自动退化为合成数据，脚本始终可跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOURCE_DB_PATH } from '../config.js';
import {
  openDatabase,
  createDrizzle,
  prepareStmt,
  runStmt,
  transaction,
  setPragma,
  getRow,
  allRows,
  closeDb,
  execRaw,
} from '../src/db-driver.js';
import { resetIndexTables, ftsOptionSql } from '../src/index/ddl.js';
import { FTS_TABLE, DOCS_TABLE } from '../src/store.js';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { rows: 20000, src: null, text: null, queries: null };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'rows') out.rows = Math.max(1, Number(value) || out.rows);
    else if (key === 'src') out.src = value || null;
    // --text 用于把矩阵收敛到某一种文本模式（不传则 raw / paths 都跑，便于横向对比）
    else if (key === 'text') out.text = value === 'paths' ? 'paths' : value === 'raw' ? 'raw' : null;
    else if (key === 'queries') out.queries = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/**
 * 待对比的配置矩阵（label 即表格行名），三个维度：
 *   text       raw = 源库 files 原文 JSON；paths = 只留路径
 *   detail     是否保留词频/位置（bm25 的 tf 项来源）
 *   columnsize 是否保留每列 token 数（bm25 的文档长度归一化来源）
 * 第 1 行为基准，其余依次为提案与降档对照。
 */
const CONFIGS = [
  { label: 'raw full/cs1', text: 'raw', caps: { detail: 'full', columnsize: true, contentlessDelete: false } },
  { label: 'paths full/cs1', text: 'paths', caps: { detail: 'full', columnsize: true, contentlessDelete: false } },
  { label: 'paths full/cs1+cd', text: 'paths', caps: { detail: 'full', columnsize: true, contentlessDelete: true } },
  { label: 'paths full/cs0', text: 'paths', caps: { detail: 'full', columnsize: false, contentlessDelete: false } },
  { label: 'paths column/cs1', text: 'paths', caps: { detail: 'column', columnsize: true, contentlessDelete: false } },
  { label: 'paths none/cs1', text: 'paths', caps: { detail: 'none', columnsize: true, contentlessDelete: false } },
];

const BATCH = 5000;
const TOP_N = 10;

/* ------------------------------------------------------------------ */
/* 样本                                                                */
/* ------------------------------------------------------------------ */

/** 合成样本：源库不可用时兜底，形状与真实 magnets 行一致 */
function syntheticRows(n) {
  const words = ['movie', '1080p', 'bluray', 'x264', 'sample', 'ubuntu', 'iso', 'collection',
    'remux', '4k', 'hdr', 'webrip', 'hevc', 'aac', 'subs', 'extras', 'season', 'episode'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const rows = [];
  for (let i = 1; i <= n; i += 1) {
    const withDirs = Math.random() < 0.5;
    const fileCount = 1 + Math.floor(Math.random() * 8);
    const files = [];
    for (let j = 0; j < fileCount; j += 1) {
      const name = `${pick()}.${pick()}.${pick()}.${j + 1}.mkv`;
      files.push({ path: withDirs ? `Season.${1 + (i % 5)}/${name}` : name, size: Math.floor(Math.random() * 5e9) });
    }
    const infohash = String(i).padStart(40, '0');
    rows.push({
      id: i,
      name: files[0].path.replace(/^.*\//, ''),
      infohash,
      magnet: `magnet:?xt=urn:btih:${infohash}`,
      files: JSON.stringify(files),
      totalSize: files.reduce((s, f) => s + f.size, 0),
      fetchedAt: 1700000000000 + i,
    });
  }
  return rows;
}

/** 读取源库样本（按 id 升序前 n 行） */
function loadRows(srcPath, n) {
  if (!srcPath || !fs.existsSync(srcPath)) return { rows: syntheticRows(n), from: 'synthetic' };
  const raw = openDatabase(srcPath, { readonly: true });
  try {
    const rows = allRows(
      raw,
      'SELECT id, name, infohash, magnet, files, totalSize, fetchedAt FROM magnets ORDER BY id LIMIT ?',
      [n]
    );
    if (rows.length === 0) return { rows: syntheticRows(n), from: 'synthetic' };
    return { rows, from: srcPath };
  } catch {
    return { rows: syntheticRows(n), from: 'synthetic' };
  } finally {
    closeDb(raw);
  }
}

/** 从 files 原文里取出路径列表（解析失败返回空数组） */
function extractPaths(rawFiles) {
  try {
    const parsed = JSON.parse(String(rawFiles ?? ''));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((f) => String(f?.path ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** 把源行 files 转成送进 FTS 的文本（raw = 现状；paths = 只留路径，去掉 JSON 语法与键名） */
function toFtsText(rawFiles, mode) {
  const raw = rawFiles == null ? '' : String(rawFiles);
  if (mode !== 'paths') return raw;
  const paths = extractPaths(raw);
  return paths.length ? paths.join('\n') : raw;
}

/* ------------------------------------------------------------------ */
/* 单配置实测                                                          */
/* ------------------------------------------------------------------ */

function runConfig(cfg, rows, textMode, queries) {
  const file = path.join(os.tmpdir(), `dht-fts-ab-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const raw = openDatabase(file);
  setPragma(raw, 'journal_mode', 'WAL');
  setPragma(raw, 'synchronous', 'OFF');
  setPragma(raw, 'temp_store', 'MEMORY');
  setPragma(raw, 'cache_size', -32000);

  try {
    const db = createDrizzle(raw);
    resetIndexTables(db, cfg.caps);

    const insertFts = prepareStmt(raw, `INSERT INTO ${FTS_TABLE} (rowid, name, files) VALUES (?, ?, ?)`);
    const insertDoc = prepareStmt(
      raw,
      `INSERT INTO ${DOCS_TABLE} (id, name, infohash, magnet, files, totalSize, fetchedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = transaction(raw, (list) => {
      for (const r of list) runStmt(insertFts, [r.id, r.name ?? '', toFtsText(r.files, textMode)]);
      for (const r of list) runStmt(insertDoc, [r.id, r.name ?? '', r.infohash, r.magnet, r.files, r.totalSize, r.fetchedAt]);
    });

    const t0 = performance.now();
    for (let i = 0; i < rows.length; i += BATCH) batch(rows.slice(i, i + BATCH));
    const writeMs = performance.now() - t0;

    const tMerge = performance.now();
    execRaw(raw, `INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, rank) VALUES ('optimize', 4)`);
    const mergeMs = performance.now() - tMerge;

    // FTS 表单独占用（dbstat 未编译时退化为 null）
    let ftsBytes = null;
    try {
      const r = getRow(raw, `SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE '${FTS_TABLE}%'`);
      ftsBytes = Number(r?.b ?? 0) || null;
    } catch {
      ftsBytes = null;
    }

    execRaw(raw, 'PRAGMA wal_checkpoint(TRUNCATE)');
    const sizeBytes = fs.statSync(file).size;

    // bm25 top-N：与线上一致，用字面量 MATCH 表达式（token 已白名单化）
    const topByQuery = new Map();
    const hitCounts = new Map();
    for (const q of queries) {
      const expr = `"${q.toLowerCase()}"*`.replace(/'/g, "''");
      // 命中数单独记录：如果各配置连匹配集都不一样，那就不只是排序退化的问题
      hitCounts.set(q, Number(getRow(raw, `SELECT count(*) AS c FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH '${expr}'`)?.c ?? 0));
      const list = allRows(
        raw,
        `SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH '${expr}'
         ORDER BY bm25(${FTS_TABLE}) LIMIT ${TOP_N}`
      );
      topByQuery.set(q, list.map((r) => r.rowid));
    }

    // 相关性代理指标：top-N 里「路径真的包含查询词」的比例。
    // 用 path 而不是 name —— name 常是种子标题，而命中往往落在 files 内的文件名上。
    let hit = 0;
    let total = 0;
    for (const q of queries) {
      const ids = topByQuery.get(q) ?? [];
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(',');
      const rowsInTop = allRows(raw, `SELECT files FROM ${DOCS_TABLE} WHERE id IN (${placeholders})`, ids);
      for (const row of rowsInTop) {
        total += 1;
        if (extractPaths(row.files).some((p) => p.toLowerCase().includes(q.toLowerCase()))) hit += 1;
      }
    }
    const precision = total ? hit / total : 1;

    // 抽样：第一个查询的 top-5（rowid + name）。
    // contentless FTS 表不存列值，name 必须回 docs 表 JOIN 取。
    const sampleQuery = queries[0];
    const samples = allRows(
      raw,
      `SELECT d.id AS id, d.name AS name FROM ${DOCS_TABLE} d
        JOIN (SELECT rowid FROM ${FTS_TABLE}
               WHERE ${FTS_TABLE} MATCH '"${String(sampleQuery).toLowerCase()}"*'
               ORDER BY bm25(${FTS_TABLE}) LIMIT 5) f ON d.id = f.rowid`
    );

    return { writeMs, mergeMs, sizeBytes, ftsBytes, topByQuery, hitCounts, sampleQuery, samples, precision };
  } finally {
    closeDb(raw);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(file + suffix, { force: true }); } catch { /* 尽力而为 */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 查询词与一致性                                                      */
/* ------------------------------------------------------------------ */

/** 从样本 name 里取高频 token 作为查询集（保证有命中，且贴近真实检索） */
function pickQueries(rows, count = 8) {
  const freq = new Map();
  for (const r of rows) {
    for (const t of String(r.name ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([t]) => t);
}

/** top-N 集合的 Jaccard 相似度 */
function jaccard(a, b) {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function compareWithBase(base, other, queries) {
  let jSum = 0;
  let top1 = 0;
  for (const q of queries) {
    const b = base.get(q) ?? [];
    const o = other.get(q) ?? [];
    jSum += jaccard(b, o);
    if (b.length > 0 && b[0] === o[0]) top1 += 1;
  }
  return { jaccard: jSum / queries.length, top1Rate: top1 / queries.length };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const opts = parseArgs(process.argv.slice(2));
const { rows, from } = loadRows(opts.src ?? SOURCE_DB_PATH, opts.rows);
const queries = opts.queries ?? pickQueries(rows);
const configs = opts.text ? CONFIGS.filter((c) => c.text === opts.text) : CONFIGS;

console.log('\nFTS5 A/B 基准（格式 v2 参数选型）');
console.log(`  样本    : ${rows.length} 行（来源：${from}）`);
console.log(`  查询词  : ${queries.join(', ')}（top-${TOP_N} 一致性对比）`);
console.log(`  矩阵    : ${configs.map((c) => c.label).join(' | ')}\n`);

const results = [];
for (const cfg of configs) {
  process.stdout.write(`  跑 ${cfg.label} ... `);
  const r = runConfig(cfg, rows, cfg.text, queries);
  results.push({ cfg, ...r });
  console.log(`写入 ${Math.round(r.writeMs)}ms / 合并 ${Math.round(r.mergeMs)}ms / ${(r.sizeBytes / 1048576).toFixed(1)}MB`);
}

const base = results.find((r) => r.cfg.label === 'raw full/cs1') ?? results[0];
const mb = (b) => (b == null ? '-' : (b / 1048576).toFixed(1));

console.log(`\n${'config'.padEnd(18)}${'write(ms)'.padStart(10)}${'merge(ms)'.padStart(11)}${'db(MB)'.padStart(9)}${'fts(MB)'.padStart(9)}${'top10-J'.padStart(9)}${'top1'.padStart(8)}${'prec'.padStart(7)}   fts5 options`);
console.log('-'.repeat(138));
for (const r of results) {
  const cmp = r === base ? { jaccard: 1, top1Rate: 1 } : compareWithBase(base.topByQuery, r.topByQuery, queries);
  console.log(
    `${r.cfg.label.padEnd(18)}${String(Math.round(r.writeMs)).padStart(10)}${String(Math.round(r.mergeMs)).padStart(11)}` +
      `${mb(r.sizeBytes).padStart(9)}${mb(r.ftsBytes).padStart(9)}${cmp.jaccard.toFixed(3).padStart(9)}` +
      `${`${Math.round(cmp.top1Rate * 100)}%`.padStart(8)}${`${Math.round(r.precision * 100)}%`.padStart(7)}   ${ftsOptionSql(r.cfg.caps)}`
  );
}

// 命中数校验：detail / columnsize 只应影响「排序」，不应影响「匹配集」本身。
// 一旦不一致，说明该参数的副作用超出预期，必须先搞清原因再谈取舍。
const badHits = queries.filter((q) =>
  results.some((r) => (r.hitCounts.get(q) ?? 0) !== (base.hitCounts.get(q) ?? 0))
);
if (badHits.length) {
  console.log(`\n  [WARN] 命中数与 full/cs1 不一致的查询：${badHits.join(', ')}`);
  console.log('         说明该配置不只改变了排序，也改变了匹配集本身。');
}

// 抽样对比：bm25 排序变化是否合理，只能靠人眼看头部结果（Jaccard 只能说明「变了」）
const sampleShown = [base, results.find((r) => r.cfg.label === 'paths full/cs1+cd') ?? results.find((r) => r.cfg.label === 'paths full/cs1')]
  .filter(Boolean);
if (sampleShown[0]) {
  console.log(`\n抽样（查询 "${sampleShown[0].sampleQuery}" 的 top-5，用于人工判断排序是否合理）：`);
  for (const r of sampleShown) {
    console.log(`  [${r.cfg.label}]`);
    for (const [i, s] of r.samples.entries()) {
      console.log(`    ${i + 1}. ${String(s.name ?? '').slice(0, 76)}`);
    }
  }
}

console.log(
  '\n判读：\n' +
    '  detail 决定是否保留词频信息（bm25 的 tf 项来源）：\n' +
    '    full   -> 词频/位置完整，bm25 精度最高（唯一能保住 relevance 排序的取值）\n' +
    '    column -> 只记命中列、无词频 -> bm25 退化，排序接近「按 rowid」\n' +
    '    none   -> 只记文档 id       -> 同样退化\n' +
    '  columnsize=0：不存每列 token 数，bm25 的文档长度归一化信息缺失。\n' +
    '  top10-J：相对 raw full/cs1 的 top-10 命中集合相似度。注意「变了」不等于「变差」——\n' +
    '           文本内容变化必然改变打分；判断好坏要看 prec。\n' +
    '  prec   ：top-N 中「路径确实包含查询词」的比例（相关性代理指标）。\n' +
    '           raw 文本把 size 数字也索引了进去，文档长度因此被噪声放大，\n' +
    '           会干扰 bm25 的长度归一化；prec 更高说明排序更贴相关文档。\n' +
    '  决策顺序：detail / columnsize 只要不是 full+cs1 就会破坏 bm25（prec 与 top1 同时崩），\n' +
    '           故可选项实际只剩「文本是否清洗」；再用 prec / top10-J 判断清洗是否值得。\n'
);
