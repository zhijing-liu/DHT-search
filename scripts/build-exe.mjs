/**
 * 单文件 exe 构建脚本（bun build --compile 的编译与收尾步骤）
 * ------------------------------------------------------------------
 * 完整的 build:exe 在 package.json 中用 `&` 串联两步（前端构建 + 本脚本），本脚本职责：
 *   1. bun build --compile → dist/DHT-Search.exe（内含后端与两个执行体，前端资源不进 exe）
 *   2. public/ → dist/public/（前端静态资源随目录分发）
 *   3. 复制外置 config.js / README.md（config 运行时优先读 exe 同目录这份）
 *   4. 创建空 data/（已存在则原样保留）
 *
 * 压缩发布包另行执行 `npm run pack:zip`。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUTFILE = process.platform === 'win32' ? 'DHT-Search.exe' : 'DHT-Search';

/* 1. bun 打包（前端构建已由 package.json 的 & 链先行完成） ---------- */
fs.mkdirSync(DIST, { recursive: true });
const args = [
  'build',
  path.join(ROOT, 'exe-entry.js'),
  '--compile',
  '--outfile', path.join(DIST, OUTFILE),
  // 注：better-sqlite3 / drizzle-orm/better-sqlite3（Node 专用依赖）不需要也不应
  // 标记 external —— db-driver.js 已把这两个包名改为运行时拼接（编译态打包器无法
  // 分析、运行时在 isBun 下永不触达）；字面量 + external 反而会让 exe 启动时
  // 尝试解析不存在的包而直接失败。
];
console.log('[build-exe] bun build --compile ...');
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) process.exit(r.status ?? 1);

/* 2. public → dist/public（前端构建产物在仓库根 public/） ---------- */
const PUBLIC = path.join(ROOT, 'public');
if (!fs.existsSync(PUBLIC)) {
  console.error('[build-exe] 找不到 public/ —— build:web 是否已执行？（package.json 的 build:exe 已用 & 链在其前）');
  process.exit(1);
}
fs.rmSync(path.join(DIST, 'public'), { recursive: true, force: true });
fs.cpSync(PUBLIC, path.join(DIST, 'public'), { recursive: true });
console.log('[build-exe] 已同步 public/ → dist/public/');

/* 3. 外置配置 / 说明文档 / 空数据目录 ------------------------------ */
fs.copyFileSync(path.join(ROOT, 'config.js'), path.join(DIST, 'config.js'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(DIST, 'README.md'));
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

const sizeMb = (fs.statSync(path.join(DIST, OUTFILE)).size / 1048576).toFixed(1);
console.log(`\n[build-exe] 完成: dist/${OUTFILE}（${sizeMb} MB）`);
console.log('[build-exe] dist/: exe + config.js + README.md + public/ + data/');
console.log('[build-exe] 打 zip 发布包请执行: npm run pack:zip');
