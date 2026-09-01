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
 *   limit    可选；传 0 / 'all' 表示「整集拉取」（一次性返回全部匹配，上限 MAX_RESULTS）；
 *            传正数表示普通分页（默认 20，钳制 1..200）
 *   offset   可选，分页偏移（默认 0）
 * 返回：{ total, limit, offset, items, truncated? }
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMagnetDb } from './src/db.js';
import { CONFIG, SORT_COLUMNS } from './src/store.js';
import { LRUCache } from 'lru-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/** 整集拉取的安全上限：单次请求最多返回这么多条，超出则 truncated=true；可由 config.json 的 maxResults 覆盖 */
const maxResults = Number(CONFIG.maxResults);
const MAX_RESULTS = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 20000;

const PORT = Number(CONFIG.port) || Number(process.env.PORT) || 3000;

const api = createMagnetDb();

/* ------------------------------------------------------------------ */
/* 搜索结果内存缓存                                                    */
/* ------------------------------------------------------------------ */
/**
 * 进程内搜索缓存：以「最大内存占用 + 每条 TTL」双约束淘汰。
 *  - maxSize + sizeCalculation：按序列化后字节数限制总内存（空间约束）；
 *  - ttl + updateAgeOnGet：每条缓存独立计时，被访问即刷新 TTL；
 *    默认 1 小时，经 config.json 的 searchCacheTtlMs 覆盖；
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
  sizeCalculation: (value) => Buffer.byteLength(JSON.stringify(value)),
  ttl: SEARCH_CACHE_TTL_MS,
  updateAgeOnGet: true,
  ttlAutopurge: true,
});

// 后台定时清扫：即使条目从不被访问，超时后也能在下一轮被真正释放
const searchCacheSweep = setInterval(() => searchCache.purgeStale(), 60_000);
if (typeof searchCacheSweep.unref === 'function') searchCacheSweep.unref();

const app = express();

/**
 * 请求日志中间件：所有来自用户（或前端）主动发起的操作统一标记为 [USER]。
 * 仅记录页面入口与 /api 接口，忽略 /public 下的静态资源噪音（app.js / styles.css 等），
 * 让控制台输出聚焦于「用户做了什么」。
 */
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[USER] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
  }
  next();
});

/** 是否请求整集拉取（返回全部匹配，而非分页） */
function isWholeSet(limitParam) {
  if (limitParam === undefined) return false;
  if (limitParam === 'all') return true;
  const n = Number(limitParam);
  return Number.isFinite(n) && n <= 0;
}

/** 统一包装 API 处理器：同步或异步执行，异常时按指定状态码返回 { error } */
function apiHandler(fn, status = 500, fallback = 'internal error') {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        if (!res.headersSent) res.status(status).json({ error: err?.message || fallback });
      });
  };
}

app.get('/', (_req, res) => res.redirect('/index.html'));

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

/** 构造搜索缓存键：覆盖所有影响结果的参数，保证命中结果一致 */
function searchCacheKey(q, by, sortBy, order, limitParam, offsetParam, minSize, maxSize) {
  const whole = isWholeSet(limitParam);
  const page = whole ? 'all' : `${limitParam ?? ''}:${offsetParam ?? ''}`;
  return [q, by ?? '', sortBy ?? '', order, page, minSize ?? '', maxSize ?? ''].join('|');
}

app.get('/api/search', apiHandler((req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.status(400).json({ error: 'query 不能为空' });
  }

  const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : undefined;
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  // 仅当显式传 by=hash 时走 infohash 精确检索，其余走 FTS5 模糊检索
  const by = req.query.by === 'hash' ? 'hash' : undefined;
  // 大小范围筛选（字节）；非有限值视为不限制
  const minSize = Number(req.query.minSize);
  const maxSize = Number(req.query.maxSize);

  const key = searchCacheKey(q, by, sortBy, order, req.query.limit, req.query.offset,
    Number.isFinite(minSize) ? minSize : '', Number.isFinite(maxSize) ? maxSize : '');
  const cached = searchCache.get(key);
  if (cached) {
    console.log(`[cache] HIT  q="${q}" 模式=${by === 'hash' ? 'infohash精确' : 'FTS5模糊'} 排序=${sortBy ?? 'id'}/${order}`);
    return res.json(cached);
  }
  console.log(`[cache] MISS q="${q}" 模式=${by === 'hash' ? 'infohash精确' : 'FTS5模糊'} 排序=${sortBy ?? 'id'}/${order}`);

  let result;
  if (isWholeSet(req.query.limit)) {
    // 整集拉取：一次查询取回全部匹配
    const raw = api.searchMagnets({ query: q, sortBy, order, limit: -1, by, minSize, maxSize });
    let items = raw.items;
    const truncated = items.length > MAX_RESULTS;
    if (truncated) items = items.slice(0, MAX_RESULTS);
    result = { total: raw.total, limit: 'all', offset: 0, items, truncated };
  } else {
    // 普通分页
    const limitParam = Number(req.query.limit);
    const offsetParam = Number(req.query.offset);
    result = api.searchMagnets({
      query: q,
      sortBy,
      order,
      by,
      minSize,
      maxSize,
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      offset: Number.isFinite(offsetParam) ? offsetParam : undefined,
    });
  }

  searchCache.set(key, result);
  return res.json(result);
}, 400, 'search failed'));

