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

/** 页面顶部居中的轻量通知（toast），全局单例容器挂在 document 顶层 */
let _toastHost = null;
export function showToast(msg) {
  if (!_toastHost) {
    _toastHost = document.createElement('div');
    _toastHost.className = 'app-toast-host';
    document.body.appendChild(_toastHost);
  }
  const t = document.createElement('div');
  t.className = 'app-toast';
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
