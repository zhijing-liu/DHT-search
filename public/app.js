'use strict';

/** 注册自定义元素（<magnet-card> / <magnet-files> / <result-list> / <dht-sort-group>） */
import './components.js';

const state = {
  query: '',
  page: 1,
  /** 每页条数（10-200，自由输入，由 #pageSize 控件控制） */
  pageSize: 20,
  /** 高亮 token：由当前查询提取，hash 检索时为空（不高亮） */
  tokens: [],
  /** 当前查询命中总数（仅用于计算总页数；数据每次从后端按页拉取） */
  total: 0,
  /** 热词数据：null=未加载；数组=已加载（无搜索内容时展示在结果区） */
  hotItems: null,
};

/** 请求序号：防止快速翻页时旧请求后到覆盖新结果 */
let reqSeq = 0;

const el = {
  q: document.getElementById('q'),
  clearBtn: document.getElementById('clearBtn'),
  sortGroup: document.getElementById('sortGroup'),
  reindexBtn: document.getElementById('reindexBtn'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  pager: document.getElementById('pager'),
  pageSize: document.getElementById('pageSize'),
  countBadge: document.getElementById('countBadge'),
};

/* ---------- 工具 ---------- */

/** 从查询串提取高亮 token（与后端 buildMatchExpression 保持一致：字母数字、小写、去重） */
function extractTokens(q) {
  const m = String(q).match(/[\p{L}\p{N}]+/gu);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
}

/** 判断输入是否为 infohash：40 位十六进制，或含 urn:btih:/hash 前缀 */
function isInfohash(q) {
  const s = String(q).trim().toLowerCase();
  const h = s.replace(/^.*urn:btih:/, '').replace(/[^a-f0-9]/g, '').replace(/^hash/, '');
  return h.length === 40;
}

/** 格式化计数 */
function formatCount(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
}

/** 拉取并刷新右上角种子数量 */
async function loadCount() {
  try {
    const resp = await fetch('/api/count');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    el.countBadge.textContent = `已索引 ${formatCount(data.count)} 条`;
  } catch {
    el.countBadge.textContent = '索引数未知';
  }
}

/* ---------- 渲染 ---------- */

function renderItem(item) {
  const card = document.createElement('magnet-card');
  card.item = item;
  card.highlight = state.tokens;
  return card;
}

function renderResults(items) {
  el.results.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '没有找到匹配的结果';
    el.results.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(renderItem(it));
  el.results.appendChild(frag);
}

/* ---------- 热词（无搜索内容时的默认视图） ---------- */

/** 把热词渲染为横向排列的气泡按钮，点击即触发对应关键词搜索 */
function renderHotWords(items) {
  el.results.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无热词数据';
    el.results.appendChild(empty);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'hot-words';
  for (const it of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hot-chip';
    chip.textContent = it.term;
    chip.title = `搜索「${it.term}」`;
    chip.addEventListener('click', () => {
      el.q.value = it.term;
      doSearch();
    });
    wrap.appendChild(chip);
  }
  el.results.appendChild(wrap);
}

/** 无搜索内容时展示热词视图（数据未加载则先拉取） */
function showHotWords() {
  if (state.hotItems === null) {
    loadHotWords();
    return;
  }
  setLoading(false);
  el.pager.hidden = true;
  el.status.textContent = state.hotItems.length ? '热门关键词' : '';
  renderHotWords(state.hotItems);
}

/** 拉取热词榜数据；完成后仅当当前无搜索内容时渲染，避免覆盖搜索结果 */
async function loadHotWords() {
  try {
    const resp = await fetch('/api/hot?limit=200');
    const data = await resp.json();
    state.hotItems = resp.ok ? data.items || [] : [];
  } catch {
    state.hotItems = [];
  }
  if (!state.query) {
    setLoading(false);
    el.pager.hidden = true;
    el.status.textContent = state.hotItems.length ? '热门关键词' : '';
    renderHotWords(state.hotItems);
  }
}

function renderPager(totalPages) {
  el.pager.innerHTML = '';
  if (totalPages <= 1) {
    el.pager.hidden = true;
    return;
  }
  el.pager.hidden = false;

  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'page-btn';
    if (opts.active) b.classList.add('active');
    if (opts.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => {
        state.page = page;
        fetchPage();
      });
    }
    return b;
  };

  el.pager.appendChild(mkBtn('上一页', state.page - 1, { disabled: state.page <= 1 }));

  // 页码窗口：显示首尾页 + 当前页附近
  const window = new Set([1, totalPages, state.page - 1, state.page, state.page + 1]);
  const pages = [...window].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) {
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.textContent = '…';
      el.pager.appendChild(dots);
    }
    el.pager.appendChild(mkBtn(String(p), p, { active: p === state.page }));
    prev = p;
  }

  el.pager.appendChild(mkBtn('下一页', state.page + 1, { disabled: state.page >= totalPages }));
}

/* ---------- loading 状态 ---------- */

function setLoading(on) {
  el.status.classList.toggle('loading', on);
  if (on) el.status.textContent = '加载中…';
}

/* ---------- 真服务端分页：每次查询/排序/翻页都从后端按页拉取 ---------- */

