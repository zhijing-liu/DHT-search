/**
 * 纯压缩：把 dist/ 按完整结构打成 release/DHT-Search-<版本号>.zip
 * ------------------------------------------------------------------
 * 只做压缩，不做构建（构建请先执行 `npm run build:exe`）。
 *   用法：npm run pack:zip ；产物：release/DHT-Search-v<版本号>.zip
 *
 * zip 内含顶层目录 DHT-Search/，空目录也会写入条目，全部内容按 deflate 压缩：Bun 编译产物
 * 虽是二进制，实测仍可压到 46.7%（zip 83.6 MB → 39.0 MB，约 −53%），故不跳过压缩。
 * data/ 下运行时产生的数据库 / WAL / SHM 一律不入包。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');
const ZIP_ROOT = 'DHT-Search'; // zip 内的顶层目录名

const exeName = process.platform === 'win32' ? 'DHT-Search.exe' : 'DHT-Search';
if (!fs.existsSync(path.join(DIST, exeName))) {
  console.error(`[pack] dist/ 里没有 ${exeName} —— 请先执行 npm run build:exe`);
  process.exit(1);
}

// 版本号优先取 DHT_PACK_VERSION（CI 发版工作流由 tag 注入，保证 zip 名与 Release 版本一致），
// 本地直接运行则回退到 package.json 的 version
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const effectiveVersion = process.env.DHT_PACK_VERSION ?? version;
const zipName = `DHT-Search-v${effectiveVersion}.zip`;
fs.mkdirSync(RELEASE, { recursive: true });
const outPath = path.join(RELEASE, zipName);
if (fs.existsSync(outPath)) fs.rmSync(outPath);

console.log(`[pack] 压缩 dist/ → release/${zipName} ...`);
// archiver v8 起改为类 API：new ZipArchive(options)；旧 v7 是 archiver('zip', options) 函数
const { ZipArchive } = await import('archiver');
const output = fs.createWriteStream(outPath);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
});
archive.pipe(output);

// data/ 下是运行时产生的 SQLite 库（主文件 + WAL/SHM/journal）：属本机私有状态，
// 且 -wal/-shm 是进程态文件，本就不该分发。本地反复构建时它们会残留在 dist/data/，
// 统一在此排除，保证发布包内只留一个空的 data/ 目录（运行时自建）。
const RUNTIME_DATA_RE = /\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$/i;
const isRuntimeData = (relPath) => relPath.startsWith('data/') && RUNTIME_DATA_RE.test(relPath);
let skippedData = 0;

/** 递归收集 dist 下所有文件与目录，zip 内统一挂在 DHT-Search/ 顶层目录下 */
function addDir(dir, rel = '') {
  let hasContent = false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (addDir(abs, relPath)) hasContent = true;
      continue;
    }
    // 运行时数据不入包（见上方 RUNTIME_DATA_RE 注释）
    if (isRuntimeData(relPath)) {
      skippedData += 1;
      continue;
    }
    archive.file(abs, { name: `${ZIP_ROOT}/${relPath}` });
    hasContent = true;
  }
  // 空目录不会随文件进 zip：显式写目录条目，保证解压后结构完整（如空的 data/）
  if (!hasContent && rel) archive.append('', { name: `${ZIP_ROOT}/${rel}/` });
  return hasContent;
}
addDir(DIST);
if (skippedData > 0) {
  console.log(`[pack] 已排除 data/ 下 ${skippedData} 个运行时数据文件（数据库 / WAL / SHM）`);
}

await archive.finalize();
await done;

const sizeMb = (fs.statSync(outPath).size / 1048576).toFixed(1);
console.log(`[pack] 完成: release/${zipName}（${sizeMb} MB）`);
