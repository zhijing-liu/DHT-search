/**
 * pm2 启动配置 —— Bun 运行时
 * 用 Bun + bun:sqlite 启动 DHT Search（要求 bun 在 PATH 中）。
 * 端口等运行参数全部走 config.json，不在 pm2 中硬编码。
 * 用法：pm2 start ecosystem.config.bun.cjs
 */
module.exports = {
  apps: [
    {
      name: 'dht-search-bun',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'bun',
    },
  ],
};