/** 手动全量重建影子索引（在 worker 线程中执行，重建期间检索仍可用） */
app.post('/api/reindex', apiHandler(async (_req, res) => {
  console.log('[USER] 手动触发全量索引重建');
  const indexed = await api.reindex(({ done, total }) => {
    console.log(`[SYSTEM][reindex] 重建进度 ${done}/${total}`);
  });
  // 索引内容已变更，清空搜索缓存避免返回旧结果
  searchCache.clear();
  console.log(`[SYSTEM] 索引重建完成，累计 ${indexed} 条，已清空搜索缓存`);
  res.json({ ok: true, indexed });
}, 500, 'reindex failed'));

/** 增量同步最新索引（按 last_rowid 仅补录源库新增行，秒级；与重建互斥） */
app.post('/api/sync', apiHandler((_req, res) => {
  console.log('[USER] 手动触发增量同步');
  api.syncIncremental();
  // 索引内容已变更，清空搜索缓存避免返回旧结果
  searchCache.clear();
  console.log('[SYSTEM] 增量同步完成，已清空搜索缓存');
  res.json({ ok: true });
}, 500, 'sync failed'));

/** 当前已索引的 magnet 总数 */
app.get('/api/count', apiHandler((_req, res) => {
  res.json({ count: api.countMagnets() });
}, 500, 'count failed'));

/** 热词榜（暂未接入页面，用于验证落库数据） */
app.get('/api/hot', apiHandler((req, res) => {
  const limit = Number(req.query.limit);
  res.json({ items: api.topKeywords(Number.isFinite(limit) ? limit : 50) });
}, 500, 'hot failed'));

/** 热词过滤词列表 */
app.get('/api/hot/filter', apiHandler((_req, res) => {
  res.json({ items: api.listKeywordFilters() });
}, 500, 'list filter failed'));

/** 添加热词过滤词（body: { term }） */
app.post('/api/hot/filter', apiHandler((req, res) => {
  const term = String(req.body?.term ?? '').trim().toLowerCase();
  if (!term || !/[\p{L}\p{N}]/u.test(term)) {
    return res.status(400).json({ error: 'term 不能为空且需包含字母或数字' });
  }
  res.json({ ok: true, term: api.addKeywordFilter(term) });
  console.log(`[USER] 添加热词过滤词: "${term}"`);
}, 500, 'add filter failed'));

/** 删除热词过滤词（query: ?term=） */
app.delete('/api/hot/filter', apiHandler((req, res) => {
  const term = String(req.query.term ?? '').trim().toLowerCase();
  if (!term) {
    return res.status(400).json({ error: 'term 不能为空' });
  }
  res.json({ ok: true, term: api.removeKeywordFilter(term) });
  console.log(`[USER] 删除热词过滤词: "${term}"`);
}, 500, 'remove filter failed'));

// 兜底错误处理，避免进程崩溃
app.use((err, _req, res, _next) => {
  console.error(`[SYSTEM][error] 未捕获异常: ${err?.stack || err?.message || err}`);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  console.log('[SYSTEM] ==========================================');
  console.log(`[SYSTEM] DHT Search 服务已启动: http://localhost:${PORT}`);
  console.log(`[SYSTEM] 配置: port=${PORT} maxResults=${MAX_RESULTS}`);
  console.log('[SYSTEM] 等待用户请求...');
  console.log('[SYSTEM] ==========================================');
});

// 运行期自动增量同步：默认每小时按 last_rowid 补录一次源库新增行
// （config.json 的 syncIntervalMs 配 0 可关闭）；重建期间 syncIncremental 自动跳过本轮
const SYNC_INTERVAL_MS = (() => {
  const v = Number(CONFIG.syncIntervalMs);
  return Number.isFinite(v) && v > 0 ? v : 3600000;
})();
const syncTimer = setInterval(() => {
  api.syncIncremental().catch((err) => {
    console.error(`[SYSTEM][sync] 增量同步失败: ${err?.message || err}`);
  });
}, SYNC_INTERVAL_MS);
if (typeof syncTimer.unref === 'function') syncTimer.unref();

// 重建索引（reindex）可能耗时较长且同步执行，关闭服务端超时避免请求被中断
server.timeout = 0;
if ('requestTimeout' in server) server.requestTimeout = 0;
if ('headersTimeout' in server) server.headersTimeout = 0;

server.on('error', (err) => {
  console.error(`[SYSTEM][error] 服务启动失败: ${err.message}`);
  api.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[SYSTEM] 收到 SIGINT，正在关闭服务并释放数据库...');
  clearInterval(searchCacheSweep);
  clearInterval(syncTimer);
  searchCache.clear();
  api.close();
  console.log('[SYSTEM] 服务已关闭');
  process.exit(0);
});
