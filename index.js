/**
 * Express 检索服务入口
 * ------------------------------------------------------------------
 *   GET /                 -> 重定向到 /index.html
 *   GET /index.html       -> 返回 public/index.html
 *   /public              -> 静态资源（app.js / styles.css）
 *   GET /api/search        -> FTS5 检索接口（复用 db.js）
 *
 * 接口约定（GET /api/search）：
 *   q        必填，搜索关键词
 *   sortBy   可选 'fetchedAt' | 'totalSize' | 'relevance'（其余值忽略，按 id 排序）
 *   order    可选 'asc' | 'desc'，默认 desc，仅 sortBy 传入时生效
 *   limit    可选；默认分页（每页 20 条，钳制 1..200）。仅传 'all' 表示「整集拉取」
 *            （一次性返回全部匹配，上限 MAX_RESULTS）；0 / 负数 / 非数值一律按分页处理
 *   offset   可选，分页偏移（默认 0）
 * 返回：{ total, limit, offset, items, truncated? }
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cron from 'node-cron';
import { createMagnetDb, normalizeSearchQuery, normalizeKeyword } from './src/db.js';
import { createSearchExecutor } from './src/searchPool.js';
import { createAccessControl } from './src/accessControl.js';
import { isCompiledExe } from './src/db-driver.js';
import { ACCESS_CONTROL_MODE, ALLOWED_CLIENTS, TRUST_PROXY, REINDEX_CRON } from './src/settings.js';
import { CONFIG } from './src/store.js';
import { LRUCache } from 'lru-cache';
import { log } from './src/logger.js';
import {
  runtimeStats,
  markCacheHit,
  markCacheMiss,
  beginReindex,
  setReindexProgress,
  endReindex,
  beginSync,
  endSync,
} from './src/stats.js';

// 编译产物（bun --compile）内 import.meta.url 指向虚拟文件系统，静态资源目录
// 改取 exe 同目录的 public/；源码态行为不变
const __dirname = isCompiledExe
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// 端口唯一来源是 config.js（env 兜底永不生效，已移除，见 config.js 顶部说明）
const PORT = Number(CONFIG.port) || 3000;

const api = createMagnetDb({ sync: false });

/* ------------------------------------------------------------------ */
/* 已索引总数内存缓存（事件驱动）                                      */
/* ------------------------------------------------------------------ */
/**
 * count(*) 是百万行主键扫描，代价远高于其他查询。但 magnets_docs 的行数
 * 只在「会改动索引的事件」后才变化：启动初始化、增量同步补录新行、全量重建完成。
 * 故改为事件驱动的内存缓存——这些事件成功后调用 syncIndexedCount() 刷新一次，
 * 平时直接返回内存值，不再每次请求都扫表。
 */
let indexedCountCache = { value: null };
function syncIndexedCount() {
  try {
    indexedCountCache.value = api.countMagnets();
  } catch {
    indexedCountCache.value = null; // 失败留空，下次请求懒加载兜底
  }
}
// 启动即初始化（createMagnetDb 内部已完成启动同步，索引库已是正确状态）
syncIndexedCount();

// 搜索子进程池：检索在独立进程中执行，客户端断开时 SIGKILL 该进程即可真正中断查询
// （worker 线程的 terminate() 无法中断同步原生查询，详见 src/searchPool.js 文件头）。
// 进程按需 fork：启动时 0 个，第一个查询到来才启动，客户端断开或空闲超时后回收，
// 上限由 config.js 的 SEARCH_MAX_PROCESSES 控制。
// 必须在 createMagnetDb() 之后创建——此时索引库文件已就绪，子进程才能以只读方式打开。
const searchExecutor = createSearchExecutor({
  maxProcesses: CONFIG.searchMaxProcesses,
  recycleImmediate: CONFIG.searchProcessRecycleImmediate,
  idleMs: CONFIG.searchProcessIdleMs,
  queueMax: CONFIG.searchQueueMax,
  queueTimeoutMs: CONFIG.searchQueueTimeoutMs,
  indexPath: api.indexPath,
});

