#!/usr/bin/env node
/**
 * 重置应用：删除索引库及其衍生文件，可选删除源库
 * ------------------------------------------------------------------
 * 默认只清「可再生成」的东西：索引库本身、构建中的影子库（.build）、切换备份（.old），
 * 以及各自的 WAL / SHM 伴生文件。源库（爬虫数据）默认不动 —— 它删了就没了。
 *
 * 用法：
 *   npm run reset                      # 删索引库与衍生文件（幂等）
 *   npm run reset -- --dry-run         # 只列出将删除的文件，不实际删除
 *   npm run reset -- --source --yes     # 连源库一起删（必须显式 --yes）
 *   npm run reset -- --tests           # 顺带清空 test/data（测试夹具，会自动重建）
 *
 * 路径来源：DHT_INDEX_DB_PATH / DHT_DB_PATH 环境变量优先，否则取 config.js。
 * 只依赖 Node 内置模块（不加载 SQLite 驱动），依赖装坏时同样可运行。
 * 服务运行中执行会因文件被占用而失败（脚本会明确指出，退出码 1），请先停止服务。
 * 索引库删除后下次启动会自动重建（全量灌入，耗时取决于源库规模）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_DB_PATH, INDEX_DB_PATH } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TEST_DATA = path.join(ROOT, 'test', 'data');

// 只读 config.js 自行解析路径，不引入 store.js：那个模块会拉起 SQLite 原生驱动，
// 而本脚本只删文件——依赖装坏时也应能跑
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const withSource = args.includes('--source');
const withTests = args.includes('--tests');
const confirmed = args.includes('--yes') || args.includes('-y');

/** 索引库路径（服务实际使用的那个）：环境变量优先，否则取 config.js */
const indexPath = path.resolve(process.env.DHT_INDEX_DB_PATH || resolvePath(INDEX_DB_PATH));
/** 源库路径：同上 */
const sourcePath = path.resolve(process.env.DHT_DB_PATH || resolvePath(SOURCE_DB_PATH));

/** SQLite 库的伴生文件后缀：主库 / WAL / SHM */
const DB_SUFFIXES = ['', '-wal', '-shm'];
/** 索引库的衍生基名：本体 + 重建中的影子库 + 切换备份 */
const INDEX_BASES = (p) => [p, `${p}.build`, `${p}.old`];

/** 人类可读体积 */
function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 按「基名 + 后缀」收集实际存在的文件 */
function collect(bases) {
  const out = [];
  for (const base of bases) {
    for (const suffix of DB_SUFFIXES) {
      const file = base + suffix;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // 不存在即跳过
      }
      if (st.isFile()) out.push({ file, size: st.size, dir: false });
    }
  }
  return out;
}

/** 列出 test/data 下的一级条目（测试自建夹具，清掉后各测试会重新生成） */
function collectTestData() {
  let entries;
  try {
    entries = fs.readdirSync(TEST_DATA);
  } catch {
    return []; // 目录不存在即跳过
  }
  return entries.map((name) => {
    const file = path.join(TEST_DATA, name);
    const st = fs.statSync(file);
    return { file, size: st.isDirectory() ? 0 : st.size, dir: st.isDirectory() };
  });
}

/** 逐个删除；返回失败清单（服务运行中时 Windows 会因占用而拒绝） */
function removeAll(items) {
  const failed = [];
  for (const item of items) {
    try {
      fs.rmSync(item.file, { force: true, recursive: item.dir });
    } catch (err) {
      failed.push({ file: item.file, reason: err.code || err.message });
    }
  }
  return failed;
}

// 配置错误防护：两者指向同一文件时，--source 会把索引一起当成源库删掉
if (indexPath === sourcePath) {
  console.error(`✗ 索引库与源库路径相同（${indexPath}），配置有误，已停止`);
  process.exit(1);
}

const indexFiles = collect(INDEX_BASES(indexPath));
const sourceFiles = collect([sourcePath]);
const testItems = withTests ? collectTestData() : [];

if (withSource && !confirmed) {
  console.log('将删除的文件（含源库）：');
  for (const f of [...indexFiles, ...sourceFiles]) console.log(`  ${human(f.size).padStart(9)}  ${f.file}`);
  console.error('\n✗ 源库是爬取数据，删除后无法恢复。确认要删请显式加 --yes：');
  console.error('  npm run reset -- --source --yes');
  process.exit(1);
}

const targets = withSource ? [...indexFiles, ...sourceFiles] : indexFiles;

if (targets.length === 0 && testItems.length === 0) {
  console.log('没有需要清理的文件（索引库不存在，可能已经重置过）');
  process.exit(0);
}

console.log(dryRun ? '将要删除：' : '清理：');
for (const f of targets) console.log(`  ${human(f.size).padStart(9)}  ${f.file}`);
for (const t of testItems) console.log(`  ${(t.dir ? '（目录）' : human(t.size)).padStart(9)}  ${t.file}`);

if (dryRun) {
  console.log('\n--dry-run：未实际删除');
  process.exit(0);
}

const failed = removeAll([...targets, ...testItems]);
const removed = targets.length + testItems.length - failed.length;

console.log(`\n已删除 ${removed} 项${withSource ? '（含源库）' : ''}`);
if (!withSource && sourceFiles.length > 0) {
  console.log(`源库未删除：${sourcePath}`);
  console.log('如需连源库一起删：npm run reset -- --source --yes');
}
if (indexFiles.length > 0) {
  console.log('索引库已清空：下次启动会自动重建（全量灌入，耗时取决于源库规模）');
}

if (failed.length > 0) {
  console.error(`\n✗ 有 ${failed.length} 个文件删除失败（服务正在运行？请先停止服务再执行）：`);
  for (const f of failed) console.error(`  ${f.reason}  ${f.file}`);
  process.exit(1);
}
