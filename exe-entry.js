/**
 * 单文件 exe 打包入口（bun build --compile，构建脚本见 scripts/build-exe.mjs）
 * ------------------------------------------------------------------
 * 一个 exe 承担三种运行形态，由命令行参数区分：
 *   - 裸启动               → 常规检索服务（index.js）
 *   - --dht-index-worker   → 索引维护子进程（重建 / 增量同步；参数经
 *                            DHT_REINDEX_JOB 环境变量传入，进度/结果走 IPC）
 *   - --dht-search-worker  → 检索子进程（按 IPC 消息逐条执行查询）
 *
 * 源码态下两个 worker 执行体是磁盘上的独立文件（fork 拉起）；编译后磁盘上只剩
 * 一个 exe，父进程统一改为 spawn(exe 自身, [flag]) 自拉起（见 db.js / searchPool.js）。
 * 三个分支都是「字面量动态 import」——bun 打包器会把它们全部打进产物，
 * 但运行时只会真正加载命中的那一支：worker 形态下 index.js 不被加载，
 * 子进程不会起 HTTP 服务。
 */
import { INDEX_WORKER_FLAG, SEARCH_WORKER_FLAG } from './src/worker-flags.js';

const argv = process.argv.slice(2);
if (argv.includes(INDEX_WORKER_FLAG)) {
  await import('./src/reindex-worker.js');
} else if (argv.includes(SEARCH_WORKER_FLAG)) {
  await import('./src/search-child.mjs');
} else {
  await import('./index.js');
}
