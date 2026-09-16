/**
 * 索引重建基准：把「批大小 / 重建期 PRAGMA / 排序线程」逐项跑成对比表
 * ------------------------------------------------------------------
 * 用法：
 *   node test/bench-index.mjs                 # 默认 5 万行，跑全部变体
 *   node test/bench-index.mjs --rows=200000   # 加长版
 *   node test/bench-index.mjs --only=批,temp  # 只跑标签里包含关键字的变体
 *   node test/bench-index.mjs --keep          # 保留合成源库，便于重复压测
 *
 * 源库是确定性合成数据，每个变体在独立子进程里跑一次真实重建
 * （createMagnetDb → indexPass → populate），故峰值内存与分段耗时可比。
 * 结果只反映本机相对关系，换机器建议重跑再决定是否调整 src/index/tuning.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase, closeDb, execRaw } from '../src/db-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const SRC = path.join(DATA_DIR, 'bench-src.db');
const CHILD = path.join(HERE, 'bench-child.mjs');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const rowCount = Math.max(1000, Number(argOf('rows', '50000')) || 50000);
const only = argOf('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const keep = process.argv.includes('--keep');
/**
 * 数据分布（百分比）：单文件 / 带目录的中等种子 / 大型多目录种子。
 * 真实源库行均 files 文本约 3.7KB，默认分布只有 ~0.6KB —— 想贴近自己的库，
 * 用 `--large=60 --multi=30` 之类的参数抬高大型种子的占比（脚本会打印实际均值）。
 */
const largePct = Math.min(95, Math.max(0, Number(argOf('large', '10')) || 0));
const multiPct = Math.min(100 - largePct, Math.max(0, Number(argOf('multi', '35')) || 0));

/**
 * 变体矩阵：每一项只改一个维度，便于归因。
 * 空 env 的项代表「v2 默认值」（来自 src/index/tuning.js）。
 */
const VARIANTS = [
  // —— 批大小：2×2 设计，分别隔离「读批」与「写批」的作用（标签里 读N/写N 的写法
  //    刻意保留成 `N/N` 形态，`--only=10k/5k` 这类片段才能直接命中；
  //    字节上限跟着行数走，否则默认的 24MB 会静默把 5 万行的变体砍成几千行） ——
  { label: '批 50k/50k（v1 口径，读/写）', env: { DHT_SCAN_BATCH: '50000', DHT_WRITE_BATCH_ROWS: '50000', DHT_WRITE_BATCH_BYTES: String(256 << 20) } },
  { label: '批 10k/5k（v2 默认，读/写）', env: {} },
  { label: '批 50k/5k（只小写批）', env: { DHT_SCAN_BATCH: '50000', DHT_WRITE_BATCH_ROWS: '5000', DHT_WRITE_BATCH_BYTES: String(24 << 20) } },
  { label: '批 10k/50k（只小读批）', env: { DHT_SCAN_BATCH: '10000', DHT_WRITE_BATCH_ROWS: '50000', DHT_WRITE_BATCH_BYTES: String(256 << 20) } },
  // —— 重建期 PRAGMA（其余取默认） ——
  { label: 'temp_store=FILE', env: { DHT_RESET_TEMP_STORE: 'FILE' } },
  { label: 'cache 256MB', env: { DHT_RESET_CACHE_KB: '262144' } },
  // —— 排序辅助线程 ——
  { label: '排序线程 0（关闭）', env: { DHT_INDEX_THREADS: '0' } },
  { label: '排序线程 4', env: { DHT_INDEX_THREADS: '4' } },
];

/* ------------------------------------------------------------------ */
/* 合成源库（固定种子，保证各变体数据完全一致）                          */
/* ------------------------------------------------------------------ */

/** mulberry32：小、确定、无依赖，足够生成伪随机分布 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'Some', 'Random', 'Movie', 'Collection', 'Season', 'Complete', 'Remux', 'BluRay',
  'Web', 'Rip', 'Documentary', 'Concerto', 'Live', 'Festival', 'Ubuntu', 'Archive',
];
const EXTS = ['mkv', 'mp4', 'avi', 'iso', 'flac', 'txt', 'srt', 'jpg'];
const DIRS = ['Sample', 'Extras', 'Subs', 'Disc 1', 'CD1', 'Season 01', 'Bonus'];

/** 生成一行 files：按 largePct / multiPct 分成单文件、带目录的中等、大型多目录三档 */
function makeFilesJson(rnd, i) {
  const name = `${WORDS[i % WORDS.length]}.${WORDS[(i * 7) % WORDS.length]}.${1000 + (i % 900)}.${EXTS[i % EXTS.length]}`;
  const r = rnd();
  if (r < (100 - largePct - multiPct) / 100) {
    return JSON.stringify([{ path: name, size: 1024 * (500 + (i % 5000)) }]);
  }

  if (r < (100 - largePct) / 100) {
    const dir = DIRS[i % DIRS.length];
    const n = 2 + Math.floor(rnd() * 6);
    const files = [];
    for (let k = 0; k < n; k += 1) {
      files.push({ path: `${name}/${dir}/part${k}.${EXTS[k % EXTS.length]}`, size: 1024 * (100 + k) });
    }
    return JSON.stringify(files);
  }

  // 大型种子：几十个文件、跨多个目录 —— files 列能到几十 KB，用来压批大小与字节阈值
  const n = 40 + Math.floor(rnd() * 60);
  const files = [];
  for (let k = 0; k < n; k += 1) {
    files.push({ path: `${name}/Season ${1 + (k % 3)}/E${String(k).padStart(2, '0')}.${EXTS[k % EXTS.length]}`, size: 1024 * 1024 * (200 + k) });
  }
  return JSON.stringify(files);
}

