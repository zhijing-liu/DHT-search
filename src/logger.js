/**
 * 统一控制台输出：chalk 配色 + Emoji 图标。
 * ------------------------------------------------------------------
 * 所有运行时日志（index.js / db.js / searchPool.js / app-entry.cjs）都走这里，
 * 保证「图标 + 颜色 + 标签」三要素一致，避免各处散落的 console.* 风格漂移。
 *
 * 图标统一使用 Emoji 块字符（在主流终端里通常是双宽），因此图标后只跟 1 个空格，
 * 即可让 [SYSTEM] / [USER] / [cache] 这些标签列自然对齐。
 */
import chalk from 'chalk';
import { execSync } from 'node:child_process';

// Windows 控制台默认代码页为 GBK(CP936)，会把 Node 以 UTF-8 写出的中文当成 GBK
// 解码，导致日志里的中文乱码（如「鏀跺埌」）。首次加载即切到 UTF-8(CP65001)，
// 让控制台按 UTF-8 解码 stdout 字节。非 Windows 或切换失败（服务/无控制台态）忽略。
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001 > nul', { stdio: 'ignore' });
  } catch { /* 无控制台时忽略 */ }
}

const TAG = {
  SYSTEM: chalk.cyan('[SYSTEM]'),
  USER: chalk.magenta('[USER]'),
  CACHE: chalk.blue('[cache]'),
};

export const log = {
  /** 系统级信息 */
  system(msg) {
    console.log(`${chalk.cyan('🔵')} ${TAG.SYSTEM} ${msg}`);
  },

  /** 系统级成功事件 */
  ok(msg) {
    console.log(`${chalk.green('🟢')} ${TAG.SYSTEM} ${msg}`);
  },

  /** 用户通过前端主动发起的操作（统一标 [USER]） */
  user(msg) {
    console.log(`${chalk.magenta('👤')} ${TAG.USER} ${msg}`);
  },

  /** 缓存命中 / 未命中 */
  cache(kind, msg) {
    const icon = kind === 'HIT' ? chalk.green('✅') : chalk.yellow('🔄');
    console.log(`${icon} ${TAG.CACHE} ${chalk.bold(kind)} ${msg}`);
  },

  /** 客户端断开 / 检索被取消 */
  cancel(msg) {
    console.log(`${chalk.yellow('🚫')} ${TAG.SYSTEM} ${chalk.yellow(msg)}`);
  },

  /** 索引 / 重建 / 同步进度 */
  progress(msg) {
    console.log(`${chalk.blue('📊')} ${TAG.SYSTEM} ${msg}`);
  },

  /** 警告（非致命，但需关注） */
  warn(msg) {
    console.warn(`${chalk.yellow('🟡')} ${TAG.SYSTEM} ${chalk.yellow(msg)}`);
  },

  /** 错误（含未捕获异常、启动失败、子进程异常退出等） */
  error(msg) {
    console.error(`${chalk.red('🔴')} ${TAG.SYSTEM} ${chalk.red(msg)}`);
  },

  /** 进程退出 / 优雅关闭 */
  shutdown(msg) {
    console.log(`\n${chalk.red('🛑')} ${TAG.SYSTEM} ${msg}`);
  },

  /** 单个 HTTP 请求完成日志 */
  request(method, url, status, ms) {
    const colored = status >= 500 ? chalk.red(status) : status >= 400 ? chalk.yellow(status) : chalk.green(status);
    console.log(
      `${chalk.cyan('🌐')} ${TAG.USER} ${method} ${url} ${colored} ${chalk.dim(`(${ms}ms)`)}`
    );
  },

  /** 启动横幅 */
  banner(port, maxResults) {
    const line = chalk.cyan('══════════════════════════════════════════════════');
    console.log(line);
    console.log(`  ${chalk.green('🚀')} ${chalk.bold('DHT Search 服务已启动')}  ${chalk.dim(`http://localhost:${port}`)}`);
    console.log(`  ${chalk.dim(`配置: port=${port} maxResults=${maxResults}`)}`);
    console.log(`  ${chalk.dim('等待用户请求...')}`);
    console.log(line);
  },
};

export default log;
