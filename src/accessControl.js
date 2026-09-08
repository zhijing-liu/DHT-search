/**
 * 接入层访问控制：仅允许白名单内的客户端 IP / 网段访问。
 * ------------------------------------------------------------------
 * 零依赖实现（不引入 ipaddr.js 等第三方包），支持：
 *   - 精确 IPv4 / IPv6；
 *   - IPv4 / IPv6 CIDR 网段；
 *   - ::ffff:x.x.x.x（IPv4 映射 IPv6）自动归一化回 IPv4 再比对。
 *
 * 中间件应注册在 index.js 最前（日志 / 静态资源 / json 解析之前），
 * 使整站（前端页面 + 所有 API + 写接口）都被同一道闸保护。
 */

import { log } from './logger.js';

/**
 * 拒绝页（整页内联，无外部资源）：白名单挡下时给用户可读的页面，而非裸 403 文本。
 * @param {string} rawIp 客户端地址（仅作文本展示，已做 HTML 转义）
 */
function deniedPage(rawIp) {
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
}

/**
 * 归一化地址：小写、去空格；剥离 IPv4 映射 IPv6 前缀（::ffff:a.b.c.d -> a.b.c.d）；
 * 去掉 IPv6 字面量中可能携带的方括号与端口（[2001:db8::1]:3000 -> 2001:db8::1）。
 */
function normalizeAddr(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return mapped[1];
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end !== -1) s = s.slice(1, end);
  }
  return s;
}

/** IPv4 文本 -> 32 位整数；非法返回 null */
function ipv4ToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

/** IPv6 文本 -> { hi, lo } 两个 64 位 BigInt；非法返回 null */
function ipv6ToParts(ip) {
  let groups;
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    if (l.length + r.length > 7) return null;
    groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  } else {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  }
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = BigInt(parseInt(groups[i], 16));
    if (i < 4) hi = (hi << 16n) | n;
    else lo = (lo << 16n) | n;
  }
  return { hi, lo };
}

/** 解析地址为 { value: BigInt, bits: 32 | 128 }；非法返回 null */
function parseAddr(ip) {
  const v4 = ipv4ToLong(ip);
  if (v4 !== null) return { value: BigInt(v4), bits: 32 };
  const v6 = ipv6ToParts(ip);
  if (v6) return { value: (v6.hi << 64n) | v6.lo, bits: 128 };
  return null;
}

/**
 * 解析白名单规则为 { value, bits, maskBits }；非法返回 null。
 * 无 '/' 视为精确匹配（maskBits = 地址位宽）。
 */
function parseRule(rule) {
  // 与地址侧一致：先做归一化（小写、剥离 ::ffff: 映射前缀、去方括号端口），
  // 否则规则写成 '::ffff:192.168.1.5' 会因无法解析为 IPv4 而静默失效。
  rule = normalizeAddr(String(rule).trim());
  if (!rule.includes('/')) {
    const p = parseAddr(rule);
    return p ? { value: p.value, bits: p.bits, maskBits: p.bits } : null;
  }
  const [base, bitsStr] = rule.split('/');
  const maskBits = Number(bitsStr);
  const p = parseAddr(base);
  if (!p || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > p.bits) return null;
  return { value: p.value, bits: p.bits, maskBits };
}

/** 判断地址是否匹配某条已解析规则（同协议族 + 掩码相等） */
function matchParsed(addr, rule) {
  if (addr.bits !== rule.bits) return false;
  if (rule.maskBits >= addr.bits) return addr.value === rule.value;
  const mask = ((1n << BigInt(rule.maskBits)) - 1n) << BigInt(addr.bits - rule.maskBits);
  return (addr.value & mask) === (rule.value & mask);
}

/**
 * 判断地址（字符串）是否命中规则（字符串）。供中间件与单测复用。
 * @param {string} addr  客户端地址（支持 ::ffff: 映射 IPv6）
 * @param {string} rule  白名单规则（精确 IP 或 CIDR）
 */
export function ipMatches(addr, rule) {
  const a = parseAddr(normalizeAddr(addr));
  if (!a) return false;
  const r = parseRule(rule);
  if (!r) return false;
  return matchParsed(a, r);
}

/**
 * 构造接入层访问控制中间件。
 * @param {object}   opts
 * @param {string}   opts.mode     'ip-whitelist' 生效；其余一律放行（默认 'off'）
 * @param {string[]} opts.allowed  允许访问的 IP / CIDR 清单
 * @returns {import('express').RequestHandler}
 */
export function createAccessControl({ mode = 'off', allowed = [] } = {}) {
  const enabled = mode === 'ip-whitelist';
  const rules = enabled
    ? (Array.isArray(allowed) ? allowed : []).map(parseRule).filter(Boolean)
    : [];

  if (enabled && rules.length === 0) {
    log.warn('[ACCESS] 白名单模式已开启但规则为空，将拒绝全部请求（请检查 ALLOWED_CLIENTS）');
  }

  return function accessControl(req, res, next) {
    // 关闭模式：直接放行
    if (!enabled) return next();

    // 开启但规则为空（典型为配置错误）：fail-closed，拒绝全部
    if (rules.length === 0) {
      const ip0 = req.ip || req.socket?.remoteAddress || '';
      log.warn(`[ACCESS] 拒绝 ${ip0 || '(未知)'} ${req.method} ${req.originalUrl}（白名单为空）`);
      return res.status(403).type('text/html; charset=utf-8').send(deniedPage(ip0));
    }

    const rawIp = req.ip || req.socket?.remoteAddress || '';
    const ap = parseAddr(normalizeAddr(rawIp));
    const hit = ap && rules.some((r) => matchParsed(ap, r));
    if (hit) return next();

    log.warn(`[ACCESS] 拒绝 ${rawIp || '(未知)'} ${req.method} ${req.originalUrl}`);
    res.status(403).type('text/html; charset=utf-8').send(deniedPage(rawIp));
  };
}

export default createAccessControl;
