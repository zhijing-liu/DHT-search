/** 注册自定义元素（<magnet-card> / <magnet-files> / <result-list> / <dht-sort-group>） */
import './components.js';
import { getRpcConfig, saveRpcConfig, showToast } from './util.js';

const state = {
  query: '',
  page: 1,
  /** 每页条数（10-200，自由输入，由 #pageSize 控件控制） */
  pageSize: 20,
  /** 高亮 token：由当前查询提取，hash 检索时为空（不高亮） */
  tokens: [],
  /** 当前查询命中总数（仅用于计算总页数；数据每次从后端按页拉取） */
  total: 0,
  /** 当前结果总页数（供页码跳转输入框校验） */
  totalPages: 1,
  /** 热词数据：null=未加载；数组=已加载（无搜索内容时展示在结果区） */
  hotItems: null,
  /** 输入框下拉提示数据源：热词榜前 1000 个（供相似匹配） */
  hotSuggestions: [],
  /** 关键词编辑模式：开启后热词可加入黑名单、并显示右侧黑名单列表 */
  editMode: false,
  /** 黑名单前端过滤关键字 */
  blacklistFilter: '',
  /** 完整黑名单缓存（用于前端过滤） */
  blacklistItems: [],
};

/** 请求序号：防止快速翻页时旧请求后到覆盖新结果 */
let reqSeq = 0;
/** 当前搜索的 AbortController：用于取消进行中的请求 */
let abortController = null;
/** 是否正在搜索（蒙层显示中）：用于阻止重复请求 */
let isSearching = false;

const el = {
  q: document.getElementById('q'),
  clearBtn: document.getElementById('clearBtn'),
  sortGroup: document.getElementById('sortGroup'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  rpcUrl: document.getElementById('rpcUrl'),
  rpcSecret: document.getElementById('rpcSecret'),
  reindexBtn: document.getElementById('reindexBtn'),
  syncBtn: document.getElementById('syncBtn'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmMsg: document.getElementById('confirmMsg'),
  confirmOk: document.getElementById('confirmOk'),
  confirmCancel: document.getElementById('confirmCancel'),
  results: document.getElementById('results'),
  refreshBtn: document.getElementById('refreshBtn'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  cancelSearchBtn: document.getElementById('cancelSearchBtn'),
  pager: document.getElementById('pager'),
  pagerRow: document.getElementById('pagerRow'),
  pagerInfo: document.getElementById('pagerInfo'),
  pageSize: document.getElementById('pageSize'),
  jumpPage: document.getElementById('jumpPage'),
  hotView: document.getElementById('hotView'),
  editToggle: document.getElementById('editToggle'),
  hotWords: document.getElementById('hotWords'),
  blacklistPanel: document.getElementById('blacklistPanel'),
  blacklistFilter: document.getElementById('blacklistFilter'),
  blacklistList: document.getElementById('blacklistList'),
  blacklistEmpty: document.getElementById('blacklistEmpty'),
  blImportBtn: document.getElementById('blImportBtn'),
  blExportBtn: document.getElementById('blExportBtn'),
  blImportFile: document.getElementById('blImportFile'),
  sizeRange: document.getElementById('sizeRange'),
  countBadge: document.getElementById('countBadge'),
  suggestions: document.getElementById('suggestions'),
};

/** 大小范围固定档位（字节边界） */
const SIZE_RANGES = [
  { value: 'all', label: '全部' },
  { value: 'lt100mb', label: '<100MB', maxBytes: 100 * 1024 * 1024 },
  { value: '100mb-1gb', label: '100MB-1GB', minBytes: 100 * 1024 * 1024, maxBytes: 1 * 1024 * 1024 * 1024 },
  { value: '1gb-10gb', label: '1GB-10GB', minBytes: 1 * 1024 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 * 1024 },
  { value: '10gb-100gb', label: '10GB-100GB', minBytes: 10 * 1024 * 1024 * 1024, maxBytes: 100 * 1024 * 1024 * 1024 },
  { value: 'gt100gb', label: '>100GB', minBytes: 100 * 1024 * 1024 * 1024 },
];

/** 根据当前选中的大小范围档位，返回对应的字节边界 */
function getSizeRangeBytes() {
  const range = SIZE_RANGES.find((r) => r.value === el.sizeRange.value) || SIZE_RANGES[0];
  return {
    minBytes: Number.isFinite(range.minBytes) ? range.minBytes : undefined,
    maxBytes: Number.isFinite(range.maxBytes) ? range.maxBytes : undefined,
  };
}

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
  el.hotView.hidden = true;
  el.results.hidden = false;
  el.refreshBtn.hidden = false;
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

/** 把热词渲染为横向排列的气泡按钮，点击即触发对应关键词搜索；
 *  编辑模式下每个气泡右侧带关闭按钮，点击将关键词加入黑名单 */
function renderHotWords(items) {
  el.hotWords.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无热词数据';
    el.hotWords.appendChild(empty);
    return;
  }
  for (const it of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hot-chip';
    chip.textContent = it.term;
    if (state.editMode) {
      chip.title = `点击右侧 × 将「${it.term}」加入黑名单`;
      chip.classList.add('editing');
      const close = document.createElement('span');
      close.className = 'chip-close';
      close.setAttribute('aria-label', `将「${it.term}」加入黑名单`);
      close.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        addToBlacklist(it.term);
      });
      chip.appendChild(close);
    } else {
      chip.title = `搜索「${it.term}」`;
      chip.addEventListener('click', () => {
        el.q.value = it.term;
        doSearch();
      });
    }
    el.hotWords.appendChild(chip);
  }
}

