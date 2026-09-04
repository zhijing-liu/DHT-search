/* 组件间共享的纯工具函数（无 DOM 强耦合、可独立测试） */

/** 把 files 字段规范为 [{ path, size }] 数组 */
export function normalizeFiles(files) {
  if (Array.isArray(files)) return files;
  if (files && typeof files === 'object') return [files];
  return [];
}

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

/** 把时间戳格式化为 YYYY-MM-DD HH:mm */
export function formatDate(ts) {
  if (!Number.isFinite(Number(ts))) return '-';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把毫秒差格式化为 mm:ss / h:mm:ss（用于同步倒计时） */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  const p = (x) => String(x).padStart(2, '0');
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
    : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

/** 复制文本到剪贴板（带降级方案），并提示已复制 */
export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  const old = btn.title;
  btn.classList.add('copied');
  btn.title = '已复制';
  setTimeout(() => { btn.classList.remove('copied'); btn.title = old; }, 1200);
  showToast('已复制到剪贴板');
}

/** 把 magnet 链接编码成迅雷 thunder:// 协议链接 */
export function toThunder(magnet) {
  if (!magnet) return '';
  const raw = 'AA' + magnet + 'ZZ';
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
  return 'thunder://' + b64;
}

/* ------------------------------------------------------------------ */
/* RPC 推送（aria2 / Motrix JSON-RPC 2.0）                              */
/* ------------------------------------------------------------------ */

const RPC_URL_KEY = 'dht_rpc_url';
const RPC_SECRET_KEY = 'dht_rpc_secret';
const DEFAULT_RPC_URL = 'http://localhost:16800/jsonrpc';

/** 读取 RPC 推送配置（地址默认 localhost:16800，密钥默认空） */
export function getRpcConfig() {
  const url = (localStorage.getItem(RPC_URL_KEY) || DEFAULT_RPC_URL).trim();
  const secret = (localStorage.getItem(RPC_SECRET_KEY) || '').trim();
  return { url, secret };
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
  if (!magnet) { showToast('没有可推送的磁力链接'); return; }
  const { url, secret } = getRpcConfig();
  const params = [[magnet]];
  if (secret) params.unshift(`token:${secret}`);
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'aria2.addUri',
    params,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) showToast(`推送失败：${data.error.message}`);
    else showToast(`已推送到下载器，GID: ${data.result}`);
  } catch (err) {
    showToast(`推送出错：${err.message}`);
  }
}

/** 页面顶部居中的轻量通知（toast），全局单例容器挂在 document 顶层 */
let _toastHost = null;
export function showToast(msg) {
  if (!_toastHost) {
    _toastHost = document.createElement('div');
    _toastHost.className =
      'fixed top-[18px] left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 pointer-events-none';
    document.body.appendChild(_toastHost);
  }
  const t = document.createElement('div');
  t.className =
    'bg-surface/95 text-white border border-white/[0.14] px-[18px] py-2.5 rounded-[10px] ' +
    'text-sm leading-[1.4] shadow-[0_8px_24px_rgba(0,0,0,0.35)] ' +
    'opacity-0 -translate-y-2 transition-[opacity,transform] duration-200 ' +
    '[&.show]:opacity-100 [&.show]:translate-y-0';
  t.textContent = msg;
  _toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 220);
  }, 1600);
}

/** 转义正则元字符，避免 token 破坏构造出的正则 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 text 中命中 tokens 的片段用 <mark> 高亮写入 container。
 * 全程用 DOM API 拼接，不使用 innerHTML，杜绝 XSS。
 * tokens 为空或为空串时退化为纯 textContent。
 */
export function highlightInto(container, text, tokens) {
  container.replaceChildren();
  if (!tokens || tokens.length === 0 || !text) {
    container.textContent = text || '';
    return;
  }
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    container.appendChild(mark);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // 防止零宽匹配死循环
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
