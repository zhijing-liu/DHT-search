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

import(pathToFileURL(path.join(__dirname, 'index.js')).href).catch((err) => {
  console.error('[entry] 启动 index.js 失败：', err);
  process.exit(1);
});