async function fetchPage() {
  if (!state.query) return;
  const mySeq = ++reqSeq; // 丢弃过期响应，避免快速翻页时乱序覆盖

  const hashMode = isInfohash(state.query);
  const by = hashMode ? 'hash' : undefined;
  const pageSize = state.pageSize;
  const offset = (state.page - 1) * pageSize;

  const params = new URLSearchParams({
    q: state.query,
    sortBy: el.sortGroup.sortBy,
    order: el.sortGroup.order,
    limit: String(pageSize),
    offset: String(offset),
  });
  if (by) params.set('by', by);

  setLoading(true);
  try {
    const resp = await fetch(`/api/search?${params}`);
    const data = await resp.json();
    if (mySeq !== reqSeq) return; // 已有更新的请求，丢弃本次
    if (!resp.ok) {
      setLoading(false);
      el.status.textContent = `查询失败：${data.error || resp.status}`;
      return;
    }

    const items = data.items || [];
    const total = Number(data.total) || 0;
    state.total = total;

    renderResults(items);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + pageSize, total);
    setLoading(false);
    el.status.textContent = `共 ${total} 条结果，第 ${state.page}/${totalPages} 页（${from}-${to}）`;

    renderPager(totalPages);
    updateUrl();
  } catch (err) {
    if (mySeq !== reqSeq) return;
    setLoading(false);
    el.status.textContent = `请求出错：${err.message}`;
  }
}

/* ---------- URL 状态同步 ---------- */

/** 把当前 q / sortBy / order / page 写回地址栏，便于刷新保持与分享 */
function updateUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (el.sortGroup.sortBy) params.set('sortBy', el.sortGroup.sortBy);
  if (el.sortGroup.order !== 'desc') params.set('order', el.sortGroup.order);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.pageSize !== 20) params.set('pageSize', String(state.pageSize));
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/* ---------- 搜索 ---------- */

async function doSearch(resetPage = true) {
  state.query = el.q.value.trim();
  syncClearBtn();
  if (!state.query) {
    // 没有搜索内容时展示热词视图
    showHotWords();
    return;
  }
  if (resetPage) state.page = 1;

  // 输入为 infohash 时走精确检索，否则走 FTS5 模糊检索并提取高亮 token
  const hashMode = isInfohash(state.query);
  state.tokens = hashMode ? [] : extractTokens(state.query);

  // 每次查询/排序变更都从后端按页拉取（真服务端分页）
  await fetchPage();
}

// 输入框值变化（失焦触发 change）：去除前后空格后有值则搜索，空值则回到热词视图
el.q.addEventListener('change', () => {
  const q = el.q.value.trim();
  if (q) {
    doSearch();
  } else {
    handleInputCleared();
  }
});
el.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

/* ---------- 排序交互 ---------- */

el.sortGroup.addEventListener('sort-change', () => {
  doSearch();
});

/* ---------- 重建索引 ---------- */

async function doReindex() {
  const label = el.reindexBtn.textContent;
  el.reindexBtn.disabled = true;
  el.reindexBtn.textContent = '重建中…';
  el.status.textContent = '正在重建索引…';
  try {
    const resp = await fetch('/api/reindex', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      el.status.textContent = `重建失败：${data.error || resp.status}`;
      return;
    }
    // 索引已更新，沿用当前关键词重搜（无关键词则仅提示）
    state.total = 0;
    if (state.query) {
      await doSearch();
    } else {
      el.status.textContent = `索引已重建，共索引 ${data.indexed} 条`;
    }
    await loadCount();
  } catch (err) {
    el.status.textContent = `重建出错：${err.message}`;
  } finally {
    el.reindexBtn.disabled = false;
    el.reindexBtn.textContent = label;
  }
}

el.reindexBtn.addEventListener('click', doReindex);

/* ---------- 每页数量控件（10-200，自由输入） ---------- */

function applyPageSize(raw) {
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n)) n = 20;
  n = Math.min(200, Math.max(10, n));
  state.pageSize = n;
  el.pageSize.value = String(n);
}

/* ---------- 从 URL 恢复视图（刷新/分享链接可还原） ---------- */

function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const sortBy = params.get('sortBy');
  const order = params.get('order');
  const page = params.get('page');
  if (q) el.q.value = q;
  if (sortBy) el.sortGroup.sortBy = sortBy;
  if (order) el.sortGroup.order = order;
  if (page) state.page = Math.max(1, parseInt(page, 10) || 1);
  const ps = params.get('pageSize');
  if (ps) applyPageSize(ps);
  if (q) doSearch(false); // 保留 URL 中的页码，不重置为第 1 页
}
initFromUrl();

/* ---------- 输入框清空：清空/删空后同步 URL 并回到热词视图 ---------- */

/** 输入框已为空：重置搜索状态、移除 URL 中的全部搜索参数、回到热词视图 */
function handleInputCleared() {
  const hadSearch = !!state.query;
  state.query = '';
  state.page = 1;
  state.tokens = [];
  state.total = 0;
  history.replaceState(null, '', location.pathname); // 移除全部 query 参数
  if (hadSearch) showHotWords();
}

/** 根据输入框内容同步清空按钮的显隐 */
function syncClearBtn() {
  el.clearBtn.hidden = el.q.value.trim() === '';
}

el.clearBtn.addEventListener('click', () => {
  el.q.value = '';
  syncClearBtn();
  handleInputCleared();
  el.q.focus();
});

let prevInput = '';
el.q.addEventListener('input', () => {
  syncClearBtn();
  const isEmpty = el.q.value.trim() === '';
  if (isEmpty && prevInput.trim() !== '') handleInputCleared();
  prevInput = el.q.value;
});

syncClearBtn();

// 无搜索内容时的默认视图：加载热词榜
loadHotWords();

el.pageSize.addEventListener('change', () => {
  applyPageSize(el.pageSize.value);
  state.page = 1; // 每页数量变化后回到第一页
  fetchPage();
});

loadCount();
