/**
 * Express 检索服务入口
 * ------------------------------------------------------------------
 *   GET  /                    重定向到 /index.html
 *   GET  /api/search          FTS5 检索（参数：q 必填；sortBy / order / limit / offset / searchIn 可选；
 *                              searchIn=name 只搜种子名，缺省搜 name+files）
 *   GET  /api/latest          最新入库列表（不经 FTS，按入库顺序从新到旧）
 *   GET  /api/magnet/:id/files 某条资源的完整文件树
 *   POST /api/reindex         手动全量重建；POST /api/sync 手动增量补录
 *   GET  /api/count           已索引总数
 *   GET  /api/hot、/api/hot/filter(/export|/import)  热词榜与过滤词维护
 *   GET  /api/stats/stream    运行状态 SSE
 * 其余静态资源来自 public/（经 WEB_BASE_PATH 前缀访问）。
 */

import path from 'node:path';
import express from 'express';
import compression from 'compression';
import cron from 'node-cron';
import { createMagnetDb } from './src/db.js';
import { normalizeSearchQuery, normalizeLatestQuery } from './src/search/query.js';
import { normalizeKeyword } from './src/util.js';
import { createSearchExecutor } from './src/searchPool.js';
import { createAccessControl } from './src/accessControl.js';
import { isCompiledExe } from './src/db-driver.js';
import { ACCESS_CONTROL_MODE, ALLOWED_CLIENTS, TRUST_PROXY, SYNC_CRON, SYNC_ON_START, WEB_BASE_PATH } from './src/settings.js';
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
  setNextSyncAt,
} from './src/stats.js';

// 编译产物（bun --compile）内 import.meta.url 指向虚拟文件系统，静态资源取 exe 同目录的 public/
const __dirname = isCompiledExe ? path.dirname(process.execPath) : import.meta.dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 端口唯一来源是 config.js
const PORT = Number(CONFIG.port) || 3000;

const api = createMagnetDb({ sync: false });

/* ------------------------------------------------------------------ */
/* 已索引总数内存缓存（事件驱动）                                      */
/* ------------------------------------------------------------------ */
/**
 * 已索引总数的内存缓存：只在「会改动索引的事件」（启动初始化、增量补录、重建完成）
 * 之后由 syncIndexedCount() 刷新，平时请求直接返回内存值，不再每次扫表。
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

// 搜索子进程池：检索在独立进程中执行（客户端断开时 SIGKILL 即可中断同步查询）；
// 进程按需启动、断开或空闲超时后回收。必须在 createMagnetDb() 之后创建（索引库文件已就绪）。
const searchExecutor = createSearchExecutor({
  maxProcesses: CONFIG.searchMaxProcesses,
  recycleImmediate: CONFIG.searchProcessRecycleImmediate,
  idleMs: CONFIG.searchProcessIdleMs,
  queueMax: CONFIG.searchQueueMax,
  queueTimeoutMs: CONFIG.searchQueueTimeoutMs,
  indexPath: api.indexPath,
  filesPath: api.filesPath,
});

// 索引库原子切换的前后钩子（重建写影子库，完成后由 db.js 的 swapIndex 调用）：
//   before —— 回收搜索子进程并暂停派发（它们持有旧库句柄，不释放就无法改名文件）。
//             必须用 recycleAll 而不是 terminateAll：后者是退出用的一次性开关且不恢复，
//             挂在这里会让此后所有检索都返回「服务正在关闭」。
//   after  —— 解除暂停，积压的查询继续派发到新库上。
api.setBeforeSwap(() => searchExecutor.recycleAll());
api.setAfterSwap(() => searchExecutor.resume());

/* ------------------------------------------------------------------ */
/* 搜索结果内存缓存                                                    */
/* ------------------------------------------------------------------ */
/**
 * 进程内搜索缓存：以「最大内存占用 + 每条 TTL」双约束淘汰。
 * 存的是序列化后的 JSON 字符串（堆占用 ≈ 该值，命中时可直接 res.send 省一次 stringify）；
 * 被访问即刷新 TTL（updateAgeOnGet），超时条目由 ttlAutopurge 与定时 purgeStale 真正释放。
 */
// 兜底值（config.js 缺失 / 非法时）与 config.js 的默认值保持一致：32MB
const SEARCH_CACHE_MAX_SIZE =
  (Number(CONFIG.searchCacheMaxSizeMb) > 0 ? Number(CONFIG.searchCacheMaxSizeMb) : 32) * 1024 * 1024;
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

