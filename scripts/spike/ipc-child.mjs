/**
 * IPC 实时性子进程（spike 试验脚本）
 * ------------------------------------------------------------------
 * 每 100ms 向父进程发一条进度消息，共 10 条，然后退出。
 * 父进程（ipc-parent.mjs）用 process.execPath 拉起本文件，因此同一对脚本
 * 可以分别在 Node 与 Bun 下运行，用来验证「spawn + ipc 的消息是否实时冲刷」。
 *
 * 判定标准：
 *   - 实时：父进程侧看到 +100ms / +200ms / ... 递增到达
 *   - 积压：消息全部在子进程退出前后一次性到达（这不是我们要的实现）
 */
if (process.argv.includes('--ipc-child')) {
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    process.send?.({ type: 'progress', i });
    if (i >= 10) {
      clearInterval(timer);
      // 留一点时间让最后一帧冲刷，再自行退出
      setTimeout(() => process.exit(0), 100);
    }
  }, 100);
}