/* ------------------------------------------------------------------ */
/* 搜索结果内存缓存                                                    */
/* ------------------------------------------------------------------ */
/**
 * 进程内搜索缓存：以「最大内存占用 + 每条 TTL」双约束淘汰。
 *  - 存的是**序列化后的 JSON 字符串**而非对象：对象的堆占用约为 JSON 字节数的
 *    3~5 倍（隐藏类指针、UTF-16 String、重复的 files 键名），存字符串让
 *    SEARCH_CACHE_MAX_SIZE_MB 的配额 ≈ 实际堆占用，命中时也可直接 res.send 省掉
 *    一次完整 stringify；
 *  - maxSize + sizeCalculation：按序列化后字节数限制总内存（空间约束）；
 *  - ttl + updateAgeOnGet：每条缓存独立计时，被访问即刷新 TTL；
 *    默认 1 小时，经 config.js 的 SEARCH_CACHE_TTL_MS 覆盖；
 *  - ttlAutopurge + 定时 purgeStale：超时且未被访问的条目会被真正释放（定期释放）。
 */
const SEARCH_CACHE_MAX_SIZE =
  (Number(CONFIG.searchCacheMaxSizeMb) > 0 ? Number(CONFIG.searchCacheMaxSizeMb) : 256) * 1024 * 1024;
const SEARCH_CACHE_TTL_MS =
  Number.isFinite(Number(CONFIG.searchCacheTtlMs)) && Number(CONFIG.searchCacheTtlMs) > 0
    ? Number(CONFIG.searchCacheTtlMs)
    : 3600_000;

const searchCache = new LRUCache({
  maxSize: SEARCH_CACHE_MAX_SIZE,
  // 缓存值是序列化后的字符串，其字节长度即堆占用，无需再 stringify 一次去估算
  sizeCalculation: (body) => Buffer.byteLength(body),
  ttl: SEARCH_CACHE_TTL_MS,
  updateAgeOnGet: true,
  ttlAutopurge: true,
});

// 后台定时清扫：即使条目从不被访问，超时后也能在下一轮被真正释放
const searchCacheSweep = setInterval(() => searchCache.purgeStale(), 60_000);
if (typeof searchCacheSweep.unref === 'function') searchCacheSweep.unref();

const app = express();

// 信任前置反向代理（nginx 等）时设为 true / 'loopback' / 具体子网，
// 才能从 X-Forwarded-For 拿到真实客户端 IP 用于白名单比对；
// 默认 false：直连场景取 TCP 对端地址，安全且正确。
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

// 接入层访问控制（IP / 网段白名单）：放在最前，整站（前端页面 + 所有 API +
// 写接口）统一由白名单把关。mode 为 'off' 或白名单为空时不限制。
app.use(createAccessControl({
  mode: ACCESS_CONTROL_MODE ?? 'off',
  allowed: ALLOWED_CLIENTS ?? [],
}));

/**
 * 请求日志中间件：所有来自用户（或前端）主动发起的操作统一标记为 [USER]。
 * 仅记录页面入口与 /api 接口，忽略 /public 下的静态资源噪音（app.js / styles.css 等），
 * 让控制台输出聚焦于「用户做了什么」。
 */
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      log.request(req.method, req.originalUrl, res.statusCode, Date.now() - start);
    });
  }
  next();
});

/** 未预期异常的兜底文案（仅当 err.message 为空时启用） */
const INTERNAL_ERROR = 'internal error';

/**
 * 统一包装 API 处理器：同步或异步执行，异常时按指定状态码返回 { error }。
 * @param {Function} fn       处理器（可同步或返回 Promise）
 * @param {number}   status  异常时响应的 HTTP 状态码，默认 500
 * @param {string}   defaultMessage 当 err.message 为空时使用的兜底文案
 *        （默认 INTERNAL_ERROR）；调用方可传更具语义的提示，例如 'list filter failed'
 */
function apiHandler(fn, status = 500, defaultMessage = INTERNAL_ERROR) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        if (res.headersSent) return;
        // 错误对象自带合法 status（如搜索排队满 / 排队超时标记的 503）时优先使用，
        // 让「服务过载」与「客户端错误 / 内部错误」在状态码上可区分
        const code =
          Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
            ? err.status
            : status;
        res.status(code).json({ error: err?.message || defaultMessage });
      });
  };
}

app.get('/', (_req, res) => res.redirect('/index.html'));

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

/**
 * 构造搜索缓存键：直接由归一化后的检索参数派生。
 * 这样「影响结果的字段」与「参与比对的字段」永远同源——将来新增检索参数时，
 * 不可能再出现「忘了同步进缓存键导致不同查询撞 key」的问题。
 */
function searchCacheKey(s) {
  return JSON.stringify([s.query, s.by, s.sortBy, s.order, s.limit, s.offset, s.minSize, s.maxSize]);
}

/** 检索日志描述串（缓存 HIT / MISS / 客户端取消三处共用） */
function describeSearch(s) {
  return `q="${s.query}" 模式=${s.by === 'hash' ? 'infohash精确' : 'FTS5模糊'} 排序=${s.sortBy ?? 'id'}/${s.order}`;
}

