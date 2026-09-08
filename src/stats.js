/**
 * 运行期状态（设置面板监测用）
 * ------------------------------------------------------------------
 * 单一数据源：设置面板 SSE 推送所需的全部「服务自身状态」集中在此，由
 * index.js 的 collectStats() 统一组装后推送（src/stats.js 只管状态，不管采集）。
 *
 * 为什么用 begin/end 这类成对函数而不是直接赋值：
 *   reindex / sync 的 running 标志必须在异常路径也复位，否则前端进度条会
 *   永远卡在「正在重建…」。把开始/结束收敛成函数后，调用方只需在 finally
 *   里调 end*()，不可能漏掉复位。
 *
 * 本模块零外部依赖（不 import 任何运行时对象），可独立测试。
 */

/** 运行期状态快照（进程内单例） */
export const runtimeStats = {
  /** 全量重建进度 */
  reindex: { running: false, done: 0, total: 0 },
  /** 增量同步节拍 */
  sync: { running: false, lastAt: null, lastAdded: 0, nextAt: null },
  /** 索引维护中（启动同步 / 手动·定时同步 / 重建 统一状态机，由 db.js 直接赋值） */
  indexing: { running: false, mode: null, done: 0, total: 0 },
  /** 启动初始化中（仅首次启动同步期间为 true） */
  initializing: false,
  /** 搜索结果缓存命中统计（累计值） */
  cache: { hit: 0, miss: 0 },
};

/* ------------------------------------------------------------------ */
/* 搜索缓存命中率                                                      */
/* ------------------------------------------------------------------ */

/**
 * 缓存命中 +1。
 * 刻意做成「自进程启动累计」而非随 searchCache.clear() 清零——这样能直接
 * 观察到每次增量同步清空缓存后命中率从高位跌落的过程。
 */
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

/** 重建进度（由 api.reindex 的 onProgress 回调驱动） */
export function setReindexProgress(done, total) {
  runtimeStats.reindex = { running: true, done, total };
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
 * 同步结束（成功/失败都要调，建议放在 finally 中）。
 * @param {number} added      本轮补录行数；异常时为 0
 * @param {number} [intervalMs] 同步周期，用于推算下次触发时刻；不传则不改动 nextAt
 */
export function endSync(added, intervalMs) {
  const now = Date.now();
  runtimeStats.sync.running = false;
  runtimeStats.sync.lastAt = now;
  runtimeStats.sync.lastAdded = added;
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    runtimeStats.sync.nextAt = now + intervalMs;
  }
}


