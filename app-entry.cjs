/**
 * pm2 入口包装器（CommonJS）
 * ------------------------------------------------------------------
 * pm2 的 fork 容器通过 require() 加载入口脚本，而本项目 index.js 是 ESM
 * （package.json 的 "type": "module"），bun / node 的 require() 都无法直接
 * 加载 ESM 模块。因此这里用一个 CommonJS 文件让 pm2 去 require，再在内部
 * 用动态 import() 加载真正的 ESM 入口 index.js，绕开 pm2 的这一限制。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import(pathToFileURL(path.join(__dirname, 'index.js')).href).catch(async (err) => {
  let prefix = '[entry] 启动 index.js 失败：';
  try {
    const chalk = (await import('chalk')).default;
    prefix = chalk.red('✖') + ' ' + chalk.red('[entry] 启动 index.js 失败：');
  } catch {
    /* chalk 不可用则退化为纯文本 */
  }
  console.error(prefix, err);
  process.exit(1);
});
