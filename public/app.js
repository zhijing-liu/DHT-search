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
  /** 输入框下拉提示数据源：热词榜前 1000 个（供相似匹配） */
  hotSuggestions: [],
  /** 当前查询模式：{ by, tokens }，查询变化时由 doSearch 计算一次，翻页/排序时复用 */
  mode: { by: undefined, tokens: [] },
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
  suggestions: document.getElementById('suggestions'),
};

/* ---------- 工具 ---------- */

/** 从查询串提取高亮 token（与后端 buildMatchExpression 保持一致：字母数字、小写、去重） */
function extractTokens(q) {
  const m = String(q).match(/[\p{L}\p{N}]+/gu);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
}

/** 判断输入是否为 infohash：连续 40 位十六进制，或带 urn:btih: / hash 前缀（不做字符剥离，避免普通搜索词被误判） */
function isInfohash(q) {
  const s = String(q).trim().toLowerCase();
  if (s.includes('urn:btih:')) return /^.*urn:btih:[a-f0-9]{40}$/.test(s);
  if (s.startsWith('hash')) return /^hash[a-f0-9]{40}$/.test(s);
  return /^[a-f0-9]{40}$/.test(s);
}

/** 判断当前查询模式：infohash 走精确检索（不高亮），否则 FTS 模糊检索并提取高亮 token */
function detectMode(query) {
  const hashMode = isInfohash(query);
  return { by: hashMode ? 'hash' : undefined, tokens: hashMode ? [] : extractTokens(query) };
}

const numberFmt = new Intl.NumberFormat('zh-CN');

/** 格式化计数 */
function formatCount(n) {
  return numberFmt.format(Number(n) || 0);
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

/** 渲染空状态提示 */
function renderEmpty(message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  el.results.appendChild(empty);
}

function renderResults(items) {
  el.results.replaceChildren();
  if (!items.length) {
    renderEmpty('没有找到匹配的结果');
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
    renderEmpty('暂无热词数据');
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

/** 渲染热词视图（无搜索内容时的默认视图，数据已就绪时调用） */
function renderHotWordsView() {
  setLoading(false);
  el.pager.hidden = true;
  el.status.textContent = state.hotItems.length ? '热门关键词' : '';
  renderHotWords(state.hotItems);
}

/** 无搜索内容时展示热词视图（数据未加载则先拉取） */
function showHotWords() {
  if (state.hotItems === null) {
    loadHotWords();
    return;
  }
  renderHotWordsView();
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
  if (!state.query) renderHotWordsView();
}

/* ---------- 输入框下拉提示（搜索引擎式自动补全） ---------- */

/** 当前下拉中可选的建议项（与渲染列表一一对应） */
let currentSuggestions = [];
/** 当前高亮的建议项索引（-1 表示无高亮） */
let activeSuggestion = -1;

/** Levenshtein 编辑距离，用于热词模糊相似匹配 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
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
 * 从热词中相似匹配：完全相等 > 前缀 > 包含 > 模糊，
 * 各分组内按热度（doc_count 降序，次之 occurrences）排序。
 */
function matchSuggestions(q, max = 8) {
  const query = String(q).trim().toLowerCase();
  if (!query) return [];
  const groups = { exact: [], prefix: [], include: [], fuzzy: [] };
  for (const it of state.hotSuggestions) {
    const term = String(it.term).toLowerCase();
    if (term === query) groups.exact.push(it);
    else if (term.startsWith(query)) groups.prefix.push(it);
    else if (term.includes(query)) groups.include.push(it);
    else if (isFuzzyMatch(term, query)) groups.fuzzy.push(it);
  }
  const byHot = (a, b) => b.doc_count - a.doc_count || b.occurrences - a.occurrences;
  return [...groups.exact, ...groups.prefix, ...groups.include, ...groups.fuzzy]
    .sort(byHot)
    .slice(0, max);
}

/** 渲染提示下拉列表 */
function renderSuggestions(items) {
  const box = el.suggestions;
  box.replaceChildren();
  const query = el.q.value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'suggestion-item';
    const term = document.createElement('span');
    term.className = 'sug-term';
    const idx = String(it.term).toLowerCase().indexOf(query);
    if (idx >= 0) {
      const mark = document.createElement('mark');
      mark.textContent = it.term.slice(idx, idx + query.length);
      term.append(
        document.createTextNode(it.term.slice(0, idx)),
        mark,
        document.createTextNode(it.term.slice(idx + query.length))
      );
    } else {
      term.textContent = it.term;
    }
    const count = document.createElement('span');
    count.className = 'sug-count';
    count.textContent = `${formatCount(it.doc_count)} 条`;
    row.append(term, count);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 阻止输入框失焦导致下拉先关闭
      selectSuggestion(it.term);
    });
    row.addEventListener('mouseenter', () => {
      activeSuggestion = i;
      setActiveRow();
    });
    frag.appendChild(row);
  });
  box.appendChild(frag);
  box.hidden = false;
}

/** 按 activeSuggestion 高亮当前建议项，并保证可见 */
function setActiveRow() {
  const rows = el.suggestions.querySelectorAll('.suggestion-item');
  rows.forEach((row, i) => row.classList.toggle('active', i === activeSuggestion));
  const cur = rows[activeSuggestion];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

/** 输入变化时刷新下拉提示 */
function openSuggestions() {
  const q = el.q.value;
  if (!q.trim()) {
    closeSuggestions();
    return;
  }
  currentSuggestions = matchSuggestions(q);
  activeSuggestion = -1;
  if (!currentSuggestions.length) {
    closeSuggestions();
    return;
  }
  renderSuggestions(currentSuggestions);
}

/** 关闭并清空下拉提示 */
function closeSuggestions() {
  el.suggestions.hidden = true;
  el.suggestions.replaceChildren();
  currentSuggestions = [];
  activeSuggestion = -1;
}

/** 选中某条建议：填入输入框并执行搜索 */
function selectSuggestion(term) {
  el.q.value = term;
  doSearch();
  el.q.focus();
}

/** 拉取输入框下拉提示数据源：热词榜前 1000 个 */
async function loadSuggestions() {
  try {
    const resp = await fetch('/api/hot?limit=1000');
    const data = await resp.json();
    state.hotSuggestions = resp.ok ? data.items || [] : [];
  } catch {
    state.hotSuggestions = [];
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
  closeSuggestions();
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
  if (e.key === 'Enter') {
    if (!el.suggestions.hidden && activeSuggestion >= 0) {
      e.preventDefault();
      selectSuggestion(currentSuggestions[activeSuggestion].term);
      return;
    }
    closeSuggestions();
    doSearch();
    return;
  }
  if (!el.suggestions.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const n = currentSuggestions.length;
      activeSuggestion = Math.min(n - 1, Math.max(0, activeSuggestion + dir));
      setActiveRow();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSuggestions();
    }
  }
});
// 失焦后延迟关闭下拉，避免鼠标点击选择时下拉先被关闭
el.q.addEventListener('blur', () => setTimeout(closeSuggestions, 150));

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
  const q = el.q.value.trim();
  if (q) {
    openSuggestions();
  } else {
    closeSuggestions();
  }
  if (q === '' && prevInput.trim() !== '') handleInputCleared();
  prevInput = el.q.value;
});

syncClearBtn();

// 无搜索内容时的默认视图：加载热词榜；同时加载输入框下拉提示数据源
loadHotWords();
loadSuggestions();

el.pageSize.addEventListener('change', () => {
  applyPageSize(el.pageSize.value);
  state.page = 1; // 每页数量变化后回到第一页
  fetchPage();
});

loadCount();