/* ------------------------------------------------------------------ */
/* 定时同步计划（cron 节拍的只读查询）                                  */
/* ------------------------------------------------------------------ */
/** 只有非空且 node-cron 认可才算「已启用」（与下面注册阶段的判定保持一致） */
const SYNC_CRON_ON = Boolean(SYNC_CRON) && cron.validate(SYNC_CRON);
/** 上次取值时刻；仅在取不到下次触发时间时用于重试节流 */
let syncNextCheckedAt = 0;

/**
 * 下次同步时刻——直接问调度器（`task.getNextRun()`），不再自行推算 cron 语义。
 * 惰性重算：缓存值过期时下一帧重取，取不到时最多每 10 秒重试一次。
 * @param {number} [now=Date.now()]
 * @returns {number|null} 未启用 / 取不到时为 null
 */
function getNextSyncAt(now = Date.now()) {
  if (!SYNC_CRON_ON) return null;
  const cur = runtimeStats.sync.nextAt;
  const stale = cur == null ? now - syncNextCheckedAt > 10_000 : cur <= now;
  if (stale) {
    syncNextCheckedAt = now;
    setNextSyncAt(syncTask?.getNextRun()?.getTime() ?? null);
  }
  return runtimeStats.sync.nextAt;
}

const app = express();

/**
 * WEB_BASE_PATH 作为整个 Express 服务的统一前缀（如 '/dht'）：在此剥掉前缀，
 * 后续 API / 静态 / 中间件都无需感知前缀；不带前缀的直连路径同样可用。
 */
const PREFIX = (() => {
  const p = String(WEB_BASE_PATH ?? '').trim().replace(/^\/+|\/+$/g, '');
  return p ? `/${p}` : '';
})();
if (PREFIX) {
  app.use((req, _res, next) => {
    const u = req.url;
    if (u === PREFIX) {
      req.url = '/'; // 例如 /dht -> /
    } else if (u.startsWith(`${PREFIX}/`)) {
      req.url = u.slice(PREFIX.length) || '/'; // 例如 /dht/api/x -> /api/x
    }
    next();
  });
}

// 是否信任前置反代的 X-Forwarded-For（用于白名单比对时拿到真实客户端 IP）
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

// 接入层访问控制（IP / 网段白名单）：放在最前，整站统一由白名单把关
app.use(createAccessControl({
  mode: ACCESS_CONTROL_MODE ?? 'off',
  allowed: ALLOWED_CLIENTS ?? [],
}));

// 响应压缩。热词表是一次性下发的整份词表（30000 条纯文本 234KB），压缩后 131KB；
// 搜索结果等大 JSON 同样受益。阈值 1KB 以下不压（省 CPU 且收益为负）。
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    // SSE 是持续推送的流，一旦被压缩中间件缓冲住，进度条就再也推不动了
    if (req.headers.accept === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));

/** 请求日志中间件：只记录页面入口与 /api 接口，忽略 /public 静态资源噪音 */

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
        // 错误对象自带合法 status（如排队满 / 超时标记的 503）时优先使用
        const code =
          Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
            ? err.status
            : status;
        // 5xx 记服务端日志（客户端只看到一句话）；4xx 属预期内输入错误，不记以免刷屏
        if (code >= 500) {
          log.error(`${req.method} ${req.originalUrl} -> ${code}: ${err?.stack || err?.message || err}`);
        }
        res.status(code).json({ error: err?.message || defaultMessage });
      });
  };
}

// 站点根（或前缀根）统一落到 index.html
app.get('/', (_req, res) => res.redirect(`${PREFIX}/index.html`));

// 静态资源与 API 一样经前缀剥除中间件后在此命中（不带前缀的直连路径也可用）
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

/** 构造搜索缓存键：由归一化后的检索参数派生（新增参数时不易漏改） */
function searchCacheKey(s) {
  return JSON.stringify([s.query, s.by, s.sortBy, s.order, s.limit, s.offset, s.minSize, s.maxSize, s.cursor, s.searchIn]);
}

/** 检索日志描述串（缓存 HIT / MISS / 客户端取消三处共用） */
function describeSearch(s) {
  return `q="${s.query}" 模式=${s.by === 'hash' ? 'infohash精确' : 'FTS5模糊'} 排序=${s.sortBy ?? 'id'}/${s.order}`;
}

/** 「最新入库」缓存键：首元素用哨兵字符串，与搜索键不会相撞；只有分页参数 */
function latestCacheKey(s) {
  return JSON.stringify(['__latest__', s.limit, s.offset]);
}

