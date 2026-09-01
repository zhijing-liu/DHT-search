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
import { createMagnetDb, MAX_LIMIT } from './db.js';
import { openDatabase, setPragma, execRaw, closeDb } from './db-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_DB = path.join(HERE, 'data', 'smoke.db');
const SMOKE_INDEX = path.join(HERE, 'data', 'smoke.search.db');

const cleanup = () => {
  for (const f of [SMOKE_DB, SMOKE_INDEX]) {
    for (const s of ['', '-wal', '-shm']) {
      // best-effort：Windows 上偶发文件锁未释放，忽略以免影响最终断言汇总
      try {
        fs.rmSync(f + s, { force: true });
      } catch {
        /* 文件可能被运行时短暂锁定，忽略 */
      }
    }
  }
};
cleanup();

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
  check('files 被解析为对象数组', () => {
    const r = api.searchMagnets({ query: 'sample.txt' });
    assert.ok(Array.isArray(r.items[0].files));
    assert.equal(r.items[0].files.length, 2);
    assert.equal(r.items[0].files[1].path, 'Sample/sample.txt');
    assert.equal(r.items[0].files[1].size, 1024);
  });
  check('返回行包含全部字段', () => {
    const r = api.searchMagnets({ query: 'brit' });
    assert.deepEqual(Object.keys(r.items[0]).sort(), [
      'fetchedAt', 'files', 'id', 'infohash', 'magnet', 'name', 'totalSize',
    ]);
    assert.equal(r.items[0].magnet, 'magnet:?xt=urn:btih:hash' + '1'.padStart(40, '0'));
    assert.equal(r.items[0].totalSize, 336295318);
    assert.equal(r.items[0].fetchedAt, 1788072693739);
  });
  api.close();
}

console.log('\n[3] files 解析失败时保留原始字符串');
{
  // 改的是已有行，增量同步不会捕获 UPDATE，需 reindex 全量重建后才会反映
  writeSource((src) => src.prepare('UPDATE magnets SET files = ? WHERE id = 3').run('not-a-json'));
  const api = openApi();
  await api.reindex();
  const r = api.searchMagnets({ query: 'ubuntu' });
  assert.equal(r.items[0].files, 'not-a-json');
  api.close();
  writeSource((src) =>
    src.prepare('UPDATE magnets SET files = ? WHERE id = 3').run(JSON.stringify(FIXTURES[2].files))
  );
}

console.log('\n[4] 排序');
{
  const api = openApi();
  check('不传 sortBy 时按 id 升序', () => {
    const r = api.searchMagnets({ query: 'brunette' });
    assert.deepEqual(r.items.map((i) => i.id), [1, 4]);
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
  check('非法 sortBy 回退为按 id 排序', () => {
    const r = api.searchMagnets({ query: 'brunette', sortBy: 'name; DROP TABLE magnets' });
    assert.deepEqual(r.items.map((i) => i.id), [1, 4]);
  });
  api.close();
}

console.log('\n[5] 分页');
{
  const api = openApi();
  check('limit=1 / offset=0 取第一条', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 1, offset: 0 });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, 1);
    assert.equal(r.total, 2);
  });
  check('limit=1 / offset=1 取第二条', () => {
    const r = api.searchMagnets({ query: 'brunette', limit: 1, offset: 1 });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, 4);
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

cleanup();
console.log(`\n全部 ${passed} 项断言通过。`);
