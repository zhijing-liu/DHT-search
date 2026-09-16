/**
 * 白名单逻辑测试（无外部依赖，不依赖源库）。
 * 运行：node test/access-control.mjs  （或 npm run test:access）
 */
import assert from 'node:assert/strict';
import { ipMatches, createAccessControl } from '../src/accessControl.js';

/* ------------------------------------------------------------------ */
/* 1) 纯匹配逻辑                                                       */
/* ------------------------------------------------------------------ */
// [客户端地址, 规则, 期望结果]
const matchCases = [
  // 精确 IPv4
  ['192.168.1.5', '192.168.1.5', true],
  ['192.168.1.5', '10.0.0.1', false],
  ['127.0.0.1', '127.0.0.1', true],
  // IPv4 CIDR
  ['192.168.1.5', '192.168.0.0/16', true],
  ['192.167.1.5', '192.168.0.0/16', false],
  ['10.0.0.1', '10.0.0.0/8', true],
  ['11.0.0.1', '10.0.0.0/8', false],
  ['8.8.8.8', '192.168.0.0/16', false],
  // 边界：/0 表示整个地址族都放行
  ['8.8.8.8', '0.0.0.0/0', true],
  // IPv4 映射 IPv6 自动归一化回 IPv4 再比
  ['::ffff:192.168.1.5', '192.168.0.0/16', true],
  ['::ffff:8.8.8.8', '192.168.0.0/16', false],
  // 规则侧也做同样的归一化：写成映射形式（含前缀换算 /112 ←→ /16）也应命中
  ['192.168.1.5', '::ffff:192.168.1.5', true],
  ['192.168.1.5', '::ffff:192.168.0.0/112', true],
  ['8.8.8.8', '::ffff:192.168.0.0/112', false],
  ['2001:db8::1', '::ffff:192.168.0.0/112', false],
  // 精确 IPv6
  ['::1', '::1', true],
  ['2001:db8::1', '2001:db8::1', true],
  ['2001:db8::1', '2001:db8::1/128', true],
  // IPv6 CIDR
  ['2001:db8::1', '2001:db8::/32', true],
  ['2001:db8:1::1', '2001:db8::/32', true],
  ['2001:dc8::1', '2001:db8::/32', false],
  ['fc00::1', 'fc00::/7', true],
  ['fbff::1', 'fc00::/7', false],
  // 同一地址的非压缩 / 大写写法应等价
  ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32', true],
  ['2001:DB8::1', '2001:db8::/32', true],
  // 协议族不同不应误匹配
  ['192.168.1.5', '2001:db8::/32', false],
  ['2001:db8::1', '192.168.0.0/16', false],
  // 非法输入不应抛错，返回 false
  ['not-an-ip', '192.168.0.0/16', false],
  ['999.999.999.999', '0.0.0.0/0', false],
  ['', '192.168.0.0/16', false],
  ['192.168.1.5', '', false],
  ['192.168.1.5', '192.168.1.0/33', false], // 前缀长度越界
  ['192.168.1.5', '2001:db8::/999', false],
];

for (const [ip, rule, expected] of matchCases) {
  assert.equal(ipMatches(ip, rule), expected, `ipMatches(${JSON.stringify(ip)}, ${JSON.stringify(rule)})`);
}

/* ------------------------------------------------------------------ */
/* 2) 中间件 handler 行为（mock req/res/next，不依赖 express 监听）     */
/* ------------------------------------------------------------------ */
function makeRes() {
  const res = { statusCode: 0, body: '' };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = () => res;
  res.send = (b) => { res.body = b; return res; };
  return res;
}
function callHandler(mode, allowed, ip) {
  const h = createAccessControl({ mode, allowed });
  let nextCalled = false;
  const res = makeRes();
  h({ ip, method: 'GET', originalUrl: '/api/search', socket: {} }, res, () => { nextCalled = true; });
  return { nextCalled, status: res.statusCode };
}

const handlerCases = [
  // [mode, allowed, ip, 期望 {nextCalled, status}]
  ['ip-whitelist', ['192.168.0.0/16', '::1'], '192.168.1.1', { nextCalled: true, status: 0 }],
  ['ip-whitelist', ['192.168.0.0/16', '::1'], '10.0.0.1', { nextCalled: false, status: 403 }],
  ['ip-whitelist', ['192.168.0.0/16', '::1'], '::1', { nextCalled: true, status: 0 }],
  ['ip-whitelist', ['192.168.0.0/16', '::1'], '8.8.8.8', { nextCalled: false, status: 403 }],
  ['ip-whitelist', ['::ffff:192.168.1.5'], '192.168.1.5', { nextCalled: true, status: 0 }],
  ['off', [], '8.8.8.8', { nextCalled: true, status: 0 }],
  ['ip-whitelist', [], '192.168.1.1', { nextCalled: false, status: 403 }], // 空名单拒绝全部
];

for (const [mode, allowed, ip, expected] of handlerCases) {
  const got = callHandler(mode, allowed, ip);
  assert.deepEqual(got, expected, `handler(${mode}, ${JSON.stringify(allowed)}, ${ip}) => ${JSON.stringify(got)}`);
}

console.log(`access-control: ${matchCases.length + handlerCases.length} assertions passed`);
