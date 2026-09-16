/**
 * 页面主组件（Alpine.data('searchPage')）
 * ------------------------------------------------------------------
 * 唯一的状态源：所有渲染由 index.html 的模板绑定驱动，所有交互在模板里声明，
 * 本文件不查询、不构造任何 DOM。只读派生值一律做成 getter 供模板直接读；
 * 网络与提示交给 api.js / toast.js。
 */
import Alpine from 'alpinejs';
import * as api from './api.js';
import { ICONS } from './icons.js';
import { showToast } from './toast.js';
import {
  extractTokens,
  formatBytes,
  formatCount,
  formatCountdown,
  getRpcConfig,
  highlightHtml,
  isInfohash,
  matchSuggestions,
  saveRpcConfig,
  downloadText,
} from './util.js';

/** 默认每页条数（与模板里 <select id="pageSize"> 的默认项一致） */
const DEFAULT_PAGE_SIZE = 20;

/**
 * loading 蒙层的出现延迟（毫秒）：请求及时返回就不显示蒙层。
 * 「请求在途」(searching) 立刻为真以挡住重复触发，蒙层显隐另行延后。
 */
const LOADING_DELAY_MS = 300;

/** 每页条数固定档位 */
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100, 200];

/** 大小范围档位（字节边界；模板中的下拉选项与之 value 一一对应） */
const SIZE_RANGES = [
  { value: 'all', label: '全部' },
  { value: 'lt100mb', label: '<100MB', maxBytes: 100 * 1024 * 1024 },
  { value: '100mb-1gb', label: '100MB-1GB', minBytes: 100 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024 },
  { value: '1gb-10gb', label: '1GB-10GB', minBytes: 1024 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 * 1024 },
  { value: '10gb-100gb', label: '10GB-100GB', minBytes: 10 * 1024 * 1024 * 1024, maxBytes: 100 * 1024 * 1024 * 1024 },
  { value: 'gt100gb', label: '>100GB', minBytes: 100 * 1024 * 1024 * 1024 },
];

/** 排序键（'' 表示默认排序，由后端按 id 倒序） */
const SORT_KEYS = [
  { value: '', title: '默认排序', icon: ICONS.sortDefault },
  { value: 'fetchedAt', title: '按抓取时间排序', icon: ICONS.sortFetchedAt },
  { value: 'totalSize', title: '按文件大小排序', icon: ICONS.sortTotalSize },
  { value: 'relevance', title: '按相关度排序', icon: ICONS.sortRelevance },
];

/** 分页按钮样式（模板外动态生成，故写成完整字面量以便 Tailwind 收集） */
const PAGE_BTN_CLASS =
  'min-w-9 rounded-lg border border-line bg-card text-fg cursor-pointer transition-colors ' +
  'enabled:hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed ' +
  '[&.active]:grad-brand [&.active]:border-transparent [&.active]:text-white';
const PAGE_NAV_CLASS = 'inline-flex items-center justify-center size-9 p-0 box-border';
const PAGE_NUM_CLASS = 'inline-flex items-center justify-center h-9 min-w-9 px-2 text-sm box-border';
const PAGE_DOTS_CLASS = 'inline-flex items-center justify-center h-9 px-1.5 text-muted box-border';
/** 当前页码的标记类（配合上面的 [&.active] 变体）；必须是完整类名字符串 */
const PAGE_ACTIVE_CLASS = 'active';

/** 热词：一次拉全量（联想候选要全），榜单只展示前 HOT_LIST_SIZE 条 */
const HOT_FETCH_SIZE = 1000;
const HOT_LIST_SIZE = 200;

/** 运行状态悬浮窗开关的持久化键 */
const STATS_HUD_KEY = 'dht_stats_hud';

/**
 * 悬浮窗状态标签：[短标签, 完整说明]。
 * 面板仅 196px，显示用短标签，完整说明挂在 title 上。
 */
const STATUS_LABEL = {
  init: ['初始化中…', '索引初始化中：后台正在同步索引，页面可正常使用'],
  reindex: ['重建中…', '正在重建索引'],
  sync: ['同步中…', '正在同步索引'],
  idle: ['自动刷新', '每 3 秒自动刷新一次'],
};

/** 索引维护阶段名（与后端 db.js 上报的 step 一一对应） */
const STEP_LABEL = {
  schema: '准备索引库',
  scan: '写入索引',
  index: '建立二级索引',
  merge: '合并 FTS 索引',
  checkpoint: '回写数据库',
};

