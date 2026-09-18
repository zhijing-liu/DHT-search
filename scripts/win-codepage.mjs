// 仅 Windows：把当前控制台输出代码页切到 UTF-8(CP65001)。
// 解决经 cmd / PowerShell 启动脚本时，控制台默认 GBK(CP936) 把 Node/Bun 的
// UTF-8 中文当成 GBK 解码导致乱码的问题（如「鏀跺埌」）。
// 非 Windows 或执行失败（无控制台 / 服务态）直接忽略，保持跨平台安全。
import { execSync } from 'node:child_process';

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001 > nul', { stdio: 'ignore' });
  } catch { /* 无控制台时忽略 */ }
}