app.get('/api/search', apiHandler(async (req, res) => {
  // 参数只归一化这一次：缓存键、worker 派参、日志描述全部由这一个对象派生。
  // 注意 HTTP 参数名是 q，而领域字段名是 query，在此处完成这唯一的命名映射；
  // req.query 的值可能是字符串也可能是数组，normalizeSearchQuery 统一收敛为安全类型。
  const s = normalizeSearchQuery({ ...req.query, query: req.query.q });
  if (!s.query) {
    return res.status(400).json({ error: 'query 不能为空' });
  }

  const key = searchCacheKey(s);
  const cached = searchCache.get(key);
  if (cached) {
    markCacheHit();
    log.cache('HIT', describeSearch(s));
    // 缓存里已是序列化好的 JSON 字符串，直接回写，省掉一次完整 stringify
    res.type('application/json');
    return res.send(cached);
  }
  markCacheMiss();
  log.cache('MISS', describeSearch(s));

  // 把检索放进独立子进程执行；客户端断开时 SIGKILL 该进程，直接中断其正在执行的
  // 同步 SQLite 查询——这是「关页面即停」唯一有效的手段（线程 terminate 无效，见 searchPool.js）。
  // s 已归一化，且归一化是幂等的，子进程侧可直接使用。
  const job = searchExecutor.run(s);

  /** 客户端已断开：丢弃结果、不缓存、不响应（响应已无法送达） */
  const logCancelled = () =>
    log.cancel(`客户端断开，已取消检索 ${describeSearch(s)}`);

  let aborted = false;
  // 客户端断开（关闭页面 / 中止请求 / 新一轮搜索取消旧请求）时：
  // 1) 标记 aborted，避免正常分支再写响应 / 缓存；
  // 2) 立即 SIGKILL 该搜索子进程——由操作系统回收进程，其中正在执行的同步 SQLite 查询随之中断。
  // 用 req 的 close 而非仅靠 res 的 close：Express 5 下 res.close 在 keep-alive 正常响应完成后
  // 也会触发，对「客户端已离开」判断不可靠；req.close 才是断连信号。两者兜底，Bun / Node 均生效。
  const onClose = () => {
    if (aborted) return;
    aborted = true;
    // 仍在队列中 → 零成本移除；已派发 → SIGKILL 该进程。两者由 cancel() 内部判别
    job.cancel();
  };
  req.on('close', onClose);
  res.on('close', onClose);

  try {
    const result = await job.done;
    req.off('close', onClose);
    res.off('close', onClose);
    // 竞态：结果已产出，但客户端恰在此刻断开——丢弃结果，不缓存也不响应
    if (aborted) {
      logCancelled();
      return;
    }
    const body = JSON.stringify(result);
    // 整集拉取（limit=all）的结果体量远大于分页结果，不进缓存，
    // 避免一次请求就把整个缓存预算吃掉
    if (s.limit !== -1) searchCache.set(key, body);
    try {
      res.type('application/json').send(body);
    } catch {
      /* 响应已关闭，忽略写入异常 */
    }
  } catch (e) {
    req.off('close', onClose);
    res.off('close', onClose);
    if (aborted) {
      logCancelled();
      return;
    }
    throw e; // 交给 apiHandler 统一处理：默认 500，排队满/超时经 err.status 升级为 503
  }
}));

/** 手动全量重建影子索引（在 worker 线程 / 子进程中执行，重建期间检索仍可用） */
app.post('/api/reindex', apiHandler(async (_req, res) => {
  log.user('手动触发全量索引重建');
  beginReindex();
  let indexed;
  try {
    indexed = await api.reindex(({ done, total }) => {
      // 进度写入运行时状态，由 SSE 顺带推送给设置面板（不额外做事件总线）
      setReindexProgress(done, total);
      log.progress(`重建进度 ${done}/${total}`);
    });
  } finally {
    endReindex();
  }
  // 重建完成，索引基数已变（手动重建不再驱动自动同步节拍，节奏由 REINDEX_CRON 接管）
  endSync(0);
  // 索引内容已变更，清空搜索缓存避免返回旧结果
  searchCache.clear();
  // 行数已彻底变化，刷新内存中的总数（重建完成、最终值已落库）
  syncIndexedCount();
  log.ok(`索引重建完成，累计 ${indexed} 条，已清空搜索缓存`);
  res.json({ ok: true, indexed });
}));