/** 渲染热词视图（无搜索内容时的默认视图，数据已就绪时调用） */
function renderHotWordsView() {
  setLoading(false);
  el.pagerRow.hidden = true;
  el.pager.hidden = true;
  el.pagerInfo.textContent = '';
  el.results.hidden = true;
  el.refreshBtn.hidden = true;
  el.hotView.hidden = false;
  el.blacklistPanel.hidden = !state.editMode;
  renderHotWords(state.hotItems || []);
}

/* ---------- 黑名单（热词过滤词）管理 ---------- */

/** 拉取并渲染黑名单列表 */
async function fetchBlacklist() {
  try {
    const resp = await fetch('/api/hot/filter');
    const data = await resp.json();
    state.blacklistItems = resp.ok ? data.items || [] : [];
    renderBlacklist(state.blacklistItems);
  } catch {
    state.blacklistItems = [];
    renderBlacklist([]);
  }
}

/** 渲染右侧黑名单列表（支持前端过滤） */
function renderBlacklist(items) {
  const filter = state.blacklistFilter;
  const filtered = filter
    ? items.filter((it) => String(it.term).toLowerCase().includes(filter))
    : items;

  el.blacklistList.replaceChildren();
  el.blacklistEmpty.hidden = filtered.length > 0;
  for (const it of filtered) {
    const li = document.createElement('li');
    li.className = 'bl-item';
    const term = document.createElement('span');
    term.className = 'bl-term';
    term.textContent = it.term;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bl-remove';
    remove.setAttribute('aria-label', `将「${it.term}」移出黑名单`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    remove.addEventListener('click', () => removeFromBlacklist(it.term));
    li.append(term, remove);
    el.blacklistList.appendChild(li);
  }
}

/** 把关键词加入黑名单：从热词视图移除，并刷新黑名单列表 */
async function addToBlacklist(term) {
  try {
    const resp = await fetch('/api/hot/filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    if (!resp.ok) return;
    state.hotItems = (state.hotItems || []).filter((h) => h.term !== term);
    renderHotWords(state.hotItems);
    if (state.editMode) await fetchBlacklist();
  } catch {
    /* 忽略网络错误 */
  }
}

/** 把关键词从黑名单移除：刷新列表并重新拉取热词（被移除的词可能重新出现） */
async function removeFromBlacklist(term) {
  try {
    const resp = await fetch(`/api/hot/filter?term=${encodeURIComponent(term)}`, { method: 'DELETE' });
    if (!resp.ok) return;
    await fetchBlacklist();
    // 重新拉取热词榜，使被解除黑名单的词按热度重新出现
    state.hotItems = null;
    await loadHotData();
  } catch {
    /* 忽略网络错误 */
  }
}

/** 无搜索内容时展示热词视图（数据未加载则先拉取） */
function showHotWords() {
  if (state.hotItems === null) {
    loadHotData();
    return;
  }
  renderHotWordsView();
}

/** 一次拉取热词榜：前 200 条作为默认视图，全部用于输入框下拉提示 */
async function loadHotData() {
  try {
    const resp = await fetch('/api/hot?limit=1000');
    const data = await resp.json();
    const items = resp.ok ? data.items || [] : [];
    state.hotItems = items.slice(0, 200);
    state.hotSuggestions = items;
  } catch {
    state.hotItems = [];
    state.hotSuggestions = [];
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

function renderPager(totalPages) {
  state.totalPages = totalPages;
  if (el.jumpPage) {
    el.jumpPage.max = totalPages;
    el.jumpPage.value = '';
    el.jumpPage.parentElement.hidden = totalPages <= 1;
  }

  el.pager.innerHTML = '';
  if (totalPages <= 1) {
    el.pager.hidden = true;
    return;
  }
  el.pager.hidden = false;

  const ICON_PREV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ICON_NEXT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    if (opts.icon) {
      b.innerHTML = opts.icon;
      b.classList.add('page-nav');
    } else {
      b.textContent = label;
    }
    b.className = 'page-btn';
    b.setAttribute('aria-label', opts.ariaLabel || label);
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

  el.pager.appendChild(mkBtn('上一页', state.page - 1, { disabled: state.page <= 1, icon: ICON_PREV, ariaLabel: '上一页' }));

  // 页码窗口：显示首尾两页 + 当前页前后各两页
  const pageSet = new Set([
    1, 2,
    totalPages - 1, totalPages,
    state.page - 2, state.page - 1, state.page, state.page + 1, state.page + 2,
  ]);
  const pages = [...pageSet].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
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

  el.pager.appendChild(mkBtn('下一页', state.page + 1, { disabled: state.page >= totalPages, icon: ICON_NEXT, ariaLabel: '下一页' }));
}

/* ---------- loading 状态（全屏蒙层） ---------- */

function setLoading(on) {
  isSearching = on;
  el.loadingOverlay.hidden = !on;
}

/** 取消进行中的搜索：中断请求并收起蒙层 */
function cancelSearch() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  isSearching = false;
  el.loadingOverlay.hidden = true;
  showToast('已取消搜索');
}

/* ---------- 真服务端分页：每次查询/排序/翻页都从后端按页拉取 ---------- */

async function fetchPage() {
  if (!state.query) return;
  const mySeq = ++reqSeq; // 丢弃过期响应，避免快速翻页时乱序覆盖

  // 取消上一次仍在进行的请求，避免重复/叠加请求
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

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
  // 大小范围筛选：下拉框固定档位，转换为字节传给后端
  const { minBytes, maxBytes } = getSizeRangeBytes();
  if (Number.isFinite(minBytes)) params.set('minSize', String(minBytes));
  if (Number.isFinite(maxBytes)) params.set('maxSize', String(maxBytes));

  setLoading(true);
  try {
    const resp = await fetch(`/api/search?${params}`, { signal });
    const data = await resp.json();
    if (mySeq !== reqSeq) return; // 已有更新的请求，丢弃本次
    if (!resp.ok) {
      setLoading(false);
      showToast(`查询失败：${data.error || resp.status}`);
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
    el.pagerRow.hidden = false;
    el.pagerInfo.textContent = `共 ${total} 条结果`;

    renderPager(totalPages);
    updateUrl();
  } catch (err) {
    if (mySeq !== reqSeq) return;
    setLoading(false);
    // 主动取消（AbortError）不视为错误
    showToast(err.name === 'AbortError' ? '已取消搜索' : `请求出错：${err.message}`);
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
  if (el.sizeRange.value !== 'all') params.set('sizeRange', el.sizeRange.value);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/* ---------- 搜索 ---------- */

async function doSearch(resetPage = true) {
  // 蒙层显示中（请求进行中）忽略新的搜索触发，防止重复请求
  if (isSearching) return;
  closeSuggestions();
  state.query = el.q.value.trim();
  syncClearBtn();
  if (!state.query) {
    // 没有搜索内容时展示热词视图
    showToast('请输入搜索关键词');
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
  if (el.q.value.trim()) doSearch();
  else handleInputCleared();
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
  try {
    const resp = await fetch('/api/reindex', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(`重建失败：${data.error || resp.status}`);
      return;
    }
    // 索引已更新，沿用当前关键词重搜（无关键词则仅提示）
    state.total = 0;
    if (state.query) {
      await doSearch();
    } else {
      showToast(`索引已重建，共索引 ${data.indexed} 条`);
    }
    await loadCount();
  } catch (err) {
    showToast(`重建出错：${err.message}`);
  } finally {
    el.reindexBtn.disabled = false;
    el.reindexBtn.textContent = label;
  }
}

/* ---------- 增量同步最新索引 ---------- */

async function doSync() {
  const label = el.syncBtn.textContent;
  el.syncBtn.disabled = true;
  el.syncBtn.textContent = '同步中…';
  try {
    const resp = await fetch('/api/sync', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(`同步失败：${data.error || resp.status}`);
      return;
    }
    if (state.query) {
      await doSearch();
    } else {
      await loadCount();
    }
    showToast('索引已同步最新');
  } catch (err) {
    showToast(`同步出错：${err.message}`);
  } finally {
    el.syncBtn.disabled = false;
    el.syncBtn.textContent = label;
  }
}

el.settingsBtn.addEventListener('click', () => el.settingsDialog.showModal());

/* ---------- RPC 推送配置（aria2 / Motrix）持久化 ---------- */
function initRpcSettings() {
  const { url, secret } = getRpcConfig();
  el.rpcUrl.value = url;
  el.rpcSecret.value = secret;
  // 配置项写入 localStorage（键名见 util.js 的 RPC_URL_KEY / RPC_SECRET_KEY）
  const save = () => saveRpcConfig({ url: el.rpcUrl.value, secret: el.rpcSecret.value });
  el.rpcUrl.addEventListener('change', save);
  el.rpcSecret.addEventListener('change', save);
  // 关闭弹窗时兜底保存，避免只在输入框内输入但未失焦就关闭导致丢值
  el.settingsDialog.addEventListener('close', save);
}
initRpcSettings();

el.reindexBtn.addEventListener('click', async () => {
  if (!(await confirmAction('重建索引会重新构建本地 FTS 索引，可能需要较长时间，是否继续？', { danger: true }))) return;
  await doReindex();
});
el.syncBtn.addEventListener('click', async () => {
  if (!(await confirmAction('同步索引将从源库补录新增行，是否继续？'))) return;
  await doSync();
});
el.cancelSearchBtn.addEventListener('click', cancelSearch);

/* ---------- 悬浮刷新按钮：重新发起当前搜索请求（保留页码） ---------- */
el.refreshBtn.addEventListener('click', () => doSearch(false));

/* ---------- DOM 二次确认弹窗（替代浏览器原生 confirm） ---------- */
let confirmResolve = null;

function finishConfirm(result) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

function initConfirmDialog() {
  el.confirmCancel.addEventListener('click', () => {
    el.confirmDialog.close();
    finishConfirm(false);
  });
  el.confirmOk.addEventListener('click', () => {
    el.confirmDialog.close();
    finishConfirm(true);
  });
  // ESC 关闭视为取消（dialog 默认会触发 cancel 事件并自动关闭）
  el.confirmDialog.addEventListener('cancel', () => finishConfirm(false));
}

/** 弹出确认框，返回 Promise<boolean>；danger 为 true 时「确定」按钮呈红色 */
function confirmAction(message, { danger = false } = {}) {
  el.confirmMsg.textContent = message;
  el.confirmOk.classList.toggle('danger', danger);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    el.confirmDialog.showModal();
  });
}
initConfirmDialog();

/* ---------- 关键词编辑模式开关 ---------- */

el.editToggle.addEventListener('change', () => {
  state.editMode = el.editToggle.checked;
  el.blacklistPanel.hidden = !state.editMode;
  state.blacklistFilter = '';
  el.blacklistFilter.value = '';
  if (state.editMode) fetchBlacklist();
  renderHotWords(state.hotItems || []);
});

/* 黑名单前端过滤 */
el.blacklistFilter.addEventListener('input', () => {
  state.blacklistFilter = el.blacklistFilter.value.trim().toLowerCase();
  renderBlacklist(state.blacklistItems || []);
});

/* ---------- 黑名单导入 / 导出（图标按钮） ---------- */

/** 导出：拉取后端导出的文本，触发浏览器下载 */
el.blExportBtn.addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/hot/filter/export');
    if (!resp.ok) {
      showToast('导出失败');
      return;
    }
    const text = await resp.text();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hot-filter-export-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('黑名单已导出');
  } catch {
    showToast('导出出错');
  }
});

/** 导入：选文件 -> 解析为词数组 -> 批量写入后端 */
el.blImportBtn.addEventListener('click', () => el.blImportFile.click());
el.blImportFile.addEventListener('change', async () => {
  const file = el.blImportFile.files?.[0];
  el.blImportFile.value = ''; // 允许重复选择同一文件
  if (!file) return;
  try {
    el.blImportBtn.disabled = true;
    const text = await file.text();
    const terms = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const resp = await fetch('/api/hot/filter/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(`导入失败：${data.error || resp.status}`);
      return;
    }
    showToast(`已导入 ${data.accepted} 条（黑名单共 ${data.total} 条）`);
    await fetchBlacklist();
    // 重新拉取热词，使新过滤词立即生效
    state.hotItems = null;
    await loadHotData();
  } catch (err) {
    showToast(`导入出错：${err.message}`);
  } finally {
    el.blImportBtn.disabled = false;
  }
});

/* ---------- 每页数量控件（固定下拉选项） ---------- */

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100, 200];

function applyPageSize(raw) {
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n)) n = 20;
  // 归到最近的合法档位（URL 携带非标准值时也能正确落位）
  n = PAGE_SIZE_OPTIONS.reduce((closest, opt) =>
    Math.abs(opt - n) < Math.abs(closest - n) ? opt : closest
  , PAGE_SIZE_OPTIONS[0]);
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
  const sizeRange = params.get('sizeRange');
  if (sizeRange && SIZE_RANGES.some((r) => r.value === sizeRange)) {
    el.sizeRange.value = sizeRange;
  }
  if (q) doSearch(false); // 保留 URL 中的页码，不重置为第 1 页
}
initFromUrl();

