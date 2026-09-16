/**
 * 统一的子进程派生入口
 * ------------------------------------------------------------------
 * 全部执行体都用 `spawn(process.execPath, [...])` + `stdio: 'ipc'` 派生：源码态传
 * 「入口脚本 + 启动标记」，编译态（bun build --compile）磁盘上没有脚本，改为传 exe
 * 自身 + 标记，由执行体的命令行守卫自拉起（见 src/worker-flags.js）。
 *
 * 堆上限的表达按运行时区分：Node 用 --max-old-space-size=<MB>，Bun 用 --smol（无硬上限）。
 */
import { spawn } from 'node:child_process';
import { isBun, isCompiledExe } from './db-driver.js';

/** 默认 stdio：stdout/stderr 继承父进程（避免 pipe 无人读而写满卡死），并带 ipc */
const DEFAULT_STDIO = ['ignore', 'inherit', 'inherit', 'ipc'];

/**
 * 派生一个执行体子进程。
 *
 * @param {object} opts
 * @param {string} opts.entryPath  源码态要执行的脚本绝对路径（编译态忽略）
 * @param {string} opts.flag       启动标记（worker-flags.js 里的常量），执行体据此自拉起
 * @param {object} [opts.env]      子进程环境变量，默认继承父进程
 * @param {number} [opts.heapMb]   堆上限（MB）；0 = 不限制
 * @param {string[]} [opts.stdio]  stdio 配置，默认 [ignore, inherit, inherit, ipc]
 * @returns {import('node:child_process').ChildProcess} 已挂上 ipc 通道的子进程
 */
export function spawnChild({ entryPath, flag, env = process.env, heapMb = 0, stdio = DEFAULT_STDIO }) {
  const args = [];
  const heap = Number(heapMb);
  if (Number.isFinite(heap) && heap > 0) {
    args.push(isBun ? '--smol' : `--max-old-space-size=${Math.trunc(heap)}`);
  }
  // 源码态：运行时 + 脚本 + 标记；编译态：exe 自拉起，只需标记
  if (!isCompiledExe) args.push(entryPath);
  args.push(flag);

  return spawn(process.execPath, args, { stdio, env });
}
