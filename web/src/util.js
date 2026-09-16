/**
 * 共享纯函数与轻量助手。
 * ------------------------------------------------------------------
 * 只放「与框架无关」的逻辑：格式化、查询解析、联想匹配、剪贴板、下载、RPC 推送。
 * 所有渲染/事件都交给 Alpine 模板，这里不产生任何 DOM 结构（下载与复制属浏览器 API 例外）。
 */
import { showToast } from './toast.js';

/* ---------- 数据规范化与格式化 ---------- */

/** 把字节数格式化为带单位的可读字符串 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const pad2 = (x) => String(x).padStart(2, '0');

/** 把时间戳格式化为 YYYY-MM-DD HH:mm */
export function formatDate(ts) {
  if (!Number.isFinite(Number(ts))) return '-';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 把毫秒差格式化为 mm:ss / h:mm:ss（用于同步倒计时） */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
    : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

const numberFmt = new Intl.NumberFormat('zh-CN');

/** 千分位整数 */
export function formatCount(n) {
  return numberFmt.format(Number(n) || 0);
}

/* ---------- 查询解析 ---------- */

/** 从查询串提取高亮 token（与后端 buildMatchExpression 保持一致：字母数字、小写、去重） */
export function extractTokens(q) {
  const m = String(q).match(/[\p{L}\p{N}]+/gu);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
}

/** 判断输入是否为 infohash：连续 40 位十六进制，或带 urn:btih: / hash 前缀 */
export function isInfohash(q) {
  const s = String(q).trim().toLowerCase();
  if (s.includes('urn:btih:')) return /^.*urn:btih:[a-f0-9]{40}$/.test(s);
  if (s.startsWith('hash')) return /^hash[a-f0-9]{40}$/.test(s);
  return /^[a-f0-9]{40}$/.test(s);
}

/* ---------- 输入联想（编辑距离 + 分组排序） ---------- */

/** Levenshtein 编辑距离 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** term 是否与 query 模糊相似：编辑距离阈值随长度放宽 */
function isFuzzyMatch(term, query) {
  if (Math.abs(term.length - query.length) > 2) return false;
  const d = editDistance(term, query);
  return d <= 1 || (query.length >= 4 && d <= 2);
}

/**
 * 从热词中相似匹配：完全相等 > 前缀 > 包含 > 模糊；组间按优先级、组内按热度。
 * 注意分组各自排序后再拼接，统一 sort 会打散分组优先级。
 */
export function matchSuggestions(items, q, max = 8) {
  const query = String(q).trim().toLowerCase();
  if (!query) return [];
  const groups = { exact: [], prefix: [], include: [], fuzzy: [] };
  for (const it of items) {
    const term = String(it.term).toLowerCase();
    if (term === query) groups.exact.push(it);
    else if (term.startsWith(query)) groups.prefix.push(it);
    else if (term.includes(query)) groups.include.push(it);
    else if (isFuzzyMatch(term, query)) groups.fuzzy.push(it);
  }
  const byHot = (a, b) => b.doc_count - a.doc_count || b.occurrences - a.occurrences;
  return [
    ...groups.exact.sort(byHot),
    ...groups.prefix.sort(byHot),
    ...groups.include.sort(byHot),
    ...groups.fuzzy.sort(byHot),
  ].slice(0, max);
}

/* ---------- 高亮（输出可直接 x-html 的安全字符串） ---------- */

/** 转义正则元字符，避免 token 破坏构造出的正则 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** HTML 转义：x-html 绑定的所有文本都必须先过这里（仅本模块内部使用） */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把 text 中命中 tokens 的片段用 <mark> 高亮，返回转义后的安全 HTML。
 * tokens 为空时退化为纯转义文本。
 */
export function highlightHtml(text, tokens) {
  const s = String(text ?? '');
  if (!tokens || tokens.length === 0) return escapeHtml(s);
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // 防止零宽匹配死循环
    out += escapeHtml(s.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

/* ---------- 浏览器能力：复制 / 下载 / 迅雷链接 ---------- */

/** 复制文本到剪贴板（带 execCommand 降级）。两条路都失败时抛错，交由调用方提示失败。 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 非安全上下文（http 且非 localhost）没有 clipboard API，落到下面的降级实现 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('复制失败');
}

/** 触发浏览器下载一个文本文件 */
export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 把 magnet 链接编码成迅雷 thunder:// 协议链接 */
export function toThunder(magnet) {
  if (!magnet) return '';
  const raw = 'AA' + magnet + 'ZZ';
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
  return 'thunder://' + b64;
}

/* ---------- RPC 推送（aria2 / Motrix JSON-RPC 2.0） ---------- */

const RPC_URL_KEY = 'dht_rpc_url';
const RPC_SECRET_KEY = 'dht_rpc_secret';
const DEFAULT_RPC_URL = 'http://localhost:16800/jsonrpc';

/** 读取 RPC 推送配置（地址默认 localhost:16800，密钥默认空） */
export function getRpcConfig() {
  return {
    url: (localStorage.getItem(RPC_URL_KEY) || DEFAULT_RPC_URL).trim(),
    secret: (localStorage.getItem(RPC_SECRET_KEY) || '').trim(),
  };
}

/** 保存 RPC 推送配置到 localStorage（空值则清除对应键，回退默认） */
export function saveRpcConfig({ url, secret } = {}) {
  if (url && url.trim()) localStorage.setItem(RPC_URL_KEY, url.trim());
  else localStorage.removeItem(RPC_URL_KEY);
  if (secret) localStorage.setItem(RPC_SECRET_KEY, secret);
  else localStorage.removeItem(RPC_SECRET_KEY);
}

/**
 * 把磁力链接推送到 aria2 / Motrix 下载器（JSON-RPC 2.0 的 aria2.addUri）。
 * 设了密钥时按 aria2 约定在 params 头部加 `token:<secret>`；结果用 toast 反馈。
 */
export async function pushToAria2(magnet) {
  if (!magnet) {
    showToast('没有可推送的磁力链接');
    return;
  }
  const { url, secret } = getRpcConfig();
  const params = [[magnet]];
  if (secret) params.unshift(`token:${secret}`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'aria2.addUri', params }),
    });
    const data = await resp.json();
    if (data.error) showToast(`推送失败：${data.error.message}`);
    else showToast(`已推送到下载器，GID: ${data.result}`);
  } catch (err) {
    showToast(`推送出错：${err.message}`);
  }
}
