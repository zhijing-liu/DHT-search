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
import { createMagnetDb, CONFIG } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/** 整集拉取的安全上限：单次请求最多返回这么多条，超出则 truncated=true；可由 config.json 的 maxResults 覆盖 */
const MAX_RESULTS = CONFIG.maxResults ? Number(CONFIG.maxResults) : 20000;

const SORT_WHITELIST = new Set(['fetchedAt', 'totalSize', 'relevance']);

const PORT = Number(CONFIG.port) || Number(process.env.PORT) || 3000;

const api = createMagnetDb();

const app = express();

/** 是否请求整集拉取（返回全部匹配，而非分页） */
function isWholeSet(limitParam) {
  if (limitParam === undefined) return false;
  if (limitParam === '0' || limitParam === 'all') return true;
  const n = Number(limitParam);
  return Number.isFinite(n) && n <= 0;
}

app.get('/', (_req, res) => res.redirect('/index.html'));

app.get('/index.html', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

app.get('/api/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.status(400).json({ error: 'query 不能为空' });
  }

  const sortBy = SORT_WHITELIST.has(req.query.sortBy) ? req.query.sortBy : undefined;
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  // 仅当显式传 by=hash 时走 infohash 精确检索，其余走 FTS5 模糊检索
  const by = req.query.by === 'hash' ? 'hash' : undefined;

  try {
    if (isWholeSet(req.query.limit)) {
      // 整集拉取：一次查询取回全部匹配，前端据此做本地分页缓存
      const result = api.searchMagnets({ query: q, sortBy, order, limit: -1, by });
      let items = result.items;
      const truncated = items.length > MAX_RESULTS;
      if (truncated) items = items.slice(0, MAX_RESULTS);
      return res.json({ total: result.total, limit: 'all', offset: 0, items, truncated });
    }

    // 普通分页
    const limitParam = Number(req.query.limit);
    const offsetParam = Number(req.query.offset);
    const result = api.searchMagnets({
      query: q,
      sortBy,
      order,
      by,
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      offset: Number.isFinite(offsetParam) ? offsetParam : undefined,
    });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'search failed' });
  }
});

/** 手动全量重建影子索引（源被改/删后用于同步） */
app.post('/api/reindex', (_req, res) => {
  try {
    const indexed = api.reindex();
    res.json({ ok: true, indexed });
  } catch (err) {
    res.status(500).json({ error: err.message || 'reindex failed' });
  }
});

/** 当前已索引的 magnet 总数 */
app.get('/api/count', (_req, res) => {
  try {
    res.json({ count: api.countMagnets() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'count failed' });
  }
});

/** 热词榜（暂未接入页面，用于验证落库数据） */
app.get('/api/hot', (req, res) => {
  try {
    const limit = Number(req.query.limit);
    res.json({ items: api.topKeywords(Number.isFinite(limit) ? limit : 50) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'hot failed' });
  }
});

/** 热词过滤词列表 */
app.get('/api/hot/filter', (_req, res) => {
  try {
    res.json({ items: api.listKeywordFilters() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'list filter failed' });
  }
});

/** 添加热词过滤词（body: { term }） */
app.post('/api/hot/filter', (req, res) => {
  try {
    const term = String(req.body?.term ?? '').trim().toLowerCase();
    if (!term || !/[\p{L}\p{N}]/u.test(term)) {
      return res.status(400).json({ error: 'term 不能为空且需包含字母或数字' });
    }
    res.json({ ok: true, term: api.addKeywordFilter(term) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'add filter failed' });
  }
});

/** 删除热词过滤词（query: ?term=） */
app.delete('/api/hot/filter', (req, res) => {
  try {
    const term = String(req.query.term ?? '').trim().toLowerCase();
    if (!term) {
      return res.status(400).json({ error: 'term 不能为空' });
    }
    res.json({ ok: true, term: api.removeKeywordFilter(term) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'remove filter failed' });
  }
});

// 兜底错误处理，避免进程崩溃
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`DHT Search 服务已启动: http://localhost:${PORT}`);
});

// 重建索引（reindex）可能耗时较长且同步执行，关闭服务端超时避免请求被中断
server.timeout = 0;
if ('requestTimeout' in server) server.requestTimeout = 0;
if ('headersTimeout' in server) server.headersTimeout = 0;

server.on('error', (err) => {
  console.error(`服务启动失败: ${err.message}`);
  api.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  api.close();
  process.exit(0);
});
