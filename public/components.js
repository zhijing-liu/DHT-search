'use strict';

/* ------------------------------------------------------------------ */
/* 共享工具                                                            */
/* ------------------------------------------------------------------ */

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

export function formatDate(ts) {
  if (!Number.isFinite(Number(ts))) return '-';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把 files 字段规范为 [{ path, size }] 数组 */
function normalizeFiles(files) {
  if (Array.isArray(files)) return files;
  if (files && typeof files === 'object') return [files];
  return [];
}

async function copyText(text, btn) {
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
function toThunder(magnet) {
  if (!magnet) return '';
  const raw = 'AA' + magnet + 'ZZ';
  const b64 = btoa(unescape(encodeURIComponent(raw)));
  return 'thunder://' + b64;
}

/** 页面顶部居中的轻量通知（toast），全局单例容器挂在 document 顶层 */
let _toastHost = null;
function showToast(msg) {
  if (!_toastHost) {
    _toastHost = document.createElement('div');
    _toastHost.className = 'app-toast-host';
    document.body.appendChild(_toastHost);
    const style = document.createElement('style');
    style.textContent = `
      .app-toast-host {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none;
      }
      .app-toast {
        background: rgba(17, 24, 39, 0.95); color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.14);
        padding: 10px 18px; border-radius: 10px; font-size: 14px; line-height: 1.4;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        opacity: 0; transform: translateY(-8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .app-toast.show { opacity: 1; transform: translateY(0); }`;
    document.head.appendChild(style);
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

const SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** 转义正则元字符，避免 token 破坏构造出的正则 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 text 中命中 tokens 的片段用 <mark> 高亮写入 container。
 * 全程用 DOM API 拼接，不使用 innerHTML，杜绝 XSS。
 * tokens 为空或为空串时退化为纯 textContent。
 */
function highlightInto(container, text, tokens) {
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

/* ------------------------------------------------------------------ */
/* <magnet-files>  文件树（可折叠，默认展开第一级）                    */
/* ------------------------------------------------------------------ */

/**
 * 把扁平的 [{ path, size }] 列表按 path 中的 '/' 拆分成目录树。
 * 目录节点聚合字节大小，文件节点保留自身 size。
 */
function buildFileTree(files) {
  const root = { name: '', isDir: true, children: new Map(), size: 0 };
  for (const f of files) {
    const parts = String((f && f.path) || '').split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '') continue;
      const isLeaf = i === parts.length - 1;
      let child = cur.children.get(part);
      if (!child) {
        child = { name: part, isDir: !isLeaf, children: new Map(), size: 0 };
        cur.children.set(part, child);
      }
      if (isLeaf) {
        child.isDir = false;
        child.size = Number(f.size) || 0;
      }
      cur = child;
    }
  }
  return root;
}

/** 递归累加目录节点的字节大小（所有子孙叶子之和） */
function computeTreeSizes(node) {
  if (!node.isDir) return Number(node.size) || 0;
  let total = 0;
  for (const c of node.children.values()) total += computeTreeSizes(c);
  node.size = total;
  return total;
}

/** 递归渲染树节点；depth 为父节点深度，child 实际深度 = depth + 1 */
function renderTreeNode(node, depth, tokens) {
  const frag = document.createDocumentFragment();
  const arr = [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录优先
    const sa = fileMatchScore(a.name, tokens);
    const sb = fileMatchScore(b.name, tokens);
    if (sa !== sb) return sb - sa; // 命中关键词优先
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
  for (const child of arr) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const toggle = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';

    if (child.isDir) {
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `· ${formatBytes(Number(child.size))}`;
      highlightInto(name, child.name, tokens);
      row.append(toggle, name, size);

      const sub = document.createElement('ul');
      sub.className = 'children';
      sub.appendChild(renderTreeNode(child, depth + 1, tokens));
      li.append(row, sub);

      // 默认仅展开第一级（顶层目录显示其直接子，更深层级折叠）
      const expanded = depth === 0;
      if (!expanded) li.classList.add('collapsed');
      toggle.textContent = expanded ? '▾' : '▸';
      toggle.addEventListener('click', () => {
        const collapsed = li.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
      });
    } else {
      toggle.className = 'toggle empty';
      highlightInto(name, child.name, tokens);
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(Number(child.size));
      row.append(toggle, name, size);
      li.append(row);
    }
    frag.appendChild(li);
  }
  return frag;
}

/** 卡片预览最多展示的文件条数（性能：列表不渲染全部） */
const PREVIEW_LIMIT = 5;

/** 文件命中查询 token 的数量评分，用于「匹配关键词优先」排序 */
function fileMatchScore(name, tokens) {
  if (!tokens || !tokens.length) return 0;
  const lower = String(name).toLowerCase();
  let s = 0;
  for (const t of tokens) if (lower.includes(t)) s++;
  return s;
}

class MagnetFiles extends HTMLElement {
  set files(value) {
    this._files = value;
    if (this.shadowRoot) this._render();
  }
  set highlight(value) {
    this._highlight = value;
    if (this.shadowRoot) this._render();
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host { display: block; margin: 0 0 10px; }
          ul { list-style: none; margin: 0; padding: 0; }
          li { font-size: 13px; padding: 3px 0; display: flex; gap: 6px; align-items: baseline; }
          .name { color: var(--text); word-break: break-all; }
          .name mark { background: rgba(99, 102, 241, 0.35); color: #fff; border-radius: 3px; padding: 0 2px; }
          .size { flex: none; color: var(--muted); white-space: nowrap; }
          .more { color: var(--muted); font-size: 12px; padding-top: 4px; }
        </style>
        <ul class="files"></ul>`;
    }
    if (this._files !== undefined) this._render();
  }

  _render() {
    const ul = this.shadowRoot.querySelector('.files');
    ul.replaceChildren();
    const list = normalizeFiles(this._files);
    if (!list.length) {
      ul.textContent = '（无文件列表）';
      return;
    }

    // 有关键词时只展示匹配到的文件，否则展示前 PREVIEW_LIMIT 条；命中优先并按原顺序稳定
    const tokens = this._highlight || [];
    const scored = list
      .map((f, i) => ({ f, i, s: fileMatchScore(f.path, tokens) }))
      .filter((x) => tokens.length === 0 || x.s > 0);
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    const preview = scored.slice(0, PREVIEW_LIMIT);

    for (const { f } of preview) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      highlightInto(name, f.path || '(未命名)', tokens);
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(Number(f.size));
      li.append(name, size);
      ul.appendChild(li);
    }

    if (preview.length && list.length > preview.length) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = `…及其他 ${list.length - preview.length} 个文件（点「查看全部文件」展开）`;
      ul.appendChild(more);
    }
  }
}
customElements.define('magnet-files', MagnetFiles);

/* ------------------------------------------------------------------ */
/* <magnet-card>  单条结果卡片                                          */
/* ------------------------------------------------------------------ */

class MagnetCard extends HTMLElement {
  set item(value) {
    this._item = value;
    if (this.shadowRoot) this._render();
  }
  set highlight(value) {
    this._highlight = value;
    if (this.shadowRoot) this._render();
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host {
            display: block; background: var(--card); border: 1px solid var(--border);
            border-radius: 12px; padding: 16px 18px;
            transition: transform 0.15s ease, border-color 0.15s ease;
          }
          :host(:hover) { transform: translateY(-2px); border-color: var(--accent); }
          .title { margin: 0 0 10px; font-size: 16px; font-weight: 500; word-break: break-all; }
          .title mark { background: rgba(99, 102, 241, 0.35); color: #fff; border-radius: 3px; padding: 0 2px; }
          .magnet { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
          .magnet-text {
            flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            color: var(--primary-2); font-size: 12px;
            text-decoration: none; cursor: pointer;
          }
          .magnet-text:hover { text-decoration: underline; }
          .copy {
            flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
            padding: 0; border-radius: 8px;
            border: 1px solid var(--border); background: transparent; color: var(--text);
            cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
          }
          .copy:hover { background: rgba(255, 255, 255, 0.08); }
          .copy.copied { color: #4ade80; border-color: #4ade80; }
          .copy svg { width: 16px; height: 16px; display: block; }
          .thunder {
            flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
            padding: 0; border-radius: 8px;
            border: 1px solid var(--border); background: transparent; color: var(--text);
            cursor: pointer; text-decoration: none; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
          }
          .thunder:hover { background: rgba(255, 255, 255, 0.08); border-color: var(--accent); color: var(--accent); }
          .thunder svg { width: 16px; height: 16px; display: block; }
          .meta { color: var(--muted); font-size: 12px; }
          .detail {
            margin-top: 10px; padding: 6px 12px; border-radius: 8px;
            border: 1px solid var(--border); background: transparent; color: var(--text);
            cursor: pointer; transition: background 0.15s ease;
          }
          .detail:hover { background: rgba(255, 255, 255, 0.08); }
          dialog { width: min(720px, 92vw); height: 86vh; padding: 0; border: 1px solid var(--border); border-radius: 14px; color: var(--text); background: var(--bg-2); }
          dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
          dialog[open] { display: flex; flex-direction: column; }
          .dlg-head { flex: none; display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
          .dlg-title { margin: 0; flex: 1; font-size: 16px; font-weight: 600; word-break: break-all; }
          .dlg-title mark { background: rgba(99, 102, 241, 0.35); color: #fff; border-radius: 3px; padding: 0 2px; }
          .close { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
          .close:hover { background: rgba(255, 255, 255, 0.08); }
          .close svg { width: 16px; height: 16px; display: block; }
          .dlg-body { flex: 1 1 auto; display: flex; flex-direction: column; overflow: hidden; padding: 16px 18px; }
          .dlg-row { display: flex; gap: 10px; margin-bottom: 8px; font-size: 13px; }
          .dlg-row .k { flex: none; width: 64px; color: var(--muted); }
          .dlg-row .v { word-break: break-all; }
          .dlg-row a.v-link { text-decoration: none; cursor: pointer; }
          .dlg-row a.v-link:hover { text-decoration: underline; }
          .dlg-meta { flex: none; }
          .dlg-files { flex: 1 1 auto; overflow: auto; min-height: 0; list-style: none; margin: 12px 0 0; padding: 0; }
          .dlg-files .row { display: flex; align-items: center; gap: 6px; }
          .dlg-files .toggle { flex: none; width: 14px; text-align: center; color: var(--muted); cursor: pointer; user-select: none; }
          .dlg-files .toggle.empty { visibility: hidden; }
          .dlg-files .name { color: var(--text); word-break: break-all; }
          .dlg-files .name mark { background: rgba(99, 102, 241, 0.35); color: #fff; border-radius: 3px; padding: 0 2px; }
          .dlg-files .size { flex: none; color: var(--muted); margin-left: 4px; }
          .dlg-files ul.children { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 1px solid var(--border); }
          .dlg-files li.collapsed > ul.children { display: none; }
        </style>
        <h2 class="title"></h2>
        <div class="magnet">
          <a class="magnet-text" href=""></a>
          <button class="copy" type="button" aria-label="复制磁力链接" title="复制磁力链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <a class="thunder" aria-label="迅雷下载" title="迅雷下载" href=""><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg></a>
        </div>
        <magnet-files></magnet-files>
        <div class="meta"></div>
        <button class="detail" type="button" hidden>查看全部文件</button>
        <dialog></dialog>`;
      this.shadowRoot.querySelector('.copy').addEventListener('click', (e) => {
        copyText(this._item?.magnet || '', e.currentTarget);
      });
      this.shadowRoot.querySelector('.detail').addEventListener('click', () => this._openDetail());
    }
    if (this._item !== undefined) this._render();
  }

  _render() {
    const it = this._item || {};
    const sr = this.shadowRoot;
    highlightInto(sr.querySelector('.title'), it.name || '(无名)', this._highlight);
    const mt = sr.querySelector('.magnet-text');
    mt.href = it.magnet || '';
    mt.textContent = it.magnet || '';
    mt.title = it.magnet || '';
    const th = sr.querySelector('.thunder');
    const tUrl = toThunder(it.magnet);
    th.href = tUrl;
    th.hidden = !tUrl;
    const mf = sr.querySelector('magnet-files');
    mf.files = it.files;
    mf.highlight = this._highlight;
    sr.querySelector('.meta').textContent =
      `大小 ${formatBytes(Number(it.totalSize))} · 抓取于 ${formatDate(Number(it.fetchedAt))}`;
    sr.querySelector('.detail').hidden = normalizeFiles(it.files).length <= PREVIEW_LIMIT;
  }

  /** 懒渲染完整详情弹窗（树 + 元数据），仅在点击时构建，列表不渲染树 */
  _openDetail() {
    const it = this._item || {};
    const sr = this.shadowRoot;
    const dlg = sr.querySelector('dialog');
    dlg.innerHTML = `
      <div class="dlg-head">
        <h3 class="dlg-title"></h3>
        <button class="close" type="button" aria-label="关闭" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="dlg-body">
        <div class="dlg-meta">
          <div class="dlg-row"><span class="k">磁力链接</span><a class="v v-link" href=""></a></div>
          <div class="dlg-row"><span class="k">infohash</span><span class="v"></span></div>
          <div class="dlg-row"><span class="k">大小</span><span class="v"></span></div>
          <div class="dlg-row"><span class="k">抓取于</span><span class="v"></span></div>
        </div>
        <ul class="dlg-files"></ul>
      </div>`;
    highlightInto(dlg.querySelector('.dlg-title'), it.name || '(无名)', this._highlight);
    const vals = dlg.querySelectorAll('.dlg-row .v');
    vals[0].href = it.magnet || '';
    vals[0].textContent = it.magnet || '';
    vals[0].style.color = 'var(--primary-2)';
    vals[1].textContent = it.infohash || '-';
    vals[2].textContent = formatBytes(Number(it.totalSize));
    vals[3].textContent = formatDate(Number(it.fetchedAt));

    const ul = dlg.querySelector('.dlg-files');
    const list = normalizeFiles(it.files);
    if (!list.length) {
      ul.textContent = '（无文件列表）';
    } else {
      const root = buildFileTree(list);
      computeTreeSizes(root);
      ul.replaceChildren(renderTreeNode(root, 0, this._highlight));
    }

    dlg.querySelector('.close').addEventListener('click', () => dlg.close());
    dlg.showModal();
  }
}
customElements.define('magnet-card', MagnetCard);

/* ------------------------------------------------------------------ */
/* <result-list>  结果容器（纵向滚动区）                               */
/* ------------------------------------------------------------------ */

class ResultList extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host {
          flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
          gap: 14px; padding: 6px 0; overflow-y: auto;
          scrollbar-width: thin; scrollbar-color: var(--border) transparent;
        }
        :host::-webkit-scrollbar { width: 8px; }
        :host::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      </style>
      <slot></slot>`;
  }
}
customElements.define('result-list', ResultList);

/* ------------------------------------------------------------------ */
/* <dht-sort-group>  排序图标组 + 方向切换                              */
/* ------------------------------------------------------------------ */

// 注意：'relevance' 后端已在 SORT_COLUMNS 支持，此前前端漏接，这里补上
const SORT_KEYS = ['', 'fetchedAt', 'totalSize', 'relevance'];

const SORT_ICONS = {
  '': `<svg ${SVG}><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></svg>`,
  fetchedAt: `<svg ${SVG}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  totalSize: `<svg ${SVG}><path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/></svg>`,
  relevance: `<svg ${SVG}><path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2L12 16.6 5.7 21l2.3-7.2-6-4.4h7.6z"/></svg>`,
};

const ORDER_ICONS = {
  asc: `<svg ${SVG}><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`,
  desc: `<svg ${SVG}><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`,
};

class DhtSortGroup extends HTMLElement {
  constructor() {
    super();
    this._sortBy = '';
    this._order = 'desc';
  }

  set sortBy(v) {
    this._sortBy = SORT_KEYS.includes(v) ? v : '';
    if (this.shadowRoot) this._render();
  }
  get sortBy() { return this._sortBy; }

  set order(v) {
    this._order = v === 'asc' ? 'asc' : 'desc';
    if (this.shadowRoot) this._render();
  }
  get order() { return this._order; }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host { display: inline-flex; gap: 10px; }
          .seg {
            display: flex; align-items: stretch; height: 44px;
            border: 1px solid var(--border); border-radius: 10px;
            overflow: hidden; background: var(--card);
          }
          .sb {
            display: flex; align-items: center; justify-content: center;
            width: 40px; height: 100%; padding: 0; border: none;
            border-right: 1px solid var(--border);
            background: transparent; color: var(--muted); cursor: pointer;
            transition: background 0.15s ease, color 0.15s ease;
          }
          .seg .sb:last-child { border-right: none; }
          .sb:hover { color: var(--text); }
          .sb.active { background: rgba(99, 102, 241, 0.18); color: var(--primary-2); }
          .ob {
            display: flex; align-items: center; justify-content: center;
            width: 40px; height: 44px; padding: 0; border-radius: 10px;
            border: 1px solid var(--border); background: var(--card);
            color: var(--muted); cursor: pointer; transition: color 0.15s ease;
          }
          .ob:hover { color: var(--text); }
        </style>
        <div class="seg">
          <button type="button" class="sb" data-sort="" title="默认排序">${SORT_ICONS['']}</button>
          <button type="button" class="sb" data-sort="fetchedAt" title="按抓取时间排序">${SORT_ICONS.fetchedAt}</button>
          <button type="button" class="sb" data-sort="totalSize" title="按文件大小排序">${SORT_ICONS.totalSize}</button>
          <button type="button" class="sb" data-sort="relevance" title="按相关度排序">${SORT_ICONS.relevance}</button>
        </div>
        <button type="button" class="ob" title="切换升序/降序"></button>`;
      this.shadowRoot.querySelectorAll('.sb').forEach((b) =>
        b.addEventListener('click', () => this._onSort(b.dataset.sort))
      );
      this.shadowRoot.querySelector('.ob').addEventListener('click', () => this._onOrder());
    }
    this._render();
  }

  _onSort(sort) {
    this.sortBy = sort;
    this._emit();
  }
  _onOrder() {
    this.order = this._order === 'desc' ? 'asc' : 'desc';
    this._emit();
  }
  _emit() {
    this.dispatchEvent(new CustomEvent('sort-change', {
      detail: { sortBy: this.sortBy, order: this.order },
      bubbles: true,
    }));
  }

  _render() {
    this.shadowRoot.querySelectorAll('.sb').forEach((b) =>
      b.classList.toggle('active', b.dataset.sort === this._sortBy)
    );
    this.shadowRoot.querySelector('.ob').innerHTML = ORDER_ICONS[this._order];
  }
}
customElements.define('dht-sort-group', DhtSortGroup);
