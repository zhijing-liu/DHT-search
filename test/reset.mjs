/**
 * 重置脚本（scripts/reset.mjs）行为测试
 * ------------------------------------------------------------------
 * 重点锁住两条安全属性：默认不碰源库、删源库必须显式 --yes。
 * 全程经 DHT_INDEX_DB_PATH / DHT_DB_PATH 把两个库指向 test/data 下的临时路径，
 * **绝不触碰真实的 data/**。
 *
 * 用法：node test/reset.mjs（或 npm run test:reset）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'reset.mjs');
const DIR = path.join(HERE, 'data', 'reset-case');
const IDX = path.join(DIR, 'idx.db');
const SRC = path.join(DIR, 'src.db');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${err?.message ?? err}`);
  }
}

/** 以指定参数运行重置脚本；两个库路径经环境变量指向临时目录 */
function run({ index = IDX, source = SRC } = {}, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, DHT_INDEX_DB_PATH: index, DHT_DB_PATH: source },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 索引库本体 + 影子库/备份 + 各自的 WAL/SHM，以及源库本体与 WAL */
const INDEX_FILES = ['idx.db', 'idx.db-wal', 'idx.db-shm', 'idx.db.build', 'idx.db.build-wal', 'idx.db.old'];
const SOURCE_FILES = ['src.db', 'src.db-wal'];
function seed() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [...INDEX_FILES, ...SOURCE_FILES]) fs.writeFileSync(path.join(DIR, f), 'x');
}
const exists = (name) => fs.existsSync(path.join(DIR, name));

console.log('\n[1] --dry-run 只列出、不删除');
seed();
check('列出索引库与衍生文件（含 .build / .old），且一个都不删', () => {
  const r = run({}, '--dry-run');
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('idx.db.build-wal'), '应列出 .build 的 WAL');
  assert.ok(r.out.includes('idx.db.old'), '应列出 .old 备份');
  assert.ok([...INDEX_FILES, ...SOURCE_FILES].every(exists), 'dry-run 不应删除任何文件');
});

console.log('\n[2] 默认：只清索引侧，源库不动');
check('索引库与衍生文件删净、源库与其 WAL 保留', () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(!INDEX_FILES.some(exists), `索引侧未删净：${INDEX_FILES.filter(exists).join(',')}`);
  assert.ok(SOURCE_FILES.every(exists), '源库不应被删');
  assert.ok(r.out.includes('源库未删除'), '应提示源库未删除');
});

console.log('\n[3] 删源库必须显式确认');
check('--source 未加 --yes：退出码 1 且源库仍在', () => {
  const r = run({}, '--source');
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('--yes'), '应提示需要 --yes');
  assert.ok(exists('src.db'), '未确认时源库被误删');
});
check('--source --yes：源库与其 WAL 一并删除', () => {
  const r = run({}, '--source', '--yes');
  assert.equal(r.code, 0);
  assert.ok(!SOURCE_FILES.some(exists), '源库未删净');
});

console.log('\n[4] 边界');
check('无文件可删时正常退出（幂等）', () => {
  const r = run();
  assert.equal(r.code, 0);
});
check('索引库与源库同路径时拒绝执行', () => {
  const r = run({ index: IDX, source: IDX });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('配置有误'), '应报告配置错误');
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\nreset: ${passed} 项断言通过${failed ? `，${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