/* ---------- 输入框清空：清空/删空后同步 URL 并回到热词视图 ---------- */

/** 输入框已为空：重置搜索状态、移除 URL 中的全部搜索参数、回到热词视图 */
function handleInputCleared() {
  const hadSearch = !!state.query;
  // 取消可能仍在进行中的搜索请求，并让其后到的响应自行丢弃，避免覆盖热词视图
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  reqSeq++;
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

el.q.addEventListener('input', () => {
  syncClearBtn();
  const q = el.q.value.trim();
  if (q) {
    openSuggestions();
  } else {
    closeSuggestions();
  }
});

syncClearBtn();

// 无搜索内容时的默认视图：加载热词榜（默认视图 + 下拉提示共用一份）
loadHotData();

el.pageSize.addEventListener('change', () => {
  applyPageSize(el.pageSize.value);
  state.page = 1; // 每页数量变化后回到第一页
  fetchPage();
});

// 页码跳转：回车跳转
el.jumpPage.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const page = parseInt(el.jumpPage.value, 10);
  if (!Number.isFinite(page) || page < 1 || page > state.totalPages) return;
  state.page = page;
  fetchPage();
});

// 大小范围变化后重新搜索（仅在有查询词时；空查询回到热词视图）
el.sizeRange.addEventListener('change', () => { if (state.query) doSearch(); });

loadCount();