/** 增量同步最新索引（按 last_rowid 仅补录源库新增行，秒级；与重建互斥） */
app.post('/api/sync', apiHandler(async (_req, res) => {
  log.user('手动触发增量同步');
  let skipped = false;
  let added = 0;
  beginSync();
  try {
    const r = await api.syncIncremental();
    skipped = r.skipped;
    added = r.added;
  } finally {
    // 更新同步状态（自动同步已取消，nextAt 不再被维护）
    endSync(added);
  }
  // 确实补录了新行才清缓存；无新增时不必让已有缓存白白失效
  if (added > 0) {
    searchCache.clear();
    // 行数增加，刷新内存中的总数
    syncIndexedCount();
  }
  if (skipped) {
    log.warn('增量同步跳过（重建进行中）');
  } else {
    log.ok(`增量同步完成，补录 ${added} 行${added > 0 ? '，已清空搜索缓存' : ''}`);
  }
  res.json({ ok: true, skipped, added });
}));

/** 当前已索引的 magnet 总数（直接读事件驱动的内存缓存，不扫表） */
app.get('/api/count', apiHandler((_req, res) => {
  if (indexedCountCache.value == null) syncIndexedCount(); // 兜底懒加载
  res.json({ count: indexedCountCache.value ?? 0 });
}));

/* ------------------------------------------------------------------ */
/* 运行状态监测（设置面板 SSE）                                        */
/* ------------------------------------------------------------------ */
/**
 * 采集一份完整运行期快照——所有推送字段的唯一组装点。
 * 新增/删除面板指标只改这个函数，SSE 路由与前端渲染都不必改动。
 * 注意推的是时间戳而非倒计时：相对时间交给前端本地逐秒渲染，
 * 服务端无需为此提高推送频率。
 */
function collectStats() {
  if (indexedCountCache.value == null) syncIndexedCount();
  const m = process.memoryUsage();
  const { hit, miss } = runtimeStats.cache;
  const total = hit + miss;
  return {
    cacheEntries: searchCache.size,
    cacheBytes: searchCache.calculatedSize,
    cacheMaxBytes: SEARCH_CACHE_MAX_SIZE,
    hit,
    miss,
    hitRate: total ? +(hit / total).toFixed(4) : 0,
    heapMB: +(m.heapUsed / 1048576).toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
    processes: searchExecutor.size,
    indexed: indexedCountCache.value ?? 0,
    nextSyncAt: runtimeStats.sync.nextAt,
    lastSyncAt: runtimeStats.sync.lastAt,
    syncing: runtimeStats.sync.running,
    reindex: runtimeStats.reindex,
    initializing: runtimeStats.initializing,
    indexing: runtimeStats.indexing,
  };
}

/** 设置面板运行状态流：弹窗打开期间订阅，关闭即断开 */
app.get('/api/stats/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反代（nginx 等）下禁止缓冲，否则进度条会卡住不动
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  let closed = false;
  /** 清理推送定时器——不清理就是真实的内存泄漏（每打开一次面板残留一个） */
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
  }
  const push = () => {
    if (closed) return;
    try {
      res.write(`event: stats\ndata: ${JSON.stringify(collectStats())}\n\n`);
    } catch {
      cleanup(); // 连接已断，停止推送
    }
  };
  const timer = setInterval(push, 3000);

  push(); // 立即推一次，避免打开面板后空白 3 秒
  req.on('close', cleanup);
  res.on('error', cleanup);
});

/** 热词榜（暂未接入页面，用于验证落库数据） */
app.get('/api/hot', apiHandler((req, res) => {
  const limit = Number(req.query.limit);
  res.json({ items: api.topKeywords(Number.isFinite(limit) ? limit : 50) });
}));

/** 热词过滤词列表 */
app.get('/api/hot/filter', apiHandler((_req, res) => {
  res.json({ items: api.listKeywordFilters() });
}, 500, 'list filter failed'));

/** 添加热词过滤词（body: { term }） */
app.post('/api/hot/filter', apiHandler((req, res) => {
  // 校验规则与 db 层共用 normalizeKeyword，避免两处各写一份
  const term = normalizeKeyword(req.body?.term);
  if (!term) {
    return res.status(400).json({ error: 'term 不能为空且需包含字母或数字' });
  }
  res.json({ ok: true, term: api.addKeywordFilter(term) });
  log.user(`添加热词过滤词: "${term}"`);
}));

