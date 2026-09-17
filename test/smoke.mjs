/**
 * db.js 冒烟验证脚本（影子索引架构）
 * 用法：pnpm smoke（或 node smoke.mjs）
 * 用临时源库 data/smoke.db（模拟“另一应用写入”）+ 影子索引 data/smoke.search.db，
 * 不污染正式数据。验证：检索 / 排序 / 分页 / 查询串清洗 / 增量同步 / reindex / 删除处理。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createMagnetDb, normalizeSearchQuery } from '../src/db.js';
import { runtimeStats } from '../src/stats.js';
import { MAX_LIMIT } from '../src/store.js';
import { INDEX_FORMAT } from '../src/index/ddl.js';
import { createIndexTimer } from '../src/index/timing.js';
import { openDatabase, setPragma, execRaw, closeDb, allRows } from '../src/db-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_DB = path.join(HERE, 'data', 'smoke.db');
const SMOKE_INDEX = path.join(HERE, 'data', 'smoke.search.db');

const DATA_DIR = path.dirname(SMOKE_DB);
const cleanup = () => {
  // 通配删除 test/data/smoke*.db*：既清源库/影子索引，也清各 section 的独立索引库
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (/^smoke.*\.db(-\w+)?$/.test(f)) {
        // best-effort：Windows 上偶发文件锁未释放，忽略以免影响最终断言汇总
        try { fs.rmSync(path.join(DATA_DIR, f), { force: true }); } catch {}
      }
    }
  } catch {
    /* test/data 尚不存在时 readdirSync 抛 ENOENT，忽略（随后 mkdir 创建） */
  }
};
cleanup();
// cleanup() 只删文件不建目录；全新环境下 test/data 并不存在，
// 缺了它 openDatabase 会直接抛 "directory does not exist"，故在此自建。
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });

let passed = 0;
/**
 * 执行一条断言并打印。同步回调直接计分；异步回调返回 Promise，调用方需 await
 * （reindex() 走 worker 线程，是异步的）。现有同步调用点无需改动。
 */
const check = (label, fn) => {
  const done = () => {
    passed += 1;
    console.log(`  PASS  ${label}`);
  };
  const r = fn();
  if (r && typeof r.then === 'function') return r.then(done);
  done();
};

const BASE = 'Britney.Dutch.Tiny.Brunette.Dutch.Girl.Wants.Cock.FULL.HD.sxyprn.Hardcore.Amateur.Pussy.Horny.Sex.Lingerie.Brunette.More.Deleted.Content.on.PRNLEAKS.COM.mp4';

const FIXTURES = [
  {
    id: 1,
    name: BASE,
    files: [{ path: BASE, size: 336295318 }],
    totalSize: 336295318,
    fetchedAt: 1788072693739,
  },
  {
    id: 2,
    name: 'Some.Random.Movie.2024.1080p.BluRay.x264-GROUP.mkv',
    files: [
      { path: 'Some.Random.Movie.2024.1080p.BluRay.x264-GROUP.mkv', size: 8589934592 },
      { path: 'Sample/sample.txt', size: 1024 },
    ],
    totalSize: 8589935626,
    fetchedAt: 1700000000000,
  },
  {
    id: 3,
    name: 'Ubuntu.22.04.3.LTS.Desktop.amd64.iso',
    files: [{ path: 'Ubuntu.22.04.3.LTS.Desktop.amd64.iso', size: 4920119296 }],
    totalSize: 4920119296,
    fetchedAt: 1750000000000,
  },
  {
    id: 4,
    name: 'Brunette.Superstars.Collection.4K.REMUX',
    files: [{ path: 'Brunette.Superstars.Collection.4K.REMUX.mkv', size: 21474836480 }],
    totalSize: 21474836480,
    fetchedAt: 1800000000000,
  },
];

/** 把 fixture 行推导成源库 INSERT 所需的位置参数数组（bun:sqlite 不支持 @name 命名对象绑定） */
const rowParams = (r) => {
  const infohash = `hash${String(r.id).padStart(40, '0')}`;
  return [
    r.id,
    r.name,
    infohash,
    `magnet:?xt=urn:btih:${infohash}`,
    JSON.stringify(r.files),
    r.totalSize,
    r.fetchedAt,
  ];
};

/** 用独立可写连接写入“源库”，模拟另一应用的写入 */
function writeSource(fn) {
  const src = openDatabase(SMOKE_DB);
  execRaw(src, `CREATE TABLE IF NOT EXISTS magnets (
       id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', infohash TEXT,
       magnet TEXT, files TEXT, totalSize INTEGER NOT NULL DEFAULT 0,
       fetchedAt INTEGER NOT NULL DEFAULT 0
     )`);
  setPragma(src, 'journal_mode', 'WAL');
  fn(src);
  closeDb(src);
}

