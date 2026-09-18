/**
 * 单文件 exe 构建脚本（bun build --compile 的编译与收尾步骤）
 * ------------------------------------------------------------------
 * 完整的 build:exe 在 package.json 中用 `&&` 串联两步（前端构建 + 本脚本），本脚本职责：
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

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUTFILE = process.platform === 'win32' ? 'DHT-Search.exe' : 'DHT-Search';
const CONFIG = path.join(ROOT, 'config.js');

/* 0. 保证打包器能解析 config.js ------------------------------------ */
// src/settings.js 里的 `await import('../config.js')` 是**字面量**动态导入：bun build
// --compile 在编译期要求该文件存在，否则直接 `Could not resolve: "../config.js"` 失败。
// config.js 是本地私有配置（.gitignore 排除），
// 干净检出（CI / 首次 clone）没有它 —— 这里用公共模板临时补一份，编译结束（含失败退出）
// 再删掉。于是 exe 内始终带一份「内置默认配置」，删掉 exe 旁边的 config.js 也能裸跑。
const tempConfig = !fs.existsSync(CONFIG);
if (tempConfig) {
  fs.copyFileSync(path.join(ROOT, 'config.example.js'), CONFIG);
  console.log('[build-exe] 未找到 config.js：已用 config.example.js 临时补一份（编译后删除）');
  process.on('exit', () => {
    try {
      fs.rmSync(CONFIG, { force: true });
      console.log('[build-exe] 已删除临时 config.js（保持工作区与干净检出一致）');
    } catch {
      /* 删不掉也不影响产物（config.js 已被 .gitignore 排除） */
    }
  });
}

/* 1. bun 打包（前端构建已由 package.json 的 && 链先行完成） ---------- */
fs.mkdirSync(DIST, { recursive: true });
const args = [
  'build',
  path.join(ROOT, 'exe-entry.js'),
  '--compile',
  // 压缩应用侧代码。收益有限（实测 83.52 → 83.08 MB）是因为产物约 98% 是 Bun 运行时本体
  // （空 hello-world 编译即 82.1 MB），但编译耗时无增加，故默认开启。
  '--minify',
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
  console.error('[build-exe] 找不到 public/ —— build:web 是否已执行？（package.json 的 build:exe 已用 && 链在其前）');
  process.exit(1);
}
fs.rmSync(path.join(DIST, 'public'), { recursive: true, force: true });
fs.cpSync(PUBLIC, path.join(DIST, 'public'), { recursive: true });
console.log('[build-exe] 已同步 public/ → dist/public/');

/* 3. 外置配置 / 说明文档 / 空数据目录 ------------------------------ */
// config.js 为本地私有配置（gitignore），干净检出时可能不存在；
// 缺失时回退到 config.example.js（公共默认），保证 CI 构建仍可产出 dist/config.js
const cfgSrc = fs.existsSync(path.join(ROOT, 'config.js')) ? 'config.js' : 'config.example.js';
fs.copyFileSync(path.join(ROOT, cfgSrc), path.join(DIST, 'config.js'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(DIST, 'README.md'));
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

const sizeMb = (fs.statSync(path.join(DIST, OUTFILE)).size / 1048576).toFixed(1);
console.log(`\n[build-exe] 完成: dist/${OUTFILE}（${sizeMb} MB）`);
console.log('[build-exe] dist/: exe + config.js + README.md + public/ + data/');
console.log('[build-exe] 打 zip 发布包请执行: npm run pack:zip');
