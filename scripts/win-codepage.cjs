// 仅 Windows：将当前控制台的输出代码页切到 UTF-8(CP65001)。
// 解决经 pnpm / cmd 启动脚本（如 `bun --watch`）时，控制台默认 GBK(CP936)
// 把 Node/Bun 以 UTF-8 写出的中文当成 GBK 解码导致乱码（如「鏀跺埌」）的问题。
// 非 Windows 平台或执行失败（无控制台 / 服务态）直接忽略，保持跨平台安全。
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001 > nul', { stdio: 'ignore' });
  } catch { /* 无控制台时忽略 */ }
}
