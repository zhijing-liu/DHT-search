/**
 * pm2 启动配置 —— Node 运行时
 * 用 Node + better-sqlite3 启动 DHT Search。
 * 用法：pm2 start ecosystem.config.node.cjs
 */
module.exports = {
  apps: [
    {
      name: 'dht-search-node',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
