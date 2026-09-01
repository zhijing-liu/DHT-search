/**
 * pm2 启动配置 —— Node 运行时
 * 用 Node + better-sqlite3 启动 DHT Search。
 * 端口等运行参数全部走 config.json，不在 pm2 中硬编码。
 * 用法：pm2 start ecosystem.config.node.cjs
 */
module.exports = {
  apps: [
    {
      name: 'dht-search-node',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'node',
    },
  ],
};
