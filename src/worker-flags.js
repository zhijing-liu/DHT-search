/**
 * 子进程执行体的命令行启动标记（父进程与执行体共用的唯一事实来源）
 * ------------------------------------------------------------------
 * 父进程派生时把标记追加到命令行；执行体据此判断自己是否该进入执行体形态
 * （被普通 import 时守卫不通过、无副作用）。源码态与编译态的派生方式见 child-process.js。
 */
export const INDEX_WORKER_FLAG = '--dht-index-worker';
export const SEARCH_WORKER_FLAG = '--dht-search-worker';
