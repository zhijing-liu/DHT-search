/**
 * pm2 启动配置 —— Bun 运行时
 * 用 Bun + bun:sqlite 启动 DHT Search（要求 bun 在 PATH 中）。
 * 用法：pm2 start ecosystem.config.bun.cjs
 */
module.exports = {
  apps: [
    {
      name: 'dht-search-bun',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'bun',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
