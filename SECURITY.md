# Security Policy / 安全策略

## Reporting a Vulnerability / 报告漏洞

- **English**: Please do **not** report security vulnerabilities through public GitHub issues.
  Use GitHub [Security Advisories](https://github.com/zhijing-liu/DHT-search/security/advisories/new) ("Report a vulnerability") instead.
  You can expect a response within 7 days.
- **中文**：请不要通过公开 Issue 报告安全漏洞，请使用 GitHub [Security Advisories](https://github.com/zhijing-liu/DHT-search/security/advisories/new) 的「Report a vulnerability」私下报告，预计 7 天内回复。

## Scope / 范围

- Issues in this repository's code (HTTP API, access control, index maintenance, packaging scripts).
- 本仓库自身代码的问题（HTTP API、访问控制、索引维护、打包脚本等）。

## Out of scope / 不在范围内

- Content of the indexed data (this project only indexes metadata publicly broadcast on the DHT network; see README Chapter 14/15).
- Vulnerabilities in third-party downloaders (aria2 / Motrix) or their RPC interfaces.
- 被索引数据的内容本身（本项目仅索引 DHT 网络公开广播的元数据，见 README 第十四 / 十五章）；第三方下载器（aria2 / Motrix）及其 RPC 接口的漏洞。

## Deployment hardening tips / 部署加固建议

- Keep `ACCESS_CONTROL_MODE = 'ip-whitelist'` and a tight `ALLOWED_CLIENTS` when exposing the service;
- 公网部署务必保持 IP 白名单，`TRUST_PROXY` 仅在确有反代时开启；
- Run the service under a dedicated, unprivileged account.
- 使用低权限专用账户运行服务。