/** 「最新入库」日志描述串 */
function describeLatest(s) {
  return `最新入库 limit=${s.limit} offset=${s.offset}`;
}

/**
 * 查询类请求的统一执行管线（/api/search 与 /api/latest 共用）：
 * 查缓存 → 派发搜索子进程 → 客户端断开时取消 → 回写缓存与响应。
 * 接口差异（参数、缓存键、子进程模式、是否可缓存）全部由调用方传入。
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {object}  opts.params     派发给搜索子进程的参数（已归一化；带 mode 时切换任务类型）
 * @param {string}  opts.key        本次结果的缓存键（不同接口必须互不冲突）
 * @param {string}  opts.describe   日志描述串
 * @param {boolean} [opts.cacheable=true] 结果是否写入缓存（体量过大的整集拉取应传 false）
 */
async function runQuery(req, res, { params, key, describe, cacheable = true }) {
  const cached = searchCache.get(key);
  if (cached) {
    markCacheHit();
    log.cache('HIT', describe);
    // 缓存里已是序列化好的 JSON 字符串，直接回写，省掉一次完整 stringify
    res.type('application/json');
    return res.send(cached);
  }
  markCacheMiss();
  log.cache('MISS', describe);

  const job = searchExecutor.run(params);

  /** 客户端已断开：丢弃结果、不缓存、不响应（响应已无法送达） */
  const logCancelled = () => log.cancel(`客户端断开，已取消检索 ${describe}`);

  let aborted = false;
  // 客户端断开（关闭页面 / 中止请求 / 新一轮查询取消旧请求）时：标记 aborted（避免再写响应与缓存），
  // 并让 cancel() 中断该次检索。两个事件都监听：Express 5 下 res.close 在 keep-alive 正常
  // 响应完成后也会触发，req.close 才是可靠的断连信号。
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
    if (cacheable) searchCache.set(key, body);
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
}

app.get('/api/search', apiHandler(async (req, res) => {
  // 参数只归一化这一次（HTTP 参数名 q → 领域字段 query），缓存键 / 派参 / 日志都由它派生
  const s = normalizeSearchQuery({ ...req.query, query: req.query.q });
  if (!s.query) {
    return res.status(400).json({ error: 'query 不能为空' });
  }
  await runQuery(req, res, {
    params: s, // s 已归一化且归一化幂等，子进程侧可直接使用
    key: searchCacheKey(s),
    describe: describeSearch(s),
    // 整集拉取（limit=all）的结果体量远大于分页结果，不进缓存，
    // 避免一次请求就把整个缓存预算吃掉
    cacheable: s.limit !== -1,
  });
}));

/**
 * 最新入库列表：遍历副本表按 id 倒序返回一页（不经 FTS，无关键词 / 排序 / 过滤）。
 * 参数只有分页：limit / offset
 */
app.get('/api/latest', apiHandler(async (req, res) => {
  const s = normalizeLatestQuery(req.query);
  // 复用事件驱动的内存总数（与子进程全表 count(*) 同义且等价），省掉每次翻页的重复计数；
  // 为空时先懒加载一次。子进程侧缺失该值会自动回退自算，故直接调用仍安全。
  if (indexedCountCache.value == null) syncIndexedCount();
  await runQuery(req, res, {
    params: { ...s, mode: 'latest', total: indexedCountCache.value },
    key: latestCacheKey(s),
    describe: describeLatest(s),
  });
}));

/**
 * 某条 magnet 的完整文件树（扁平树：parent 指向父节点下标，根为 -1）。
 * 列表接口只下发 fileCount + 预览，整棵树由本接口按需返回；单行主键查询，不走搜索进程池。
 */
app.get('/api/magnet/:id/files', apiHandler((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'id 非法' });
  }
  const found = api.getMagnetFiles(id);
  if (!found) {
    return res.status(404).json({ error: '未找到该条目' });
  }
  res.json({ id: found.id, nodes: found.nodes });
}));