function buildSource() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of [SRC, `${SRC}-wal`, `${SRC}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  const src = openDatabase(SRC);
  execRaw(
    src,
    `CREATE TABLE magnets (
       id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', infohash TEXT,
       magnet TEXT, files TEXT, totalSize INTEGER NOT NULL DEFAULT 0,
       fetchedAt INTEGER NOT NULL DEFAULT 0
     )`
  );
  execRaw(src, 'PRAGMA journal_mode = WAL');
  const ins = src.prepare(
    `INSERT INTO magnets (id, name, infohash, magnet, files, totalSize, fetchedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const rnd = makeRng(20260916);
  const hash = (i) => `bench${String(i).padStart(35, '0')}`;
  let filesBytes = 0; // 累计 files 文本长度，用于报告实际行均（与真实库对照）
  const write = src.transaction((from, to) => {
    for (let i = from; i < to; i += 1) {
      const files = makeFilesJson(rnd, i);
      filesBytes += files.length;
      ins.run(i, `Bench.Magnet.${i}.Sample`, hash(i), `magnet:?xt=urn:btih:${hash(i)}`, files, 1024 * 1024 * 700, 1700000000000 + i);
    }
  });
  const CHUNK = 5000;
  for (let i = 1; i <= rowCount; i += CHUNK) write(i, Math.min(i + CHUNK, rowCount + 1));
  const bytes = fs.statSync(SRC).size;
  closeDb(src);
  return { bytes, avgFiles: Math.round(filesBytes / rowCount) };
}

/* ------------------------------------------------------------------ */
/* 跑变体 + 汇总                                                        */
/* ------------------------------------------------------------------ */

function runVariant(variant, index) {
  const indexPath = path.join(DATA_DIR, `bench-idx-${index}.db`);
  const res = spawnSync(process.execPath, [CHILD], {
    env: { ...process.env, ...variant.env, DHT_BENCH_SOURCE: SRC, DHT_BENCH_INDEX: indexPath },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(indexPath + suffix, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  if (res.status !== 0) {
    const tail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, error: `退出码 ${res.status}：${tail}` };
  }
  const line = String(res.stdout).trim().split('\n').filter(Boolean).pop();
  try {
    return { ok: true, ...JSON.parse(line) };
  } catch {
    return { ok: false, error: `无法解析子进程输出：${line?.slice(0, 200)}` };
  }
}

const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function main() {
  const { bytes, avgFiles } = buildSource();
  const sizeMb = (bytes / 1048576).toFixed(1);
  const selected = only.length
    ? VARIANTS.filter((v) => only.some((k) => v.label.includes(k)))
    : VARIANTS;
  console.log(
    `\n合成源库：${rowCount} 行 / ${sizeMb}MB / 行均 files ${avgFiles}B` +
      `（分布 单文件 ${100 - largePct - multiPct}% / 中等 ${multiPct}% / 大型 ${largePct}%；${SRC}）`
  );
  console.log(`运行时：${process.execPath}`);
  console.log(`变体数：${selected.length}\n`);

  const results = [];
  selected.forEach((variant, i) => {
    process.stdout.write(`  运行 ${i + 1}/${selected.length}：${variant.label} … `);
    const r = runVariant(variant, i);
    if (r.ok) {
      process.stdout.write(`${(r.ms / 1000).toFixed(1)}s\n`);
    } else {
      process.stdout.write(`失败\n`);
    }
    results.push({ variant, r });
  });

  console.log('\n【主要指标】');
  console.log(
    `${pad('变体', 26)}${padL('总耗时', 8)}${padL('行/秒', 9)}${padL('峰值RSS', 9)}${padL('索引MB', 8)}${padL('FTS MB', 8)}`
  );
  for (const { variant, r } of results) {
    if (!r.ok) {
      console.log(`${pad(variant.label, 26)}  失败：${r.error}`);
      continue;
    }
    console.log(
      `${pad(variant.label, 26)}` +
        `${padL(`${(r.ms / 1000).toFixed(1)}s`, 8)}` +
        `${padL(Math.round(r.rows / (r.ms / 1000)), 9)}` +
        `${padL(`${r.peakMb}MB`, 9)}` +
        `${padL(r.dbMb, 8)}` +
        `${padL(r.ftsMb ?? '-', 8)}`
    );
  }

  console.log('\n【分段耗时（ms）】scan=读源库 fts/docs/keyword=写 SQL txn=提交与WAL落页 js=未归类(解析+拼路径+热词) index/merge=收尾');
  const phaseKeys = ['scan', 'fts', 'docs', 'keyword', 'txn', 'js', 'index', 'merge', 'checkpoint'];
  console.log(`${pad('变体', 26)}${phaseKeys.map((k) => padL(k, 8)).join('')}`);
  for (const { variant, r } of results) {
    if (!r.ok) continue;
    console.log(
      `${pad(variant.label, 26)}${phaseKeys.map((k) => padL(r.phases[k] ?? 0, 8)).join('')}`
    );
  }
  console.log('');

  if (!keep) {
    for (const f of [SRC, `${SRC}-wal`, `${SRC}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  } else {
    console.log(`合成源库已保留：${SRC}\n`);
  }
}

main();
