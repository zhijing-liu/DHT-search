/**
 * 自定义元素（<magnet-card> / <magnet-files> / <result-list> / <dht-sort-group>）
 * ------------------------------------------------------------------
 * 全部采用 **light DOM**：不再 attachShadow，因此全局 Tailwind 工具类可直接生效，
 * 组件样式文件（magnet-card.css / magnet-files.css / result-list.css /
 * dht-sort-group.css）全部删除。
 * 代价是失去样式隔离，但元素外观 100% 由工具类描述，不存在裸标签选择器泄漏。
 * 附带收益：结果列表一次最多渲染 200 张卡片，不再为每个实例创建 CSSStyleSheet。
 *
 * 注意：模板中的 .title / .magnet-text / .copy / .rpc / .detail / .meta / .sb / .ob
 * 等类名已不再承担样式职责，仅作为 querySelector 的行为契约，请勿删除。
 */

import { formatBytes, formatDate, normalizeFiles, copyText, toThunder, highlightInto, pushToAria2 } from './util.js';
import { buildFileTree, computeTreeSizes, renderTreeNode, fileMatchScore, PREVIEW_LIMIT } from './file-tree.js';

const SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** 卡片与文件树共用的关键词高亮样式（作用于后代 <mark>） */
const MARK = '[&_mark]:rounded-[3px] [&_mark]:bg-brand/[0.35] [&_mark]:px-0.5 [&_mark]:text-white';

/* ------------------------------------------------------------------ */
/* <magnet-files>  文件树（可折叠，默认展开第一级）                    */
/* ------------------------------------------------------------------ */

const FILES_UL_CLASS = 'list-none m-0 p-0';
const FILES_LI_CLASS = 'text-[clamp(12px,calc(11px_+_0.3vw),13px)] py-0.5 flex gap-1.5 items-baseline';
const FILES_NAME_CLASS = `text-fg break-all ${MARK}`;
const FILES_SIZE_CLASS = 'shrink-0 text-muted whitespace-nowrap';
const FILES_MORE_CLASS = 'text-muted text-[clamp(11px,calc(10px_+_0.3vw),12px)] pt-1';

class MagnetFiles extends HTMLElement {
  set files(value) {
    this._files = value;
    if (this._built) this._render();
  }
  set highlight(value) {
    this._highlight = value;
    if (this._built) this._render();
  }
  /** 一次性设置文件与高亮，避免两个 setter 各自触发一次渲染 */
  setData(files, highlight) {
    this._files = files;
    this._highlight = highlight;
    if (this._built) this._render();
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    const ul = document.createElement('ul');
    ul.className = FILES_UL_CLASS;
    this.appendChild(ul);
    if (this._files !== undefined) this._render();
  }

  _render() {
    const ul = this.querySelector('ul');
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
      li.className = FILES_LI_CLASS;
      const name = document.createElement('span');
      name.className = FILES_NAME_CLASS;
      highlightInto(name, f.path || '(未命名)', tokens);
      const size = document.createElement('span');
      size.className = FILES_SIZE_CLASS;
      size.textContent = formatBytes(Number(f.size));
      li.append(name, size);
      ul.appendChild(li);
    }

    if (preview.length && list.length > preview.length) {
      const more = document.createElement('div');
      more.className = FILES_MORE_CLASS;
      more.textContent = `…及其他 ${list.length - preview.length} 个文件（点「查看全部文件」展开）`;
      ul.appendChild(more);
    }
  }
}
customElements.define('magnet-files', MagnetFiles);

/* ------------------------------------------------------------------ */
/* <magnet-card>  单条结果卡片                                          */
/* ------------------------------------------------------------------ */

/** 卡片本体（原 :host） */
const CARD_CLASS =
  'block bg-card border border-line rounded-xl ' +
  'p-[clamp(12px,2vw,16px)_clamp(14px,2.5vw,18px)] ' +
  'transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-accent';

/** 复制 / 迅雷 / 推送 / 关闭：统一图标按钮外观 */
const ICON_BTN_CLASS =
  'flex-none inline-flex items-center justify-center size-[30px] p-0 rounded-lg ' +
  'border border-line bg-transparent text-fg cursor-pointer ' +
  'transition-colors hover:bg-white/[0.08] ' +
  '[&_svg]:size-[15px] [&_svg]:block';

