/* 组件样式以原生 CSS Module 形式引入（浏览器需支持 import attributes / CSS modules），
   通过 shadowRoot.adoptedStyleSheets 注入，避免把 CSS 写进 JS 文本 */
import magnetCardCss from '../css/magnet-card.css' with { type: 'css' };
import magnetFilesCss from '../css/magnet-files.css' with { type: 'css' };
import resultListCss from '../css/result-list.css' with { type: 'css' };
import sortGroupCss from '../css/dht-sort-group.css' with { type: 'css' };

import { formatBytes, formatDate, normalizeFiles, copyText, toThunder, highlightInto } from './util.js';
import { buildFileTree, computeTreeSizes, renderTreeNode, fileMatchScore, PREVIEW_LIMIT } from './file-tree.js';

const SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/* ------------------------------------------------------------------ */
/* <magnet-files>  文件树（可折叠，默认展开第一级）                    */
/* ------------------------------------------------------------------ */

class MagnetFiles extends HTMLElement {
  set files(value) {
    this._files = value;
    if (this.shadowRoot) this._render();
  }
  set highlight(value) {
    this._highlight = value;
    if (this.shadowRoot) this._render();
  }
  /** 一次性设置文件与高亮，避免两个 setter 各自触发一次渲染 */
  setData(files, highlight) {
    this._files = files;
    this._highlight = highlight;
    if (this.shadowRoot) this._render();
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: 'open' });
      root.adoptedStyleSheets = [magnetFilesCss];
      root.innerHTML = `<ul class="files"></ul>`;
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
      const root = this.attachShadow({ mode: 'open' });
      root.adoptedStyleSheets = [magnetCardCss];
      root.innerHTML = `
        <h2 class="title"></h2>
        <div class="magnet">
          <a class="magnet-text" href=""></a>
          <button class="copy" type="button" aria-label="复制磁力链接" title="复制磁力链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <a class="thunder" aria-label="迅雷下载" title="迅雷下载" href=""><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg></a>
        </div>
        <div class="files-row">
          <magnet-files></magnet-files>
          <button class="detail" type="button" hidden>查看全部文件</button>
        </div>
        <div class="meta"></div>
        <dialog></dialog>`;
      root.querySelector('.copy').addEventListener('click', (e) => {
        copyText(this._item?.magnet || '', e.currentTarget);
      });
      root.querySelector('.detail').addEventListener('click', () => this._openDetail());
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
    mf.setData(it.files, this._highlight);
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
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [resultListCss];
    root.innerHTML = `<slot></slot>`;
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
      const root = this.attachShadow({ mode: 'open' });
      root.adoptedStyleSheets = [sortGroupCss];
      root.innerHTML = `
        <div class="seg">
          <button type="button" class="sb" data-sort="" title="默认排序">${SORT_ICONS['']}</button>
          <button type="button" class="sb" data-sort="fetchedAt" title="按抓取时间排序">${SORT_ICONS.fetchedAt}</button>
          <button type="button" class="sb" data-sort="totalSize" title="按文件大小排序">${SORT_ICONS.totalSize}</button>
          <button type="button" class="sb" data-sort="relevance" title="按相关度排序">${SORT_ICONS.relevance}</button>
        </div>
        <button type="button" class="ob" title="切换升序/降序"></button>`;
      root.querySelectorAll('.sb').forEach((b) =>
        b.addEventListener('click', () => this._onSort(b.dataset.sort))
      );
      root.querySelector('.ob').addEventListener('click', () => this._onOrder());
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