/** 手动全量重建影子索引（在独立子进程中执行，重建期间检索仍可用） */
app.post('/api/reindex', apiHandler(async (_req, res) => {
  log.user('手动触发全量索引重建');
  beginReindex();
  let indexed;
  try {
    indexed = await api.reindex(({ done, total, step }) => {
      // 进度写入运行时状态，由 SSE 顺带推送给设置面板（不额外做事件总线）
      setReindexProgress(done, total, step ?? null);
      log.progress(`重建进度 ${step ?? '-'} ${done}/${total}`);
    });
  } finally {
    endReindex();
  }
  // 重建完成，索引基数已变（手动重建不再驱动自动同步节拍，节奏由 SYNC_CRON 接管）
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
    // 记录本轮结果；nextAt 由 cron 独立维护，手动同步不挪动定时计划
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
 * 采集一份完整运行期快照——所有推送字段的唯一组装点（新增指标只改这里）。
 * 推的是时间戳而非倒计时，相对时间交给前端本地渲染。
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
    // 下次同步 = cron 的下一次触发点（未启用 / 无法推算时为 null）
    nextSyncAt: getNextSyncAt(),
    syncCron: SYNC_CRON_ON ? SYNC_CRON : '',
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

/**
 * 热词表：一次性下发整份词表，联想完全在前端做。
 *
 * 响应是**换行分隔的纯文本**而不是 JSON：
 *   - 词表已是「按热度降序」的，顺序即排名，故不必传 doc_count / occurrences；
 *   - 省掉 JSON 的引号与逗号，且重复结构让 gzip 压缩率更高（30000 条：234KB → 131KB）。
 * 配合 compression 中间件，一次性加载后前端零延迟联想，也不再逐次请求。
 */
app.get('/api/hot', apiHandler((req, res) => {
  // 不传 limit 即返回**全部**满足阈值的词（收录范围由 HOT_MIN_DOC_COUNT 决定，
  // 而不是「取前 N 条」——后者会让边界词随索引增长被静默挤掉）
  const limit = Number(req.query.limit);
  const words = api.topKeywords(Number.isFinite(limit) ? limit : Infinity);
  res.type('text/plain; charset=utf-8').send(words.join('\n'));
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

// 启动索引维护（后台执行，期间标记 initializing，页面立即可用）：
//   1) 索引格式过期（版本升级 / 首次建库）→ 全量重建，与 SYNC_ON_START 无关；
//   2) 否则按 SYNC_ON_START 决定是否做一次增量补录。
// 完成后刷新总数缓存；重建还要清搜索缓存（索引内容已变）。
const needsFormatMigration = api.indexNeedsRebuild();
if (needsFormatMigration || SYNC_ON_START) {
  runtimeStats.initializing = true;
  if (needsFormatMigration) {
    log.warn('索引格式已过期（版本升级或首次建库），后台开始全量重建；期间线上仍用旧索引服务');
  }
  const job = needsFormatMigration ? api.reindex() : api.syncIncremental();
  job
    .then((r) => {
      if (needsFormatMigration) searchCache.clear();
      else if (r && r.added > 0) syncIndexedCount();
    })
    .catch((e) => log.error(`启动${needsFormatMigration ? '重建' : '同步'}失败: ${e?.message || e}`))
    .finally(() => {
      runtimeStats.initializing = false;
      syncIndexedCount(); // 无论成败都刷新总数，反映当前索引状态
    });
} else {
  log.system('SYNC_ON_START=false，已跳过启动增量同步（索引格式无变化）');
}

// 定时增量同步（唯一的周期索引维护）：SYNC_CRON（默认关闭）到点在后台补录新增行；
// 全量重建只保留给启动建库与手动 /api/reindex。
let syncTask = null;
if (SYNC_CRON_ON) {
  syncTask = cron.schedule(SYNC_CRON, async () => {
    log.user(`定时增量同步触发（cron: ${SYNC_CRON}）`);
    let skipped = false;
    let added = 0;
    beginSync();
    try {
      const r = await api.syncIncremental();
      skipped = r.skipped;
      added = r.added;
    } catch (e) {
      log.error(`定时增量同步失败: ${e?.message || e}`);
      return;
    } finally {
      endSync(added);
    }
    // 确实补录了新行才清缓存；无新增时不必让已有缓存白白失效
    if (added > 0) {
      searchCache.clear();
      syncIndexedCount();
    }
    if (skipped) {
      log.warn('定时增量同步跳过（全量重建进行中）');
    } else {
      log.ok(`定时增量同步完成，补录 ${added} 行${added > 0 ? '，已清空搜索缓存' : ''}`);
    }
  });
  const nextRun = syncTask.getNextRun();
  log.system(`已注册定时增量同步任务（cron: ${SYNC_CRON}${nextRun ? `，下次 ${nextRun.toLocaleString('zh-CN')}` : ''}）`);
} else if (SYNC_CRON) {
  log.warn(`SYNC_CRON 表达式无效，已忽略: ${SYNC_CRON}`);
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
  syncTask?.stop();
  searchCache.clear();
  searchExecutor.terminateAll();
  api.close();
  log.system('服务已关闭');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
