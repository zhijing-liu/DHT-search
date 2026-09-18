/**
 * 接入层访问控制：仅允许白名单内的客户端 IP / 网段访问。
 * ------------------------------------------------------------------
 * 支持精确 IPv4 / IPv6 与 CIDR 网段；::ffff:x.x.x.x（IPv4 映射 IPv6）会归一化回
 * IPv4 再比对。解析与匹配用 ipaddr.js（Express 自己在用的库，非新增依赖）。
 *
 * 中间件应注册在 index.js 最前，使整站（页面 + 所有 API）都被同一道闸保护。
 */

import ipaddr from 'ipaddr.js';
import { log } from './logger.js';

/**
 * 拒绝页（整页内联，无外部资源）：白名单挡下时给用户可读的页面，而非裸 403 文本。
 * @param {string} rawIp 客户端地址（仅作文本展示，已做 HTML 转义）
 */
const deniedPage = (rawIp) => {
  const ip = String(rawIp ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>403 · 访问被拒绝</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0d1117; color: #e6edf3;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 520px; width: 100%; padding: 32px 28px; border-radius: 14px;
    background: #161b22; border: 1px solid #30363d;
  }
  .code { color: #ff7b72; font-weight: 700; font-size: 22px; letter-spacing: 1px; }
  h1 { font-size: 19px; margin: 10px 0 8px; }
  p { color: #8b949e; }
  .ip {
    display: inline-block; margin: 14px 0 2px; padding: 4px 10px; border-radius: 8px;
    background: #21262d; color: #c9d1d9; font-family: Consolas, "Courier New", monospace;
    word-break: break-all;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="code">403</div>
    <h1>访问被拒绝</h1>
    <p>当前服务启用了 IP 白名单访问控制，您的地址不在允许列表内。</p>
    <div class="ip">${ip || '未知地址'}</div>
    <p style="margin-top:10px">如需访问，请联系管理员将该地址加入
      <code>ALLOWED_CLIENTS</code> 后重试。</p>
  </div>
</body>
</html>`;
};

/** 去掉 IPv6 字面量可能携带的方括号与端口（[2001:db8::1]:3000 → 2001:db8::1） */
const stripPort = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('[')) return s;
  const end = s.indexOf(']');
  return end === -1 ? s : s.slice(1, end);
};

/**
 * 解析客户端地址；非法输入返回 null（不抛错，调用方按「不命中」处理）。
 * process() 会把 IPv4 映射 IPv6（::ffff:a.b.c.d）归一化成 IPv4，
 * 于是「客户端报 ::ffff:192.168.1.5、白名单写 192.168.0.0/16」能正确命中。
 */
const parseAddr = (raw) => {
  if (!raw) return null;
  try {
    return ipaddr.process(stripPort(raw));
  } catch {
    return null;
  }
};

/**
 * 解析白名单规则（精确 IP 或 CIDR）为 [地址, 前缀长度] 元组；非法返回 null。
 * 必须产出元组：ipaddr 的 match() 只接受 [address, prefixLength] 或两个参数。
 * 地址与 CIDR 基地址都先做 IPv4 映射归一化，映射形式的前缀同步减去 96。
 */
const parseRule = (raw) => {
  const s = stripPort(raw);
  if (!s) return null;
  try {
    if (!s.includes('/')) {
      const addr = ipaddr.process(s);
      return [addr, addr.kind() === 'ipv4' ? 32 : 128];
    }
    let [base, bits] = ipaddr.parseCIDR(s);
    if (base.kind() === 'ipv6' && base.isIPv4MappedAddress() && bits >= 96) {
      base = base.toIPv4Address();
      bits -= 96;
    }
    return [base, bits];
  } catch {
    return null;
  }
};

/** 地址是否命中某条已解析规则（协议族不同时 ipaddr.match 直接判否） */
const matches = (addr, rule) => {
  try {
    return addr.match(rule);
  } catch {
    return false;
  }
};

/**
 * 判断地址（字符串）是否命中规则（字符串）。供中间件与单测复用。
 * @param {string} addr  客户端地址（支持 ::ffff: 映射 IPv6）
 * @param {string} rule  白名单规则（精确 IP 或 CIDR）
 */
export const ipMatches = (addr, rule) => {
  const a = parseAddr(addr);
  if (!a) return false;
  const r = parseRule(rule);
  if (!r) return false;
  return matches(a, r);
};

/**
 * 构造接入层访问控制中间件。
 * @param {object}   opts
 * @param {string}   opts.mode     'ip-whitelist' 生效；其余一律放行（默认 'off'）
 * @param {string[]} opts.allowed  允许访问的 IP / CIDR 清单
 * @returns {import('express').RequestHandler}
 */
export const createAccessControl = ({ mode = 'off', allowed = [] } = {}) => {
  const enabled = mode === 'ip-whitelist';
  const rules = enabled
    ? (Array.isArray(allowed) ? allowed : []).map(parseRule).filter(Boolean)
    : [];

  if (enabled && rules.length === 0) {
    log.warn('[ACCESS] 白名单模式已开启但规则为空，将拒绝全部请求（请检查 ALLOWED_CLIENTS）');
  }

  return (req, res, next) => {
    // 关闭模式：直接放行
    if (!enabled) return next();

    // 开启但规则为空（典型为配置错误）：fail-closed，拒绝全部
    if (rules.length === 0) {
      const ip0 = req.ip || req.socket?.remoteAddress || '';
      log.warn(`[ACCESS] 拒绝 ${ip0 || '(未知)'} ${req.method} ${req.originalUrl}（白名单为空）`);
      return res.status(403).type('text/html; charset=utf-8').send(deniedPage(ip0));
    }

    const rawIp = req.ip || req.socket?.remoteAddress || '';
    const ap = parseAddr(rawIp);
    const hit = ap && rules.some((r) => matches(ap, r));
    if (hit) return next();

    log.warn(`[ACCESS] 拒绝 ${rawIp || '(未知)'} ${req.method} ${req.originalUrl}`);
    res.status(403).type('text/html; charset=utf-8').send(deniedPage(rawIp));
  };
};

export default createAccessControl;
