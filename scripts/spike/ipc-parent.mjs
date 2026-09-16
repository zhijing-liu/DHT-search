/**
 * IPC 实时性父进程（spike 试验脚本）
 * ------------------------------------------------------------------
 * 用 process.execPath + 脚本路径 spawn 子进程（带 ipc 通道）——这正是「统一执行载体」
 * 提案里唯一的派生方式。同一脚本在两种运行时下各跑一次，用于对比：
 *   node scripts/spike/ipc-parent.mjs
 *   bun  scripts/spike/ipc-parent.mjs
 *
 * 打印每条消息的到达时刻；若出现「所有消息集中在末尾」，说明该运行时的 IPC 会积压，
 * 就不能作为索引进度上报的载体（进度条会卡在第一批）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./ipc-child.mjs', import.meta.url));
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;

console.log(`[${runtime}] spawn: ${process.execPath} ${CHILD} --ipc-child`);

const t0 = Date.now();
const child = spawn(process.execPath, [CHILD, '--ipc-child'], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

let count = 0;
const arrivals = [];
child.on('message', (msg) => {
  count += 1;
  const at = Date.now() - t0;
  arrivals.push(at);
  console.log(`  +${String(at).padStart(5)}ms  ${JSON.stringify(msg)}`);
});

child.on('exit', (code) => {
  const at = Date.now() - t0;
  const span = arrivals.length > 1 ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
  console.log(`exit code=${code} at +${at}ms；收到 ${count}/10 条消息，首末跨时 ${span}ms`);
  // 10 条消息每 100ms 一条：实时到达时首末跨时约 900ms；积压时接近 0
  console.log(span > 500 ? '判定：IPC 实时（消息随发随到）' : '判定：IPC 积压（消息集中在退出前才到达）');
});