// 准备源库数据
writeSource((src) => {
  const ins = src.prepare(
    `INSERT INTO magnets (id, name, infohash, magnet, files, totalSize, fetchedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  src.transaction((rows) => {
    for (const r of rows) ins.run(rowParams(r));
  })(FIXTURES);
});

const openApi = () => createMagnetDb({ source: SMOKE_DB, indexDbPath: SMOKE_INDEX });

// 各 section 用独立影子索引库，互不干扰（文件名前缀 smoke，会被 cleanup 通配删除）
const idxFor = (n) => path.join(DATA_DIR, `smoke.idx${n}.db`);

// 读取源库当前行数（模拟「另一应用」写入后的真实规模）
const countSource = () => {
  let c = 0;
  writeSource((s) => { c = s.prepare('SELECT count(*) AS c FROM magnets').get().c; });
  return c;
};

console.log('\n[1] 总条数统计');
{
  const api = openApi();
  check('countMagnets 返回 4', () => assert.equal(api.countMagnets(), 4));
  check('首次打开完成全量索引（britney 命中 1，brunette 命中 2）', () => {
    assert.equal(api.searchMagnets({ query: 'britney' }).total, 1);
    assert.equal(api.searchMagnets({ query: 'brunette' }).total, 2);
  });
  check('重复打开不重复全量重建（增量水位生效）', () => {
    const again = openApi();
    assert.equal(again.searchMagnets({ query: 'brunette' }).total, 2);
    again.close();
  });
  api.close();
}

console.log('\n[2] 基础搜索');
{
  const api = openApi();
  check('按 name 命中（前缀 "brit"）', () => {
    const r = api.searchMagnets({ query: 'brit' });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, 1);
  });
  check('大小写不敏感（"BRUNETTE"）', () => {
    const r = api.searchMagnets({ query: 'BRUNETTE' });
    assert.deepEqual(r.items.map((i) => i.id).sort(), [1, 4]);
  });
  check('多词 AND 匹配（"brunette 4k"）', () => {
    const r = api.searchMagnets({ query: 'brunette 4k' });
    assert.deepEqual(r.items.map((i) => i.id), [4]);
  });
  check('命中 files 列（"sample.txt" 只在 files 中）', () => {
    const r = api.searchMagnets({ query: 'sample.txt' });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, 2);
  });
  check('列表只下发 fileCount + 预览（不下发整棵文件树）', () => {
    const r = api.searchMagnets({ query: 'sample.txt' });
    const item = r.items[0];
    assert.equal(item.fileCount, 2);
    // 有关键词时预览只保留命中的那条
    assert.deepEqual(item.preview, [{ path: 'Sample/sample.txt', size: 1024 }]);
    assert.equal(item.files, undefined);
  });
  check('详情接口按需返回扁平树（parent 指向父节点下标，目录大小已累加）', () => {
    const { nodes } = api.getMagnetFiles(2);
    // 两个源文件 → 根级文件 + Sample 目录 + 目录内的文件
    assert.equal(nodes.length, 3);
    assert.deepEqual(
      nodes.map((n) => [n.name, n.parent, n.isDir, n.size]),
      [
        ['Some.Random.Movie.2024.1080p.BluRay.x264-GROUP.mkv', -1, false, 8589934592],
        ['Sample', -1, true, 1024],
        ['sample.txt', 1, false, 1024],
      ]
    );
    // 文件节点带上源路径，供渲染时展示与关键词匹配
    assert.equal(nodes[2].path, 'Sample/sample.txt');
  });
  check('详情接口对不存在的 id 返回 null', () => {
    assert.equal(api.getMagnetFiles(999999), null);
  });
  check('返回行包含全部字段', () => {
    const r = api.searchMagnets({ query: 'brit' });
    assert.deepEqual(Object.keys(r.items[0]).sort(), [
      'fetchedAt', 'fileCount', 'id', 'infohash', 'magnet', 'name', 'preview', 'totalSize',
    ]);
    assert.equal(r.items[0].magnet, 'magnet:?xt=urn:btih:hash' + '1'.padStart(40, '0'));
    assert.equal(r.items[0].totalSize, 336295318);
    assert.equal(r.items[0].fetchedAt, 1788072693739);
  });
  api.close();
}

console.log('\n[3] files 非合法 JSON 的容错（fileCount 记 0、详情返回空树）');
{
  // 改的是已有行，增量同步不会捕获 UPDATE，需 reindex 全量重建后才会反映
  writeSource((src) => src.prepare('UPDATE magnets SET files = ? WHERE id = 3').run('not-a-json'));
  const api = openApi();
  await api.reindex();
  const r = api.searchMagnets({ query: 'ubuntu' });
  check('列表：fileCount 记 0、预览为空（不抛错）', () => {
    assert.equal(r.items[0].fileCount, 0);
    assert.deepEqual(r.items[0].preview, []);
  });
  check('详情：返回空树而非抛错', () => {
    assert.deepEqual(api.getMagnetFiles(3).nodes, []);
  });
  check('原文仍进 FTS（ftsText 回退为原文，至少原文里的词可检索）', () => {
    assert.equal(api.searchMagnets({ query: 'not' }).items[0].id, 3);
  });
  api.close();
  writeSource((src) =>
    src.prepare('UPDATE magnets SET files = ? WHERE id = 3').run(JSON.stringify(FIXTURES[2].files))
  );
}

console.log('\n[4] 排序');
{
  const api = openApi();
  check('不传 sortBy 时默认按 id 倒序（方向跟随 order，默认 desc）', () => {
    const r = api.searchMagnets({ query: 'brunette' });
    assert.deepEqual(r.items.map((i) => i.id), [4, 1]);
  });
  check('sortBy=fetchedAt desc（最新在前）', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'fetchedAt', order: 'desc' });
    assert.deepEqual(r.items.map((i) => i.id), [4, 1]);
  });
  check('sortBy=fetchedAt asc（最早在前）', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'fetchedAt', order: 'asc' });
    assert.deepEqual(r.items.map((i) => i.id), [1, 4]);
  });
  check('sortBy=totalSize desc（最大在前）', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'totalSize', order: 'desc' });
    assert.deepEqual(r.items.map((i) => i.id), [4, 1]);
  });
  check('sortBy=totalSize asc（最小在前）', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'totalSize', order: 'asc' });
    assert.deepEqual(r.items.map((i) => i.id), [1, 4]);
  });
  check('sortBy=relevance desc（按 bm25 排序，且与 asc 相反）', () => {
    const desc = api.searchMagnets({ query: 'brunette', sortBy: 'relevance', order: 'desc' });
    const asc = api.searchMagnets({ query: 'brunette', sortBy: 'relevance', order: 'asc' });
    assert.equal(desc.total, 2);
    assert.deepEqual(desc.items.map((i) => i.id), asc.items.map((i) => i.id).reverse());
    assert.notDeepEqual(desc.items.map((i) => i.id), [1, 4]); // 确实按相关性重排，而非按 id
  });
  check('非法 sortBy 回退为按 id 排序（方向仍跟随 order 默认 desc）', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'name; DROP TABLE magnets' });
    // 与「不传 sortBy」同路径：回退 id 列 + 默认 desc，故为 [4, 1]
    assert.deepEqual(r.items.map((i) => i.id), [4, 1]);
  });
  api.close();
}

console.log('\n[5] 分页');
{
  const api = openApi();
  // 以下用例未传 sortBy/order，走「回退 id 列 + 默认 desc」＝ id 倒序 [4, 1]
  check('limit=1 / offset=0 取第一条', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 1, offset: 0 });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, 4);
    assert.equal(r.total, 2);
  });
  check('limit=1 / offset=1 取第二条', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 1, offset: 1 });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, 1);
  });
  check('offset 超出范围返回空数组但 total 不变', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 20, offset: 999 });
    assert.deepEqual(r.items, []);
    assert.equal(r.total, 2);
  });
  check('limit 非法值回退默认 20', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 'abc' });
    assert.equal(r.limit, 20);
  });
  check('limit 超限被钳制到 MAX_LIMIT', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 99999 });
    assert.equal(r.limit, MAX_LIMIT);
  });
  check('offset 负数被钳制到 0', () => {
    const r = api.searchMagnets({ query: 'brunette', offset: -5 });
    assert.equal(r.offset, 0);
  });
  // 「整集拉取」是显式 opt-in：只有 limit=all 才触发。
  // 不传 / 0 / 负数一律回退分页，避免一次请求拉回上万条完整记录撑爆内存。
  check('不传 limit 走分页（回退 20）而非整集拉取', () => {
    const r = api.searchMagnets({ query: 'brunette' });
    assert.equal(r.limit, 20);
  });
  check('limit=0 按分页处理（不再是整集拉取）', () => {
    assert.equal(api.searchMagnets({ query: 'brunette', limit: 0 }).limit, 20);
  });
  // 注意：数字 -1 是「整集拉取」的内部标记（须原样传递以保证幂等），
  // 故这里用字符串 '-1' 与 -5 代表真实用户输入的负数。
  check("limit='-1'（字符串，用户输入）按分页处理", () => {
    assert.equal(api.searchMagnets({ query: 'brunette', limit: '-1' }).limit, 20);
  });
  check('limit=-5 按分页处理', () => {
    assert.equal(api.searchMagnets({ query: 'brunette', limit: -5 }).limit, 20);
  });
  check('limit=all 才是整集拉取（limit 字段为 "all"）', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 'all' });
    assert.equal(r.limit, 'all');
    assert.deepEqual(r.items.map((i) => i.id), [4, 1]);
    assert.equal(r.truncated, false);
  });
  // normalizeSearchQuery 必须幂等：HTTP 层归一化出的参数会再被搜索子进程归一化一次。
  // 若「整集拉取」标记 -1 在二次调用时被当成「负数 → 分页」，limit=all 会静默失效。
  check('normalizeSearchQuery 幂等：limit=all 二次调用仍为 -1', () => {
    const once = normalizeSearchQuery({ query: 'brunette', limit: 'all' });
    assert.equal(once.limit, -1);
    assert.equal(normalizeSearchQuery(once).limit, -1);
  });
  check('normalizeSearchQuery 幂等：普通分页参数二次调用不变', () => {
    const once = normalizeSearchQuery({
      query: 'brunette', limit: 5, offset: 2, sortBy: 'totalSize', order: 'asc',
    });
    assert.deepEqual(normalizeSearchQuery(once), once);
  });
  api.close();
}

console.log('\n[6] 查询串清洗（FTS5 语法安全）');
{
  const api = openApi();
  const HOSTILE = ['britney AND OR NOT', '"unbalanced', 'a OR 1=1', 'NEAR(x y)', 'foo:bar', 'test*^~-', '   ', '...---...'];
  for (const q of HOSTILE) {
    check(`恶意/畸形输入不抛错：${JSON.stringify(q)}`, () => {
      if (q.trim() === '' || !/[\p{L}\p{N}]/u.test(q)) {
        assert.throws(() => api.searchMagnets({ query: q }), TypeError);
      } else {
        assert.doesNotThrow(() => api.searchMagnets({ query: q }));
      }
    });
  }
  check('空 query 抛 TypeError 而非返回全表', () => {
    assert.throws(() => api.searchMagnets({ query: '' }), TypeError);
    assert.throws(() => api.searchMagnets({}), TypeError);
  });
  api.close();
}

console.log('\n[7] 增量同步（按 last_rowid 补新行）');
{
  writeSource((src) =>
    src.prepare(
      `INSERT INTO magnets (id, name, files, totalSize, fetchedAt)
       VALUES (5, 'Trigger.Sync.Test.Name', ?, 123, 1600000000000)`
    ).run(JSON.stringify([{ path: 'Trigger.Sync.Test.Name.bin', size: 123 }]))
  );
  const api = openApi(); // 重新打开触发增量
  check('新插入的行（id=5）被增量索引并命中', () => {
    assert.equal(api.searchMagnets({ query: 'Trigger.Sync' }).items[0].id, 5);
  });
  check('源库计数已含新行', () => assert.equal(api.countMagnets(), 5));
  api.close();
}

console.log('\n[8] reindex 反映对已有行的改名 / 删除');
{
  // 改 id=5 的 name 与 files（增量不会捕获 UPDATE，需 reindex 才反映）
  writeSource((src) =>
    src
      .prepare('UPDATE magnets SET name = ?, files = ? WHERE id = 5')
      .run('Renamed.Entry.Here', JSON.stringify([{ path: 'Renamed.Entry.Here.bin', size: 123 }]))
  );
  const api = openApi();
  check('增量未捕获改名：旧词仍命中、新词未命中', () => {
    assert.equal(api.searchMagnets({ query: 'Trigger.Sync' }).total, 1);
    assert.equal(api.searchMagnets({ query: 'Renamed.Entry' }).total, 0);
  });
  await check('reindex() 全量重建后改名生效', async () => {
    const indexed = await api.reindex();
    assert.equal(indexed, 5);
    assert.equal(api.searchMagnets({ query: 'Renamed.Entry' }).items[0].id, 5);
    assert.equal(api.searchMagnets({ query: 'Trigger.Sync' }).total, 0);
  });
  api.close();

  // 删 id=5：增量同步只追加，删除需 reindex 全量重建才反映
  writeSource((src) => src.prepare('DELETE FROM magnets WHERE id = 5').run());
  const api2 = openApi();
  await api2.reindex();
  check('reindex 后源中已删除的行不再返回', () => {
    assert.equal(api2.searchMagnets({ query: 'Renamed.Entry' }).total, 0);
    assert.equal(api2.countMagnets(), 4);
  });
  api2.close();
}

console.log('\n[9] infohash 精确检索（by=hash）');
{
  const api = openApi();
  const H1 = `hash${String(1).padStart(40, '0')}`; // 与 fixture id=1 的 infohash 一致
  check('完整 infohash 命中（id=1）', () => {
    const r = api.searchMagnets({ query: H1, by: 'hash' });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, 1);
  });
  check('前缀检索匹配所有共享此前缀的行（fixture 前 20 位相同，故 4 条）', () => {
    const r = api.searchMagnets({ query: H1.slice(0, 20), by: 'hash' });
    assert.equal(r.total, 4);
    assert.ok(r.items.some((i) => i.id === 1));
  });
  check('urn:btih: 前缀形式命中', () => {
    assert.equal(api.searchMagnets({ query: `urn:btih:${H1}`, by: 'hash' }).total, 1);
  });
  check('无匹配返回空', () => {
    assert.equal(api.searchMagnets({ query: 'deadbeef'.repeat(5), by: 'hash' }).total, 0);
  });
  api.close();
}

console.log('\n[10] 热词统计（keyword_stats / topKeywords）');
{
  const api = openApi();
  check('topKeywords 返回热词且 doc_count 正确（brunette 出现在 2 个文档）', () => {
    const kw = api.topKeywords();
    assert.ok(Array.isArray(kw));
    const brunette = kw.find((k) => k.term === 'brunette');
    assert.ok(brunette, '热词表中应存在 brunette');
    assert.equal(brunette.doc_count, 2);
    assert.ok(brunette.occurrences >= 2);
  });
  check('热词不含单字符与纯数字噪声', () => {
    const kw = api.topKeywords(1000);
    assert.ok(!kw.some((k) => k.term.length < 2 || /^\d+$/.test(k.term)));
  });
  check('limit 生效（topKeywords(2) 返回 2 条）', () => {
    assert.equal(api.topKeywords(2).length, 2);
  });
  check('limit 非法值回退默认且不抛错（数据不足 50 时返回全部）', () => {
    assert.doesNotThrow(() => api.topKeywords('abc'));
    assert.ok(api.topKeywords(99999).length <= 1000);
  });
  api.close();
}

console.log('\n[11] 热词过滤（keyword_filter）');
{
  const api = openApi();
  check('默认热词包含 brunette', () => {
    assert.ok(api.topKeywords().some((k) => k.term === 'brunette'));
  });
  check('添加过滤词后 topKeywords 立即排除该词', () => {
    api.addKeywordFilter('brunette');
    assert.ok(!api.topKeywords().some((k) => k.term === 'brunette'));
    assert.ok(api.listKeywordFilters().some((f) => f.term === 'brunette'));
  });
  check('增量补录时过滤词不再累计（doc_count 保持 2）', () => {
    writeSource((src) =>
      src.prepare(
        `INSERT INTO magnets (id, name, files, totalSize, fetchedAt)
         VALUES (6, 'Brunette.Filtered.Probe', ?, 1, 1)`
      ).run(JSON.stringify([{ path: 'Brunette.Filtered.Probe.bin', size: 1 }]))
    );
    const api2 = openApi(); // 触发增量补录
    const row = api2.db.all(sql`SELECT doc_count FROM keyword_stats WHERE term = 'brunette'`)[0];
    assert.equal(Number(row?.doc_count ?? 0), 2); // 新行被过滤，仍是原 2 条
    api2.close();
  });
  check('删除过滤词后热词恢复', () => {
    api.removeKeywordFilter('brunette');
    assert.ok(api.topKeywords().some((k) => k.term === 'brunette'));
  });
  api.close();
}

console.log('\n[12] 启动同步不阻塞（sync:false）+ syncIncremental 异步补录');
{
  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: idxFor(12), sync: false });
  check('sync:false 启动不索引：countMagnets 为 0', () => {
    assert.equal(api.countMagnets(), 0);
  });
  check('sync:false 启动索引为空：搜索无命中', () => {
    assert.equal(api.searchMagnets({ query: 'brunette' }).total, 0);
  });
  const srcCount = countSource();
  const workerSteps = [];
  await check('await syncIncremental() 返回 {skipped:false, added=id跨度}', async () => {
    const r = await api.syncIncremental((p) => {
      if (p?.step && workerSteps[workerSteps.length - 1] !== p.step) workerSteps.push(p.step);
    });
    assert.equal(r.skipped, false);
    // added 是 id 跨度（max-last），源库含已删除空洞时可能 > 实际行数，故只需 >= 行数
    assert.ok(r.added >= srcCount, `added=${r.added} 应不小于实际行数 ${srcCount}`);
  });
  check('增量进度经子进程 IPC 回传到父进程（阶段名不丢）', () => {
    // 全新索引库 → 这一步实际是迁移重建，故五阶段齐全
    assert.deepEqual(workerSteps, ['schema', 'scan', 'index', 'merge', 'checkpoint']);
  });
  check('syncIncremental 后索引与源库一致（count 相等、ubuntu 命中）', () => {
    assert.equal(api.countMagnets(), srcCount);
    assert.equal(api.searchMagnets({ query: 'ubuntu' }).total, 1);
  });
  await check('无新增再 syncIncremental 返回 added=0', async () => {
    const r = await api.syncIncremental();
    assert.equal(r.skipped, false);
    assert.equal(r.added, 0);
  });
  api.close();
}

console.log('\n[13] reindex 异步化 + indexing 状态机 + 进度回传');
{
  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: idxFor(13), sync: false });
  let sawRunning = false;
  let sawProgress = false;
  const steps = [];
  const scanSamples = [];
  const nonScanWithRatio = [];
  const indexed = await api.reindex((p) => {
    if (typeof p?.done === 'number' && typeof p?.total === 'number') sawProgress = true;
    if (runtimeStats.indexing.running === true) sawRunning = true;
    if (p?.step) {
      if (steps[steps.length - 1] !== p.step) steps.push(p.step);
      if (p.step === 'scan') scanSamples.push(p);
      else if (p.scanned !== undefined || p.total !== undefined) nonScanWithRatio.push(p.step);
    }
  });
  check('reindex() 返回索引文档数（数字）', () => assert.equal(indexed, countSource()));
  check('reindex 过程中 indexing.running 被置为 true', () => assert.ok(sawRunning));
  check('reindex 回传了 done/total 进度', () => assert.ok(sawProgress));
  check('重建按顺序上报五个阶段（前端据此显示「第 N/M 步」）', () => {
    assert.deepEqual(steps, ['schema', 'scan', 'index', 'merge', 'checkpoint']);
  });
  check('扫描阶段上报 id 区间推进量，且末批到达 100%（进度条不失真的前提）', () => {
    assert.ok(scanSamples.length > 0, '未收到 scan 阶段上报');
    const last = scanSamples[scanSamples.length - 1];
    assert.equal(last.scanned, last.total, `末批 scanned=${last.scanned} total=${last.total}`);
    assert.ok(scanSamples.every((s) => s.scanned >= 0 && s.scanned <= s.total));
  });
  check('非扫描阶段不下发比例字段（避免画出失真的进度条）', () => {
    assert.deepEqual(nonScanWithRatio, [], `意外带比例的阶段：${nonScanWithRatio.join(',')}`);
  });
  check('reindex 完成后 indexing.running 复位为 false', () => {
    assert.equal(runtimeStats.indexing.running, false);
  });
  check('reindex 后索引有效（ubuntu 命中）', () => {
    assert.equal(api.searchMagnets({ query: 'ubuntu' }).total, 1);
  });
  api.close();
}

console.log('\n[14] 单实例互斥：重建进行中增量被归一化为 skipped');
{
  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: idxFor(14), sync: false });
  // 先发起 reindex（不 await），立即并行发起 syncIncremental（不 await）
  const fullP = api.reindex();
  const incP = api.syncIncremental();
  const [idx, sync] = await Promise.all([fullP, incP]);
  check('reindex 仍正常完成（返回数字）', () => assert.equal(typeof idx, 'number'));
  check('重建进行中发起的 syncIncremental 被跳过：skipped=true、added=0', () => {
    assert.equal(sync.skipped, true);
    assert.equal(sync.added, 0);
  });
  check('互斥后索引最终与源库一致（reindex 结果生效）', () => {
    assert.equal(api.countMagnets(), countSource());
  });
  api.close();
}

console.log('\n[15] 最新入库列表（listLatest，不经 FTS，固定按 id 倒序 = 表倒序）');
{
  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: idxFor(15) });
  check('固定按 id 倒序：最新入库的（id=6）在最前，总数与源库一致', () => {
    const r = api.listLatest();
    assert.equal(r.total, api.countMagnets());
    assert.equal(r.total, countSource());
    assert.deepEqual(r.items.map((i) => i.id), [6, 4, 3, 2, 1]);
  });
  check('默认每批 30 条，返回行字段与检索一致（fileCount + preview）', () => {
    const r = api.listLatest();
    assert.equal(r.limit, 30);
    assert.deepEqual(Object.keys(r.items[0]).sort(), [
      'fetchedAt', 'fileCount', 'id', 'infohash', 'magnet', 'name', 'preview', 'totalSize',
    ]);
    assert.ok(Array.isArray(r.items[0].preview));
  });
  check('limit / offset 分页取最新一段', () => {
    assert.deepEqual(api.listLatest({ limit: 2 }).items.map((i) => i.id), [6, 4]);
    assert.deepEqual(api.listLatest({ limit: 2, offset: 2 }).items.map((i) => i.id), [3, 2]);
  });
  check('排序 / 过滤参数一律不生效（该接口只做分页，注入无效）', () => {
    const r = api.listLatest({
      sortBy: 'name; DROP TABLE magnets', order: 'asc', minSize: 1, maxSize: 1,
    });
    assert.deepEqual(r.items.map((i) => i.id), [6, 4, 3, 2, 1]);
  });
  check('limit 超限钳制到 MAX_LIMIT，非数值回退默认 30', () => {
    assert.equal(api.listLatest({ limit: 99999 }).limit, MAX_LIMIT);
    assert.equal(api.listLatest({ limit: 'abc' }).limit, 30);
  });
  check('offset 超出范围返回空数组但 total 不变', () => {
    const r = api.listLatest({ offset: 999 });
    assert.deepEqual(r.items, []);
    assert.equal(r.total, countSource());
  });
  api.close();
}

console.log('\n[15b] 索引格式版本变更时，增量同步自动改跑全量重建');
{
  const index = idxFor('15b');
  // 首建一次，让格式版本落入 sync_meta
  createMagnetDb({ source: SMOKE_DB, indexDbPath: index }).close();

  // 模拟升级前的历史索引库：格式水位是个未知旧值
  {
    const w = openDatabase(index);
    w.prepare("UPDATE sync_meta SET value = 'legacy' WHERE key = 'files_format'").run();
    closeDb(w);
  }

  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: index, sync: false });
  const r = api.syncIncrementalSync();
  check('增量同步改跑全量重建，返回重建行数', () => {
    assert.ok(r.added > 0);
  });
  check('重建后格式水位回到当前版本', () => {
    const row = api.db.all(sql`SELECT value FROM sync_meta WHERE key = 'files_format'`)[0];
    assert.equal(row?.value, INDEX_FORMAT);
  });
  check('重建后 fileCount 与详情树均可用', () => {
    const item = api.searchMagnets({ query: 'sample.txt' }).items[0];
    assert.equal(item.fileCount, 2);
    assert.equal(api.getMagnetFiles(item.id).nodes.length, 3);
  });
  api.close();
}

// 放在最后一个：本段会主动制造维护失败（源库缺列），验证 reject 与状态机复位。
// 注：执行载体统一为 spawn 子进程后，原先 worker.terminate() 在 Node 退出阶段偶发的
// V8 fatal（DisposeIsolate）已消失；此处保留在末尾只为维持既有用例顺序。
console.log('\n[15c] 数据水位与数据同事务推进（断点续跑幂等的基础）');
{
  const index = idxFor('15c');
  createMagnetDb({ source: SMOKE_DB, indexDbPath: index }).close(); // 首建

  // 追加 10 行，制造一次增量
  writeSource((s) => {
    const ins = s.prepare(
      'INSERT INTO magnets (id, name, files, totalSize, fetchedAt) VALUES (?, ?, ?, 1, 1)'
    );
    for (let i = 100; i < 110; i += 1) {
      ins.run(i, `Watermark.Probe.${i}`, JSON.stringify([{ path: `Watermark.Probe.${i}.bin`, size: 1 }]));
    }
  });

  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: index, sync: false });
  const samples = [];
  const steps = [];
  const r = api.syncIncrementalSync((p) => {
    if (p?.step && steps[steps.length - 1] !== p.step) steps.push(p.step);
    // 回调有两种：阶段通知（rows=0，此刻还没有批次落库）与批次落库后的通知。
    // 水位只在后者有意义——它发生在批事务提交之后，应已随该批推进（而非等全部跑完才写一次）
    if (!(p?.rows > 0)) return;
    const row = api.db.all(sql`SELECT value FROM sync_meta WHERE key = 'last_rowid'`)[0];
    samples.push(Number(row?.value ?? 0));
  });

  check('批次回调时水位已推进（与数据同事务提交）', () => {
    assert.ok(r.added > 0, '本轮应有新增');
    assert.ok(samples.length > 0, '未触发批次回调');
    assert.ok(samples[0] >= 100, `首批回调时水位应已至少到 100，实为 ${samples[0]}`);
  });
  check('增量上报阶段序列；未执行的阶段（未达合并阈值）不上报', () => {
    assert.deepEqual(steps, ['scan', 'checkpoint']);
  });
  check('维护结束后 build_mode 归位 idle', () => {
    const row = api.db.all(sql`SELECT value FROM sync_meta WHERE key = 'build_mode'`)[0];
    assert.equal(row?.value, 'idle');
  });
  check('增量只累计 fts_pending、不触发全量合并（10 行远低于 5 万阈值）', () => {
    const row = api.db.all(sql`SELECT value FROM sync_meta WHERE key = 'fts_pending'`)[0];
    assert.equal(Number(row?.value ?? -1), 10);
  });
  api.close();
}

console.log('\n[16] 源库 schema 校验 + 维护失败传播');
{
  // 情形 0：源库文件不存在 → 必须明确报错，且绝不创建空库。
  // 路径配错时若让驱动隐式建库，会在错误位置留下 0 字节空壳，并把后续报错
  // 误导成「源库中不存在 magnets 表」，排查成本极高。
  const MISSING = path.join(DATA_DIR, 'smoke.missing.db');
  fs.rmSync(MISSING, { force: true });
  check('源库文件不存在时明确报错，且不在错误位置留下空库', () => {
    assert.throws(
      () => createMagnetDb({ source: MISSING, indexDbPath: idxFor('16m'), sync: false }),
      /源库文件不存在/
    );
    assert.equal(fs.existsSync(MISSING), false, '不应创建出 0 字节的空源库');
  });

  // 情形 1：表存在但缺列 → 打开索引库时就应给出明确错误。
  // 必须显式校验列：indexPass 只在「有内容」时才扫描（max > from 才 populate），
  // 空源库不触发扫描，靠 SQL 顺带抛错会漏检。
  // 文件名必须以 smoke 开头：cleanup() 只按该前缀通配删除，否则上一轮遗留的文件
  // 会让本轮的 CREATE TABLE 撞上「table magnets already exists」而中断整个测试。
  const BAD_COLS = path.join(DATA_DIR, 'smoke.bad-cols.db');
  {
    const s = openDatabase(BAD_COLS);
    setPragma(s, 'journal_mode', 'WAL');
    execRaw(s, 'CREATE TABLE magnets (id INTEGER PRIMARY KEY)');
    closeDb(s);
  }
  check('源库缺列时 createMagnetDb 明确报错（不静默放过）', () => {
    assert.throws(
      () => createMagnetDb({ source: BAD_COLS, indexDbPath: idxFor('16a'), sync: false }),
      /缺少列/
    );
  });

  // 情形 2：schema 正常、打开成功，但打开后源库表被移除 → 重建时查询失败，
  // 验证「维护失败 reject + 状态机复位」这条传播路径
  const BAD_SRC = path.join(DATA_DIR, 'smoke.bad-source.db');
  {
    const s = openDatabase(BAD_SRC);
    setPragma(s, 'journal_mode', 'WAL');
    execRaw(s, `CREATE TABLE magnets (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', infohash TEXT, magnet TEXT,
      files TEXT, totalSize INTEGER NOT NULL DEFAULT 0, fetchedAt INTEGER NOT NULL DEFAULT 0)`);
    execRaw(s, "INSERT INTO magnets (id, name) VALUES (1, 'probe')");
    closeDb(s);
  }
  const api = createMagnetDb({ source: BAD_SRC, indexDbPath: idxFor('16b'), sync: false });
  {
    const s = openDatabase(BAD_SRC);
    setPragma(s, 'journal_mode', 'WAL');
    execRaw(s, 'DROP TABLE magnets');
    closeDb(s);
  }
  await check('reindex() 因源库表消失而 reject', async () => {
    await assert.rejects(api.reindex());
  });
  check('失败后 indexing.running 复位为 false（不卡状态机）', () => {
    assert.equal(runtimeStats.indexing.running, false);
  });
  api.close();
}

console.log('\n[16b] 索引分段计时器（exclude 只记净耗时，各段互斥可直接相加）');
{
  const t = createIndexTimer();
  t.measure('inner', () => {
    const s = performance.now();
    while (performance.now() - s < 20); // 忙等 20ms，保证 inner 明显大于 0
  });
  // exclude 包着已计时的子段（批事务提交就是这种情况）：必须扣除子段，否则会被
  // 重复计入，而 js = 总耗时 − 已计段之和 会被算成负数再截断为 0，掩盖真实瓶颈
  t.exclude('outer', () => t.measure('inner2', () => {
    const s = performance.now();
    while (performance.now() - s < 20);
  }));
  const snap = t.snapshot();
  check('exclude 扣除内部已计时的子段（net << 子段耗时）', () => {
    assert.ok(snap.outer < snap.inner2, `outer=${snap.outer} inner2=${snap.inner2}`);
    assert.ok(snap.outer < 10, `outer=${snap.outer}`);
  });
  check('各段互斥：已计段之和不超过总耗时，未归类 js 非负', () => {
    const sum = snap.inner + snap.inner2 + snap.outer;
    assert.ok(sum <= snap.totalMs + 1, `sum=${sum} total=${snap.totalMs}`);
    assert.ok(snap.js >= 0);
  });
}

console.log('\n[18] 旧格式索引库的升级路径（补列 → 降级可查 → 重建修正）');
{
  const index = idxFor(18);
  createMagnetDb({ source: SMOKE_DB, indexDbPath: index }).close(); // 先有一个 v2 索引

  // 退回 v1 形态：删掉新增列、把格式水位改成旧值
  {
    const w = openDatabase(index);
    execRaw(w, 'ALTER TABLE magnets_docs DROP COLUMN fileCount');
    execRaw(w, "UPDATE sync_meta SET value = 'flat-parent/1' WHERE key = 'files_format'");
    closeDb(w);
  }

  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: index, sync: false });
  check('旧库打开时补齐缺失列（否则查询会 no such column）', () => {
    const raw = api.db.$client ?? api.db.session?.client;
    const cols = allRows(raw, 'PRAGMA table_info(magnets_docs)').map((r) => r.name);
    assert.ok(cols.includes('fileCount'), `实际列：${cols.join(',')}`);
  });
  check('旧库被判定为需要重建（HTTP 层据此跑启动迁移）', () => {
    assert.equal(api.indexNeedsRebuild(), true);
  });
  check('重建完成前仍可检索（降级服务：新列取默认值）', () => {
    const item = api.searchMagnets({ query: 'sample.txt' }).items[0];
    assert.equal(item.id, 2);
    assert.equal(item.fileCount, 0);
  });
  await check('迁移重建可正常完成', async () => {
    await api.reindex();
  });
  check('重建后 fileCount 修正、格式水位回到当前版本', () => {
    assert.equal(api.indexNeedsRebuild(), false);
    assert.equal(api.searchMagnets({ query: 'sample.txt' }).items[0].fileCount, 2);
  });
  api.close();
}

// ⚠ 本段会 DROP 掉 smoke 源库的表，因此必须放在最后（其后不得再有依赖 SMOKE_DB 的用例）
console.log('\n[17] 影子库：重建成功则原子切换，失败则线上索引毫发无损');
{
  const index = idxFor(17);
  const api = createMagnetDb({ source: SMOKE_DB, indexDbPath: index });
  const before = api.searchMagnets({ query: 'brunette' }).total;
  check('首建后可检索', () => assert.ok(before > 0));

  // 1) 成功路径：重建写影子库 → 切换 → 无残留、内容一致
  await check('重建成功并完成原子切换', async () => {
    const n = await api.reindex();
    assert.ok(n > 0);
  });
  check('切换后无影子库 / 备份残留', () => {
    assert.equal(fs.existsSync(`${index}.build`), false, '影子库未清理');
    assert.equal(fs.existsSync(`${index}.old`), false, '备份未清理');
  });
  check('切换后检索结果与切换前一致', () => {
    assert.equal(api.searchMagnets({ query: 'brunette' }).total, before);
  });
  check('子进程的分段耗时经 IPC 回传到主进程（日志/SSE 才有数据）', () => {
    const p = runtimeStats.indexing.phases;
    assert.ok(p && Number(p.totalMs) > 0, `phases=${JSON.stringify(p)}`);
    assert.ok(Number(p.fts) >= 0 && Number(p.docs) >= 0);
  });

  // 2) 失败路径：源库表消失 → 重建失败，线上索引必须完好（这正是影子库的意义）
  writeSource((s) => execRaw(s, 'DROP TABLE magnets'));
  await check('源库被破坏后重建 reject', async () => {
    await assert.rejects(api.reindex());
  });
  check('失败后线上索引仍完好（检索结果不变）', () => {
    assert.equal(api.searchMagnets({ query: 'brunette' }).total, before);
  });
  check('失败不留影子库残留（半成品已丢弃）', () => {
    assert.equal(fs.existsSync(`${index}.build`), false);
  });
  api.close();
}

cleanup();
console.log(`\n全部 ${passed} 项断言通过。`);