/** 删除热词过滤词（query: ?term=） */
app.delete('/api/hot/filter', apiHandler((req, res) => {
  // req.query 的值可能是数组（?term=a&term=b），取首个，避免 String() 拼成 "a,b"
  const raw = Array.isArray(req.query.term) ? req.query.term[0] : req.query.term;
  const term = String(raw ?? '').trim().toLowerCase();
  if (!term) {
    return res.status(400).json({ error: 'term 不能为空' });
  }
  res.json({ ok: true, term: api.removeKeywordFilter(term) });
  log.user(`删除热词过滤词: "${term}"`);
}));

/** 导出热词过滤词为文本文件（每行一个词，带 # 头注释） */
app.get('/api/hot/filter/export', apiHandler((_req, res) => {
  const items = api.listKeywordFilters();
  const text = [
    '# DHT Search 热词黑名单导出',
    `# 共 ${items.length} 条，每行一个词；# 开头为注释`,
    ...items.map((it) => it.term),
  ].join('\n') + '\n';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="hot-filter-export.txt"');
  res.send(text);
}));

/** 批量导入热词过滤词（body: { terms: string[] }，每行一个词；幂等） */
app.post('/api/hot/filter/import', apiHandler((req, res) => {
  const terms = Array.isArray(req.body?.terms) ? req.body.terms : [];
  // # 开头是导入文件格式的注释行（本接口特有规则）；其余无效项由 addKeywordFilters 内部跳过。
  // 走批量接口而非逐条 addKeywordFilter：单事务写入，快得多且具备原子性。
  const accepted = api.addKeywordFilters(terms.filter((t) => !String(t).trim().startsWith('#')));
  const total = api.listKeywordFilters().length;
  res.json({ ok: true, accepted, total });
}));

// 兜底错误处理，避免进程崩溃
app.use((err, _req, res, _next) => {
  log.error(`未捕获异常: ${err?.stack || err?.message || err}`);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  log.banner(PORT, CONFIG.maxResults);
});

// 启动同步：丢进后台增量补录，不阻塞主线程、页面立即可响应；
// 期间标记 initializing，完成后刷新总数缓存。
runtimeStats.initializing = true;
api.syncIncremental()
  .then((r) => { if (r && r.added > 0) syncIndexedCount(); })
  .catch((e) => log.error(`启动同步失败: ${e?.message || e}`))
  .finally(() => {
    runtimeStats.initializing = false;
    syncIndexedCount(); // 无论成败都刷新总数，反映当前索引状态
  });

// 定时全量重建（唯一周期索引维护）：REINDEX_CRON 默认关闭，启用后在后台执行一次全量重建，
// 主进程零阻塞，期间页面与检索仍可用；取代旧的每小时自动增量同步。
let reindexTask = null;
if (REINDEX_CRON && cron.validate(REINDEX_CRON)) {
  reindexTask = cron.schedule(REINDEX_CRON, () => {
    if (runtimeStats.reindex.running) {
      log.warn('定时全量重建跳过：上一次重建仍在进行中');
      return;
    }
    log.user(`定时全量重建触发（cron: ${REINDEX_CRON}）`);
    beginReindex();
    api.reindex(({ done, total }) => {
      setReindexProgress(done, total);
      log.progress(`重建进度 ${done}/${total}`);
    })
      .then((indexed) => {
        searchCache.clear();
        syncIndexedCount();
        log.ok(`定时重建完成，累计 ${indexed} 条，已清空搜索缓存`);
      })
      .catch((e) => log.error(`定时重建失败: ${e?.message || e}`))
      .finally(() => endReindex());
  });
  log.system(`已注册定时全量重建任务（cron: ${REINDEX_CRON}）`);
} else if (REINDEX_CRON) {
  log.warn(`REINDEX_CRON 表达式无效，已忽略: ${REINDEX_CRON}`);
}

// 重建索引（reindex）可能耗时较长且同步执行，关闭服务端超时避免请求被中断
server.timeout = 0;
if ('requestTimeout' in server) server.requestTimeout = 0;
if ('headersTimeout' in server) server.headersTimeout = 0;

server.on('error', (err) => {
  log.error(`服务启动失败: ${err.message}`);
  api.close();
  process.exit(1);
});

// 统一退出处理：SIGINT(终端 Ctrl+C / pm2 默认) 与 SIGTERM(docker stop / kill -15 / systemd)
function shutdown(signal) {
  log.shutdown(`收到 ${signal}，正在关闭服务并释放资源...`);
  clearInterval(searchCacheSweep);
  reindexTask?.stop();
  searchCache.clear();
  searchExecutor.terminateAll();
  api.close();
  log.system('服务已关闭');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