class MagnetCard extends HTMLElement {
  set item(value) {
    this._item = value;
    if (this._built) this._render();
  }
  set highlight(value) {
    this._highlight = value;
    if (this._built) this._render();
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.className = CARD_CLASS;
    this.innerHTML = `
        <h2 class="title m-0 mb-2 text-[clamp(14px,calc(13px_+_0.4vw),16px)] font-medium break-all ${MARK}"></h2>
        <div class="magnet flex items-center gap-2 mb-2">
          <a class="magnet-text flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-brand2 text-[clamp(11px,calc(10px_+_0.3vw),12px)] no-underline cursor-pointer hover:underline" href=""></a>
          <button class="copy ${ICON_BTN_CLASS} [&.copied]:text-green-400 [&.copied]:border-green-400" type="button" aria-label="复制磁力链接" title="复制磁力链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <a class="thunder ${ICON_BTN_CLASS} no-underline hover:border-accent hover:text-accent" aria-label="迅雷下载" title="迅雷下载" href=""><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg></a>
          <button class="rpc ${ICON_BTN_CLASS} hover:border-green-400 hover:text-green-400" type="button" aria-label="RPC 推送" title="推送到下载器（aria2 / Motrix）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
        </div>
        <div class="files-row flex items-start gap-2">
          <magnet-files class="block flex-1 min-w-0 mb-2"></magnet-files>
          <button class="detail flex-none self-center px-2.5 py-[5px] rounded-lg border border-line bg-transparent text-fg cursor-pointer text-[clamp(12px,calc(11px_+_0.3vw),13px)] whitespace-nowrap transition-colors hover:bg-white/[0.08]" type="button" hidden>查看全部文件</button>
        </div>
        <div class="meta text-muted text-[clamp(11px,calc(10px_+_0.3vw),12px)]"></div>
        <dialog class="w-[min(720px,96vw)] h-[86vh] p-0 border border-line rounded-[14px] text-fg bg-surface [&::backdrop]:bg-black/60 open:flex open:flex-col"></dialog>`;
    this.querySelector('.copy').addEventListener('click', (e) => {
      copyText(this._item?.magnet || '', e.currentTarget);
    });
    this.querySelector('.rpc').addEventListener('click', () => {
      pushToAria2(this._item?.magnet || '');
    });
    this.querySelector('.detail').addEventListener('click', () => this._openDetail());
    if (this._item !== undefined) this._render();
  }

  _render() {
    const it = this._item || {};
    highlightInto(this.querySelector('.title'), it.name || '(无名)', this._highlight);
    const mt = this.querySelector('.magnet-text');
    mt.href = it.magnet || '';
    mt.textContent = it.magnet || '';
    mt.title = it.magnet || '';
    const th = this.querySelector('.thunder');
    const tUrl = toThunder(it.magnet);
    th.href = tUrl;
    th.hidden = !tUrl;
    const mf = this.querySelector('magnet-files');
    mf.setData(it.files, this._highlight);
    this.querySelector('.meta').textContent =
      `大小 ${formatBytes(Number(it.totalSize))} · 抓取于 ${formatDate(Number(it.fetchedAt))}`;
    this.querySelector('.detail').hidden = normalizeFiles(it.files).length <= PREVIEW_LIMIT;
  }

