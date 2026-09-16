/**
 * 运行期状态（设置面板监测用）
 * ------------------------------------------------------------------
 * 设置面板 SSE 推送所需的全部「服务自身状态」集中在此，由 index.js 的 collectStats()
 * 组装后推送。状态变更统一走成对的 begin / end 函数，以便调用方在 finally 里复位
 * running 标志（否则前端进度条会永远卡住）。本模块零外部依赖，可独立测试。
 */

/** 运行期状态快照（进程内单例） */
export const runtimeStats = {
  /** 全量重建进度 */
  reindex: { running: false, done: 0, total: 0 },
  /** 增量同步节拍 */
  sync: { running: false, lastAt: null, lastAdded: 0, nextAt: null },
  /**
   * 索引维护中（启动同步 / 手动·定时同步 / 重建 统一状态机，由 db.js 直接赋值）。
   * step 系列字段描述「当前在第几步做什么」，scanned/total 仅在 step='scan' 时有意义。
   */
  indexing: {
    running: false, mode: null, done: 0, scanned: 0, total: 0,
    step: null, stepIndex: 0, stepCount: 0, startedAt: 0,
  },
  /** 启动初始化中（仅首次启动同步期间为 true） */
  initializing: false,
  /** 搜索结果缓存命中统计（累计值） */
  cache: { hit: 0, miss: 0 },
};

/* ------------------------------------------------------------------ */
/* 搜索缓存命中率                                                      */
/* ------------------------------------------------------------------ */

/** 缓存命中 +1（自进程启动累计，不随 searchCache.clear() 清零） */
export function markCacheHit() {
  runtimeStats.cache.hit += 1;
}

/** 缓存未命中 +1（同上，累计值） */
export function markCacheMiss() {
  runtimeStats.cache.miss += 1;
}

/* ------------------------------------------------------------------ */
/* 全量重建                                                            */
/* ------------------------------------------------------------------ */

/** 重建开始 */
export function beginReindex() {
  runtimeStats.reindex = { running: true, done: 0, total: 0 };
}

/** 重建进度（由 api.reindex 的 onProgress 回调驱动；step 为当前阶段名） */
export function setReindexProgress(done, total, step = null) {
  runtimeStats.reindex = { running: true, done, total, step };
}

/** 重建结束（成功/失败都要调，建议放在 finally 中） */
export function endReindex() {
  runtimeStats.reindex = { running: false, done: 0, total: 0 };
}

/* ------------------------------------------------------------------ */
/* 增量同步                                                            */
/* ------------------------------------------------------------------ */

/** 同步开始 */
export function beginSync() {
  runtimeStats.sync.running = true;
}

/**
 * 同步结束（成功/失败都要调，建议放在 finally 中）。只记录本轮结果，
 * 下次触发时刻由调度器提供（见 index.js 的 getNextSyncAt）。
 * @param {number} added 本轮补录行数；异常时为 0
 */
export function endSync(added) {
  runtimeStats.sync.running = false;
  runtimeStats.sync.lastAt = Date.now();
  runtimeStats.sync.lastAdded = added;
}

/**
 * 写入下次同步时刻：来源是 cron 表达式的推算值，而非「上次 + 固定间隔」。
 * @param {number|null} at 时间戳；非有限值按 null 处理（未启用 / 无法推算）
 */
export function setNextSyncAt(at) {
  runtimeStats.sync.nextAt = Number.isFinite(at) ? at : null;
}


