/**
 * worker 子进程的命令行启动标记（父进程与执行体共用的唯一事实来源）
 * ------------------------------------------------------------------
 * 源码态：父进程 fork 磁盘上的执行体文件并附加标记；
 * 编译态（bun build --compile）：磁盘上没有执行体文件，父进程 spawn exe 自身
 * 并附加同样的标记 —— 两种方式的 IPC 消息协议完全一致。
 * 执行体内部以「命令行是否含标记」判断自己是否该进入 worker 形态，
 * 被普通 import（如 exe 打包入口静态引入）时守卫不通过、无副作用。
 */
export const INDEX_WORKER_FLAG = '--dht-index-worker';
export const SEARCH_WORKER_FLAG = '--dht-search-worker';