  /** 懒渲染完整详情弹窗（树 + 元数据），仅在点击时构建，列表不渲染树 */
  _openDetail() {
    const it = this._item || {};
    const dlg = this.querySelector('dialog');
    dlg.innerHTML = `
      <div class="dlg-head flex-none flex items-start gap-2.5 p-[clamp(12px,2vw,16px)_clamp(14px,2.5vw,18px)] border-b border-line">
        <h3 class="dlg-title m-0 flex-1 text-[clamp(14px,calc(13px_+_0.4vw),16px)] font-semibold break-all ${MARK}"></h3>
        <button class="close ${ICON_BTN_CLASS}" type="button" aria-label="关闭" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="dlg-body flex-1 flex flex-col overflow-hidden p-[clamp(12px,2vw,16px)_clamp(14px,2.5vw,18px)]">
        <div class="dlg-meta flex-none">
          <div class="dlg-row flex gap-2 mb-1.5 text-[clamp(12px,calc(11px_+_0.3vw),13px)]"><span class="k flex-none w-16 text-muted">磁力链接</span><a class="v v-link no-underline cursor-pointer hover:underline" href=""></a></div>
          <div class="dlg-row flex gap-2 mb-1.5 text-[clamp(12px,calc(11px_+_0.3vw),13px)]"><span class="k flex-none w-16 text-muted">infohash</span><span class="v break-all"></span></div>
          <div class="dlg-row flex gap-2 mb-1.5 text-[clamp(12px,calc(11px_+_0.3vw),13px)]"><span class="k flex-none w-16 text-muted">大小</span><span class="v break-all"></span></div>
          <div class="dlg-row flex gap-2 mb-1.5 text-[clamp(12px,calc(11px_+_0.3vw),13px)]"><span class="k flex-none w-16 text-muted">抓取于</span><span class="v break-all"></span></div>
        </div>
        <ul class="dlg-files flex-1 overflow-auto min-h-0 list-none m-0 mt-3 p-0 scrollbar-thin"></ul>
      </div>`;
    highlightInto(dlg.querySelector('.dlg-title'), it.name || '(无名)', this._highlight);
    const vals = dlg.querySelectorAll('.dlg-row .v');
    vals[0].href = it.magnet || '';
    vals[0].textContent = it.magnet || '';
    vals[0].style.color = 'var(--color-brand2)';
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

/**
 * light DOM：不再使用 <slot>——<magnet-card> 本就是它的真实子节点，
 * 去掉 shadowRoot 后直接渲染。容器自身的外观由 index.html 上的工具类提供
 * （自定义元素默认 display:inline，必须显式给出 display 才能成为滚动容器）。
 */
class ResultList extends HTMLElement {
  connectedCallback() { /* 无需构建 DOM */ }
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

/** 分段控件内的排序按钮 */
const SEG_BTN_CLASS =
  'flex items-center justify-center w-[clamp(34px,4vw,40px)] h-full p-0 ' +
  'border-0 border-r border-line bg-transparent text-muted cursor-pointer ' +
  'transition-colors last:border-r-0 hover:text-fg ' +
  '[&.active]:bg-brand/[0.18] [&.active]:text-brand2';

class DhtSortGroup extends HTMLElement {
  constructor() {
    super();
    this._sortBy = '';
    this._order = 'desc';
  }

  set sortBy(v) {
    this._sortBy = SORT_KEYS.includes(v) ? v : '';
    if (this._built) this._render();
  }
  get sortBy() { return this._sortBy; }

  set order(v) {
    this._order = v === 'asc' ? 'asc' : 'desc';
    if (this._built) this._render();
  }
  get order() { return this._order; }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = `
        <div class="seg flex items-stretch h-full border border-line rounded-[10px] overflow-hidden bg-card">
          <button type="button" class="sb ${SEG_BTN_CLASS}" data-sort="" title="默认排序">${SORT_ICONS['']}</button>
          <button type="button" class="sb ${SEG_BTN_CLASS}" data-sort="fetchedAt" title="按抓取时间排序">${SORT_ICONS.fetchedAt}</button>
          <button type="button" class="sb ${SEG_BTN_CLASS}" data-sort="totalSize" title="按文件大小排序">${SORT_ICONS.totalSize}</button>
          <button type="button" class="sb ${SEG_BTN_CLASS}" data-sort="relevance" title="按相关度排序">${SORT_ICONS.relevance}</button>
        </div>
        <button type="button" class="ob flex items-center justify-center w-[clamp(34px,4vw,40px)] h-full p-0 rounded-[10px] border border-line bg-card text-muted cursor-pointer transition-colors hover:text-fg" title="切换升序/降序"></button>`;
    this.querySelectorAll('.sb').forEach((b) =>
      b.addEventListener('click', () => this._onSort(b.dataset.sort))
    );
    this.querySelector('.ob').addEventListener('click', () => this._onOrder());
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
    this.querySelectorAll('.sb').forEach((b) =>
      b.classList.toggle('active', b.dataset.sort === this._sortBy)
    );
    this.querySelector('.ob').innerHTML = ORDER_ICONS[this._order];
  }
}
customElements.define('dht-sort-group', DhtSortGroup);