/** 空的运行状态快照（避免模板里到处判空） */
const EMPTY_STATS = {
  cache: '—',
  entries: '—',
  hitRate: '—',
  heap: '—',
  rss: '—',
  procs: '—',
  indexed: '—',
  status: '连接中…',
  statusHint: '',
  nextSyncAt: 0,
  syncCron: '',
  tick: 0,
  progress: {
    visible: false, barVisible: false, pct: '0', mode: '',
    stepIndex: 0, stepCount: 0, stepName: '', startedAt: 0,
  },
};

/** 读取地址栏状态：视图类型取自 hash（#latest），检索状态取自 query string */
function readUrlParams() {
  const params = new URLSearchParams(location.search);
  return {
    view: location.hash.replace(/^#/, ''),
    q: params.get('q'),
    sortBy: params.get('sortBy'),
    order: params.get('order'),
    page: params.get('page'),
    pageSize: params.get('pageSize'),
    sizeRange: params.get('sizeRange'),
  };
}

export function registerApp() {
  Alpine.data('searchPage', () => ({
    ICONS,

    /* ============================ 状态 ============================ */

    /** 当前视图：'search' 关键词检索+热词榜 | 'latest' 资源库（纯分页、id 倒序） */
    mode: 'search',
    /** 输入框里的文本（未提交） */
    input: '',
    /** 已提交的关键词（URL 与请求以它为准） */
    query: '',
    /** 高亮 token：由当前查询提取，infohash 检索时为空 */
    tokens: [],
    items: [],
    total: 0,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sizeRange: 'all',
    sortBy: '',
    order: 'desc',

    /** 是否有请求在途：用于防重复触发与取消，与蒙层显隐解耦 */
    searching: false,
    /** loading 蒙层是否可见：请求超过 LOADING_DELAY_MS 未返回才为真 */
    loadingVisible: false,
    /** 结果区/分页条/刷新按钮是否可见（成功取回一页后为真） */
    resultsVisible: false,
    countText: '加载中…',

    /** 热词全量缓存：null=未加载（此时不展示浏览区，避免先闪一下空态）。
     *  榜单与联想都从这一份派生，不再各存一份（见 hotItems / hotSuggestions） */
    hotWords: null,
    editMode: false,
    blacklistItems: [],
    blacklistFilter: '',

    /** 联想下拉：候选与开合都由 getter 从输入实时算出，这里只留两个真实状态 */
    activeSuggestion: -1,
    _suggestClosed: true,

    settingsOpen: false,
    rpc: { url: '', secret: '' },
    hudOn: false,
    busy: { sync: false, reindex: false, import: false },
    confirm: { open: false, message: '', danger: false, resolve: null },

    stats: { ...EMPTY_STATS },
    jumpValue: '',

    /* 内部：请求与订阅控制（不参与渲染） */
    _seq: 0,
    _abort: null,
    _statsSource: null,
    _statsTick: null,
    _lastUrl: null,
    /** 当前已渲染的页码：与 this.page 不一致时说明发生了翻页，需要把结果区滚回顶部 */
    _renderedPage: 0,
    /** 蒙层延迟显示的定时器（见 startLoading / stopLoading） */
    _loadingTimer: null,
    /** 失焦延迟关闭联想的定时器（见 onQueryBlur / onQueryInput） */
    _blurTimer: null,

    /* ============================ 派生值 ============================ */

    get totalPages() {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },
    /** 浏览区（热词榜）：仅搜索视图、无关键词、且热词已加载 */
    get showBrowse() {
      return this.mode === 'search' && !this.query && this.hotItems !== null;
    },
    /** 榜单条目：全量缓存的前 HOT_LIST_SIZE 条；null 表示尚未加载 */
    get hotItems() {
      return this.hotWords ? this.hotWords.slice(0, HOT_LIST_SIZE) : null;
    },
    /** 联想候选：用全量（候选更全），与榜单共用同一份缓存 */
    get hotSuggestions() {
      return this.hotWords || [];
    },
    get hotList() {
      return this.hotItems || [];
    },
    get refreshTitle() {
      return this.mode === 'latest' ? '刷新资源库' : '刷新搜索结果';
    },
    get pagerInfo() {
      return this.mode === 'latest' ? `共 ${this.total} 条` : `共 ${this.total} 条结果`;
    },
    get emptyText() {
      return this.mode === 'latest' ? '暂无资源记录' : '没有找到匹配的结果';
    },
    get sortKeys() {
      return SORT_KEYS;
    },
    get orderIcon() {
      return this.order === 'asc' ? ICONS.orderAsc : ICONS.orderDesc;
    },
    /** 联想候选：按当前输入实时算出，不在输入时同步一份状态（少一处可能的失同步） */
    get suggestions() {
      if (this._suggestClosed) return [];
      const q = this.input.trim();
      return q ? matchSuggestions(this.hotSuggestions, q) : [];
    },
    /** 下拉是否展开：有候选才展开，无候选时不显示空框 */
    get suggestOpen() {
      return this.suggestions.length > 0;
    },
    /** 联想下拉的可渲染行（命中片段已高亮为安全 HTML） */
    get suggestionRows() {
      const q = this.input.trim();
      const tokens = q ? [q] : [];
      return this.suggestions.map((it) => ({
        term: it.term,
        html: highlightHtml(it.term, tokens),
        countText: `${formatCount(it.doc_count)} 条`,
      }));
    },
    /** 设置面板两个动作按钮的文案 */
    get syncLabel() {
      return this.busy.sync ? '同步中…' : '同步索引';
    },
    get reindexLabel() {
      return this.busy.reindex ? '重建中…' : '重建索引';
    },
    /** 黑名单前端过滤结果。
     *  注意：后端存的是小写词，输入侧必须先 trim + 小写，否则输入大写字母会一个字都匹配不到。 */
    get filteredBlacklist() {
      const filter = this.blacklistFilter.trim().toLowerCase();
      if (!filter) return this.blacklistItems;
      return this.blacklistItems.filter((it) => String(it.term).toLowerCase().includes(filter));
    },
    /**
     * 页码按钮序列：上一页 + 页码窗口（含省略号）+ 下一页。
     * 两项约定供模板直绑：cls 必须是完整类名字符串（Alpine 的 :class 遇数组会 join，
     * 混对象会变成 "[object Object]"）；disabled 必须是显式布尔值（:bind 可能退化成空串，
     * 而空串会被写成 disabled="disabled"）。
     */
    get pageItems() {
      const last = this.totalPages;
      const cur = this.page;
      /** 统一出口：保证每个按钮都带布尔 disabled */
      const btn = (item) => ({ disabled: false, ...item });
      const items = [
        btn({ key: 'prev', html: ICONS.prev, aria: '上一页', page: cur - 1, disabled: cur <= 1, cls: `${PAGE_BTN_CLASS} ${PAGE_NAV_CLASS}` }),
      ];
      const window = new Set([1, 2, last - 1, last, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
      const pages = [...window].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
      let prev = 0;
      for (const p of pages) {
        if (p - prev > 1) items.push(btn({ key: `dots-${p}`, html: '…', disabled: true, cls: PAGE_DOTS_CLASS }));
        items.push(btn({
          key: `page-${p}`,
          html: String(p),
          aria: String(p),
          page: p,
          cls: `${PAGE_BTN_CLASS} ${PAGE_NUM_CLASS}${p === cur ? ` ${PAGE_ACTIVE_CLASS}` : ''}`,
        }));
        prev = p;
      }
      items.push(btn({ key: 'next', html: ICONS.next, aria: '下一页', page: cur + 1, disabled: cur >= last, cls: `${PAGE_BTN_CLASS} ${PAGE_NAV_CLASS}` }));
      return items;
    },
    /** 下次同步倒计时：相对时间由本地逐秒重算（stats.tick 每秒刷新） */
    get nextSyncText() {
      const s = this.stats;
      if (!s.nextSyncAt) return s.syncCron ? '自动同步已启用' : '未启用自动同步';
      return `${formatCountdown(s.nextSyncAt - s.tick)} 后`;
    },
    /** 维护进度首行左侧：重建索引 · 第 2/5 步 */
    get progressHead() {
      const p = this.stats.progress;
      if (!p.visible) return '';
      return p.stepIndex > 0 ? `${p.mode} · 第 ${p.stepIndex}/${p.stepCount} 步` : p.mode;
    },
    /** 首行右侧：有真实计数时显示百分比，否则显示已运行时长（同样是每秒重算） */
    get progressTail() {
      const p = this.stats.progress;
      if (!p.visible) return '';
      if (p.barVisible) return `${p.pct}%`;
      // 取 max(0)：跨机器访问时客户端时钟可能略快于服务端，差值会为负
      return p.startedAt ? formatCountdown(Math.max(0, this.stats.tick - p.startedAt)) : '';
    },
    /** 次行：当前阶段在做什么 */
    get progressDetail() {
      return this.stats.progress.visible ? this.stats.progress.stepName : '';
    },
    /** 悬浮提示：完整信息（面板窄，长文案会被截断） */
    get progressTitle() {
      const p = this.stats.progress;
      if (!p.visible) return '';
      return [this.progressHead, p.stepName, p.barVisible ? `${p.pct}%` : ''].filter(Boolean).join(' · ');
    },

    /* ============================ 生命周期 ============================ */

    init() {
      const params = readUrlParams();
      this.applyUrlParams(params);
      this.rpc = getRpcConfig();
      this.hudOn = localStorage.getItem(STATS_HUD_KEY) === '1';
      this.syncHud();

      // 用箭头函数订阅：DOM 事件回调的 this 会被置为 currentTarget（window），
      // 直接传方法引用会让 this 丢失，故这里靠闭包固定住组件实例。
      this._onLocationChange = () => {
        const url = `${location.pathname}${location.search}${location.hash}`;
        if (url === this._lastUrl) return; // popstate 与 hashchange 可能对同一次导航都触发
        this._lastUrl = url;
        this.restoreFromUrl();
      };
      window.addEventListener('popstate', this._onLocationChange);
      window.addEventListener('hashchange', this._onLocationChange);

      this.loadCount();
      this.loadHot();

      // 首屏：资源库总有一页可看；搜索视图仅在地址栏带关键词时请求（否则展示热词榜）。
      // 关键词取自输入框（applyUrlParams 已按 URL 填好），submitSearch 会顺带提交 query 与高亮 token。
      if (this.mode === 'latest') {
        this.loadPage('replace');
      } else if (this.input.trim()) {
        this.submitSearch({ resetPage: false, history: 'replace' });
      }
    },

    destroy() {
      window.removeEventListener('popstate', this._onLocationChange);
      window.removeEventListener('hashchange', this._onLocationChange);
      clearTimeout(this._loadingTimer);
      clearTimeout(this._blurTimer);
      this.stopStats();
    },

    /* ============================ 检索 ============================ */

    /**
     * 提交一次检索（换关键词 / 改排序 / 改筛选都走这里）。
     * @param {{resetPage?: boolean, history?: 'push'|'replace'}} options
     */
    async submitSearch({ resetPage = true, history = 'push' } = {}) {
      if (this.searching) return; // 请求在途时忽略重复触发
      if (this.mode !== 'search') return; // 关键词检索只属于搜索视图
      this.closeSuggestions();

      const next = this.input.trim();
      if (!next) {
        showToast('请输入搜索关键词');
        this.showBrowseView();
        return;
      }
      if (resetPage) this.page = 1;
      this.query = next;
      // infohash 走精确检索（不高亮），其余走 FTS5 模糊检索并提取高亮 token
      this.tokens = isInfohash(next) ? [] : extractTokens(next);
      await this.loadPage(history);
    },

    /**
     * 按当前状态取一页结果（搜索与资源库共用）。
     * @param {'push'|'replace'} history 本次取数是否记入浏览器历史
     */
    async loadPage(history = 'push') {
      const latest = this.mode === 'latest';
      if (!latest && !this.query) return; // 搜索视图无关键词时不请求（展示热词榜）

      const seq = ++this._seq;
      this._abort?.abort(); // 丢弃上一次仍在进行的请求
      this._abort = new AbortController();
      const { signal } = this._abort;

      const params = this.buildPageParams(latest);
      this.startLoading();
      try {
        const data = latest
          ? await api.fetchLatest(params, signal)
          : await api.search(params, signal);
        if (seq !== this._seq) return; // 已有更新的请求，丢弃本次

        this.total = Number(data.total) || 0;
        // 每条结果带一个本次请求唯一的 key，翻页时整批重建卡片（与旧实现一致）
        this.items = (data.items || []).map((item, i) => ({ ...item, key: `${seq}-${i}` }));
        this.resultsVisible = true;
        this.stopLoading();
        this.syncJumpValue();
        this.updateUrl(history);
        await this.scrollToTopIfPageChanged();
      } catch (err) {
        if (seq !== this._seq) return;
        this.stopLoading();
        // 主动取消（AbortError）由 cancelSearch() 统一提示，这里不再重复弹通知
        if (err.name === 'AbortError') return;
        showToast(`${latest ? '加载' : '查询'}失败：${err.message}`);
      }
    },

    /** 组装请求参数：资源库只带分页，搜索视图额外带关键词/排序/筛选 */
    buildPageParams(latest) {
      const params = {
        limit: this.pageSize,
        offset: (this.page - 1) * this.pageSize,
      };
      if (latest) return params;

      params.q = this.query;
      params.order = this.order;
      if (this.sortBy) params.sortBy = this.sortBy;
      if (isInfohash(this.query)) params.by = 'hash';

      const range = SIZE_RANGES.find((r) => r.value === this.sizeRange) || SIZE_RANGES[0];
      if (Number.isFinite(range.minBytes)) params.minSize = range.minBytes;
      if (Number.isFinite(range.maxBytes)) params.maxSize = range.maxBytes;
      return params;
    },

    /** 请求开始：立刻置「在途」标记，蒙层延迟 LOADING_DELAY_MS 后仍无结果才出现 */
    startLoading() {
      this.searching = true;
      clearTimeout(this._loadingTimer);
      this._loadingTimer = setTimeout(() => {
        this._loadingTimer = null;
        if (this.searching) this.loadingVisible = true;
      }, LOADING_DELAY_MS);
    },

    /** 请求结束（成功 / 失败 / 取消）：收起蒙层并取消待触发的延时 */
    stopLoading() {
      clearTimeout(this._loadingTimer);
      this._loadingTimer = null;
      this.searching = false;
      this.loadingVisible = false;
    },

    /** 取消进行中的搜索：中断请求并收起蒙层 */
    cancelSearch() {
      this._abort?.abort();
      this._abort = null;
      this.stopLoading();
      showToast('已取消搜索');
    },

    /** 悬浮刷新按钮：按当前视图原地重取（保留页码，不新增历史记录） */
    refresh() {
      if (this.mode === 'latest') this.loadPage('replace');
      else this.submitSearch({ resetPage: false, history: 'replace' });
    },

    /** 索引变化后的原地重取（同步 / 重建之后） */
    async reloadCurrentPage() {
      if (this.mode === 'latest') {
        await this.loadPage('replace');
      } else if (this.query) {
        await this.submitSearch({ history: 'replace' });
      }
    },

    /* ============================ 输入框与联想 ============================ */

    /** 输入即重新尝试展开联想（候选由 getter 实时算出，这里只负责「重新打开」） */
    onQueryInput() {
      clearTimeout(this._blurTimer); // 失焦后又开始输入 → 取消那次延迟关闭
      this._suggestClosed = false;
      this.activeSuggestion = -1;
    },

    /** 输入框失焦（change）：有值即搜索，空值回到热词视图 */
    onQueryChange() {
      if (this.input.trim()) this.submitSearch();
      else this.handleInputCleared();
    },

    /** 回车：有高亮候选则采用它，否则直接检索 */
    onEnterKey() {
      if (this.suggestOpen && this.activeSuggestion >= 0) {
        this.applySuggestion(this.suggestions[this.activeSuggestion].term);
        return;
      }
      this.closeSuggestions();
      this.submitSearch();
    },

    /**
     * ↑/↓ 移动候选高亮。下拉未展开时不拦截按键，
     * 以免夺走输入框里光标上下移动的默认行为。
     */
    moveSuggestion(step, event) {
      if (!this.suggestOpen) return;
      event.preventDefault();
      const max = this.suggestions.length - 1;
      this.activeSuggestion = Math.min(max, Math.max(0, this.activeSuggestion + step));
    },

    /** Esc 仅在联想展开时收起（未展开时放行，不影响输入法自身的取消行为） */
    onEscapeKey(event) {
      if (!this.suggestOpen) return;
      event.preventDefault();
      this.closeSuggestions();
    },

    /** 失焦后延迟关闭，避免点击下拉项时它先被关掉（期间重新输入会在 onQueryInput 里取消） */
    onQueryBlur() {
      clearTimeout(this._blurTimer);
      this._blurTimer = setTimeout(() => this.closeSuggestions(), 150);
    },

    applySuggestion(term) {
      this.input = term;
      this.submitSearch();
      this.$refs.q?.focus();
    },

    closeSuggestions() {
      this._suggestClosed = true;
      this.activeSuggestion = -1;
    },

    clearInput() {
      this.input = '';
      this.closeSuggestions();
      this.handleInputCleared();
      this.$refs.q?.focus();
    },

    /** 关键词被清空：重置检索状态、从 URL 移除关键词、回到热词视图 */
    handleInputCleared() {
      if (this.mode !== 'search') return;
      const hadSearch = !!this.query;
      this._abort?.abort();
      this._abort = null;
      this._seq++; // 让可能仍在途的响应自行丢弃
      this.query = '';
      this.page = 1;
      this.total = 0;
      this.tokens = [];
      this.updateUrl('replace');
      if (hadSearch) this.showBrowseView();
    },

    /** 展示浏览区（热词榜）；热词未加载则先拉取 */
    showBrowseView() {
      if (this.mode !== 'search') return;
      this.resultsVisible = false;
      this.items = [];
      if (this.hotWords === null) this.loadHot();
    },

    /* ============================ 排序 / 筛选 / 分页 ============================ */

    setSort(sortBy) {
      this.sortBy = sortBy;
      this.submitSearch();
    },

    toggleOrder() {
      this.order = this.order === 'desc' ? 'asc' : 'desc';
      this.submitSearch();
    },

    onSizeRangeChange() {
      if (this.query) this.submitSearch();
    },

    onPageSizeChange() {
      this.page = 1;
      this.loadPage();
    },

    goToPage(page) {
      if (!page || page < 1 || page > this.totalPages) return;
      this.page = page;
      this.loadPage();
    },

    /** 输入框持有焦点时不打断用户输入 */
    syncJumpValue() {
      if (document.activeElement !== this.$refs.jumpPage) this.jumpValue = String(this.page);
    },

    /**
     * 翻页后把结果区滚回顶部（滚动发生在结果列表容器上，且需等新一页渲染完再复位，
     * 否则会被浏览器对 scrollTop 的夹取拉回去）。只在页码真正变化时执行。
     */
    async scrollToTopIfPageChanged() {
      if (this._renderedPage === this.page) return;
      this._renderedPage = this.page;
      await this.$nextTick();
      if (this.$refs.results) this.$refs.results.scrollTop = 0;
    },

    jumpTo() {
      const input = this.$refs.jumpPage;
      const raw = String(input?.value ?? '').trim();
      const page = parseInt(raw, 10);
      if (!raw || !Number.isFinite(page)) {
        showToast('请输入有效页码');
        input?.select();
        return;
      }
      if (page < 1) {
        showToast('页码不能小于 1');
        input?.select();
        return;
      }
      if (page > this.totalPages) {
        showToast(`超出最大页数，共 ${this.totalPages} 页`);
        input?.select();
        return;
      }
      this.page = page;
      input?.blur();
      this.loadPage();
    },

    /* ============================ 视图切换 ============================ */

    /**
     * 搜索 / 资源库整体切换：两套视图共用结果列表与分页，差别只有接口与检索栏。
     * 切换本身是一次可后退的视图变更，记入浏览器历史。
     */
    switchMode(next) {
      if (this.mode === next) return;
      this.mode = next;
      this.page = 1;
      this.total = 0;
      this.tokens = [];

      if (next === 'latest') {
        this.query = ''; // 资源库不携带关键词（输入框文本保留，切回搜索时复用）
        this.closeSuggestions();
        this.updateUrl('push'); // 先落 URL 再取数：结果回来时 updateUrl 判等直接返回
        this.loadPage('replace');
        return;
      }

      const q = this.input.trim();
      if (q) {
        this.query = q;
        this.tokens = isInfohash(q) ? [] : extractTokens(q);
        // 与 latest 分支同理：视图已经切过来了，就先把 URL 落到新视图再取数
        // （取数成功后 loadPage 里的 updateUrl 判等即为 no-op）。
        // 否则一旦请求失败，地址栏会停在旧视图，与界面、前进后退都不一致。
        this.updateUrl('push');
        this.loadPage('replace');
      } else {
        this.updateUrl('push');
        this.showBrowseView();
      }
    },

    /* ============================ 热词与黑名单 ============================ */

    /** 一次拉取热词（全量缓存）：榜单取前 HOT_LIST_SIZE 条，联想用全量 */
    async loadHot() {
      try {
        this.hotWords = await api.fetchHot(HOT_FETCH_SIZE);
      } catch {
        this.hotWords = []; // 置空而非 null：失败后不再反复触发重新拉取
      }
    },

    /** 重新拉取热词（黑名单变化后被过滤的词可能重新出现） */
    async reloadHot() {
      this.hotWords = null;
      await this.loadHot();
    },

    searchTerm(term) {
      this.input = term;
      this.submitSearch();
    },

    /** 热词气泡点击：编辑模式下气泡本体不触发检索（右侧 × 才是加入黑名单） */
    onHotWordClick(term) {
      if (!this.editMode) this.searchTerm(term);
    },

    onEditToggle() {
      this.blacklistFilter = '';
      if (this.editMode) this.loadBlacklist();
    },

    async loadBlacklist() {
      try {
        this.blacklistItems = await api.fetchBlacklist();
      } catch {
        this.blacklistItems = [];
      }
    },

    /** 把关键词加入黑名单：从热词视图移除，并刷新黑名单列表 */
    async addToBlacklist(term) {
      try {
        await api.addBlacklistTerm(term);
      } catch {
        return;
      }
      // 从全量缓存里摘掉：榜单与联想都立即生效（服务端下次也不会再返回它）
      this.hotWords = (this.hotWords || []).filter((h) => h.term !== term);
      if (this.editMode) await this.loadBlacklist();
    },

    /** 把关键词移出黑名单：刷新列表并重新拉热词 */
    async removeFromBlacklist(term) {
      try {
        await api.removeBlacklistTerm(term);
      } catch {
        return;
      }
      await this.loadBlacklist();
      await this.reloadHot();
    },

    /** 导出黑名单为 .txt */
    async exportBlacklist() {
      try {
        const text = await api.exportBlacklist();
        downloadText(`hot-filter-export-${new Date().toISOString().slice(0, 10)}.txt`, text);
        showToast('黑名单已导出');
      } catch {
        showToast('导出出错');
      }
    },

    /** 导入黑名单（.txt，每行一个词，# 开头为注释） */
    async importBlacklist(event) {
      const file = event.target.files?.[0];
      event.target.value = ''; // 允许重复选择同一文件
      if (!file) return;

      this.busy.import = true;
      try {
        const terms = (await file.text())
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        const { accepted, total } = await api.importBlacklist(terms);
        showToast(`已导入 ${accepted} 条（黑名单共 ${total} 条）`);
        await this.loadBlacklist();
        await this.reloadHot(); // 使新过滤词立即生效
      } catch (err) {
        showToast(`导入出错：${err.message}`);
      } finally {
        this.busy.import = false;
      }
    },

    /* ============================ 设置面板：同步 / 重建 ============================ */

    openSettings() {
      this.settingsOpen = true;
    },

    closeSettings() {
      this.settingsOpen = false;
      this.saveRpc(); // 兜底保存：只在输入框内输入但未失焦就关闭时不丢值
    },

    saveRpc() {
      saveRpcConfig({ url: this.rpc.url, secret: this.rpc.secret });
    },

    async confirmSync() {
      if (!(await this.askConfirm('同步索引将从源库补录新增行，是否继续？'))) return;
      await this.doSync();
    },

    async confirmReindex() {
      const ok = await this.askConfirm('重建索引会重新构建本地 FTS 索引，可能需要较长时间，是否继续？', true);
      if (ok) await this.doReindex();
    },

    async doSync() {
      this.busy.sync = true;
      try {
        await api.syncIndex();
        // 补录的新行会出现在「资源库」最前：沿用当前视图原地重取
        if (this.mode === 'latest' || this.query) await this.reloadCurrentPage();
        else await this.loadCount();
        showToast('索引已同步最新');
      } catch (err) {
        showToast(`同步失败：${err.message}`);
      } finally {
        this.busy.sync = false;
      }
    },

    async doReindex() {
      this.busy.reindex = true;
      try {
        const { indexed } = await api.reindex();
        this.total = 0;
        if (this.mode === 'latest' || this.query) await this.reloadCurrentPage();
        else showToast(`索引已重建，共索引 ${indexed} 条`);
        await this.loadCount();
      } catch (err) {
        showToast(`重建失败：${err.message}`);
      } finally {
        this.busy.reindex = false;
      }
    },

    /* ============================ 二次确认弹窗 ============================ */

    /** 打开确认框并返回用户的选择 */
    askConfirm(message, danger = false) {
      return new Promise((resolve) => {
        this.confirm = { open: true, message, danger, resolve };
      });
    },

    answerConfirm(value) {
      const { resolve } = this.confirm;
      this.confirm = { open: false, message: '', danger: false, resolve: null };
      resolve?.(value);
    },

    /** 全局 Esc：内层确认框优先于设置面板 */
    onEscape() {
      if (this.confirm.open) this.answerConfirm(false);
      else if (this.settingsOpen) this.closeSettings();
    },

    /* ============================ 运行状态（SSE） ============================ */

    onHudToggle() {
      localStorage.setItem(STATS_HUD_KEY, this.hudOn ? '1' : '0');
      this.syncHud();
    },

    /** 应用开关状态：开启则显示悬浮窗并订阅 SSE，关闭则反之 */
    syncHud() {
      if (this.hudOn) this.startStats();
      else this.stopStats();
    },

    startStats() {
      if (this._statsSource) return;
      this._statsSource = api.openStatsStream(
        (data) => this.applyStats(data),
        () => {
          this.stats = { ...this.stats, status: '连接中断，正在重连…' };
        }
      );
      // 倒计时每秒走一次，不必为此提高服务端推送频率
      this._statsTick = setInterval(() => {
        this.stats = { ...this.stats, tick: Date.now() };
      }, 1000);
    },

    stopStats() {
      this._statsSource?.close();
      this._statsSource = null;
      clearInterval(this._statsTick);
      this._statsTick = null;
      this.stats = { ...EMPTY_STATS };
    },

    /** 把一帧快照整理成模板可直接读取的文案 */
    applyStats(d) {
      // 维护进度：只有「扫描并写入」这一步有真实计数（scanned = 已扫过的 id 区间），
      // 建索引 / 合并 FTS / 回写都没有可换算的比例 —— 那时不画进度条，只报阶段名
      const prog = d.indexing && d.indexing.running ? d.indexing : null;
      const showBar = !!(prog && prog.step === 'scan' && prog.total > 0);
      const pct = showBar ? Math.max(0, Math.min(100, (prog.scanned / prog.total) * 100)) : 0;
      const modeLabel = prog?.mode === 'incremental' ? '同步索引' : '重建索引';
      // 状态优先级：启动初始化 > 重建 > 同步 > 空闲
      const state = d.initializing
        ? 'init'
        : d.reindex && d.reindex.running
          ? 'reindex'
          : d.syncing
            ? 'sync'
            : 'idle';
      const [status, statusHint] = STATUS_LABEL[state];

      this.stats = {
        cache: `${formatBytes(d.cacheBytes)} / ${formatBytes(d.cacheMaxBytes)}`,
        entries: `${d.cacheEntries} 条`,
        hitRate: `${(d.hitRate * 100).toFixed(1)}%（${d.hit} / ${d.hit + d.miss}）`,
        heap: `${d.heapMB} MB`,
        rss: `${d.rssMB} MB`,
        procs: `${d.processes} 个`,
        indexed: formatCount(d.indexed),
        status,
        statusHint,
        nextSyncAt: d.nextSyncAt || 0,
        syncCron: d.syncCron || '',
        tick: Date.now(),
        progress: {
          visible: !!prog && !!prog.step,
          barVisible: showBar,
          pct: pct.toFixed(1),
          mode: modeLabel,
          stepIndex: prog?.stepIndex || 0,
          stepCount: prog?.stepCount || 0,
          stepName: prog?.step ? STEP_LABEL[prog.step] || prog.step : '',
          startedAt: prog?.startedAt || 0,
        },
      };
    },

    /* ============================ 索引总数 ============================ */

    async loadCount() {
      try {
        this.countText = `已索引 ${formatCount(await api.fetchCount())} 条`;
      } catch {
        this.countText = '索引数未知';
      }
    },

    /* ============================ URL 与浏览器历史 ============================ */

    /**
     * 把当前视图状态写回地址栏（hash 承载视图类型，query 承载检索状态）。
     * 'push' 新增历史记录；'replace' 仅改写 URL（用于还原与原地重取）。
     */
    updateUrl(historyMode = 'push') {
      const params = new URLSearchParams();
      if (this.mode === 'search') {
        if (this.query) params.set('q', this.query);
        if (this.sortBy) params.set('sortBy', this.sortBy);
        if (this.order !== 'desc') params.set('order', this.order);
        if (this.sizeRange !== 'all') params.set('sizeRange', this.sizeRange);
      }
      if (this.page > 1) params.set('page', String(this.page));
      if (this.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(this.pageSize));

      const qs = params.toString();
      const next = `${location.pathname}${qs ? `?${qs}` : ''}${this.mode === 'latest' ? '#latest' : ''}`;
      // 目标 URL 与当前完全一致时直接返回（重复点击同一排序不该多压一条历史记录）
      if (next === `${location.pathname}${location.search}${location.hash}`) return;
      if (historyMode === 'push') history.pushState(null, '', next);
      else history.replaceState(null, '', next);
    },

    /**
     * 把地址栏参数应用到状态与控件。地址栏是视图状态的唯一来源：
     * 缺省参数必须显式回落默认值，否则后退时会残留上一份状态。
     */
    applyUrlParams(p) {
      this.mode = p.view === 'latest' ? 'latest' : 'search';
      this.input = p.q || '';
      this.page = p.page ? Math.max(1, parseInt(p.page, 10) || 1) : 1;
      this.applyPageSize(p.pageSize);
      // 关键词/排序/筛选只属于搜索视图：资源库的 URL 里没有它们，还原时不要动，
      // 免得把用户先前设好的检索偏好清掉
      if (this.mode === 'search') {
        this.sortBy = SORT_KEYS.some((k) => k.value === p.sortBy) ? p.sortBy : '';
        this.order = p.order === 'asc' ? 'asc' : 'desc';
        this.sizeRange = SIZE_RANGES.some((r) => r.value === p.sizeRange) ? p.sizeRange : 'all';
      }
      this.jumpValue = String(this.page);
    },

    /** 每页条数归到最近的合法档位（URL 携带非标准值时也能正确落位） */
    applyPageSize(raw) {
      let n = parseInt(raw, 10);
      if (!Number.isFinite(n)) n = DEFAULT_PAGE_SIZE;
      this.pageSize = PAGE_SIZE_OPTIONS.reduce(
        (closest, opt) => (Math.abs(opt - n) < Math.abs(closest - n) ? opt : closest),
        PAGE_SIZE_OPTIONS[0]
      );
    },

    /** 浏览器前进/后退（或地址栏 hash 变化）：还原地址栏对应的视图（不新增历史） */
    restoreFromUrl() {
      const p = readUrlParams();
      this.applyUrlParams(p);

      if (this.mode === 'latest') {
        this.query = '';
        this.tokens = [];
        this.loadPage('replace');
        return;
      }
      if (p.q) {
        this.query = p.q;
        this.tokens = isInfohash(p.q) ? [] : extractTokens(p.q);
        this.loadPage('replace');
        return;
      }
      this.query = '';
      this.page = 1;
      this.total = 0;
      this.tokens = [];
      this.showBrowseView();
    },
  }));
}
