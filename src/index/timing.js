/**
 * 索引流水线的分段计时
 * ------------------------------------------------------------------
 * 只做「批级」计时：measure / add 发生在批边界，一次重建几百次调用，开销可忽略。
 *
 * 时间口径（互斥，可直接相加）：
 *   scan       扫描源库（allRows 调用本身）
 *   fts/docs/keyword  SQLite 写入的三段（批事务内部）
 *   txn        批事务的提交／回滚与 WAL 落页（见 exclude()：它包着上面三段，须扣除）
 *   index/merge/checkpoint/schema  收尾的各步
 *   js         未归类时间 = 总耗时 − 以上各段之和（纯 JS 处理与主线程 GC）
 *
 * 本模块零外部依赖，可独立测试。
 */

/** performance.now()：Node 与 Bun 均有；单调时钟，不受系统时间调整影响 */
const now = () => performance.now();

/**
 * 索引流水线分段计时器。
 *   const t = new IndexTimer();
 *   const rows = t.measure('scan', () => allRows(...));
 *   ...
 *   runtimeStats.indexing.phases = t.snapshot();
 */
export class IndexTimer {
  constructor() {
    this._startedAt = now();
    /** 已被归类到具体阶段的毫秒数（用于派生 js = total - measured） */
    this._measured = 0;
    /** 各阶段累加表（挂在实例上，便于同一次维护跨函数传递） */
    this._phases = {};
  }

  /**
   * 计时一个同步调用并返回其结果。异常时同样计时（时间计入该阶段）。
   * @template T
   * @param {string} name 阶段名
   * @param {() => T} fn 待计时的同步函数
   * @returns {T}
   */
  measure(name, fn) {
    const t0 = now();
    try {
      return fn();
    } finally {
      this.add(name, now() - t0);
    }
  }

  /**
   * 计时一个**包着其他已计时子段**的调用，只记入「扣除子段后」的净耗时
   * （外层整段计时会把内部各段重复计入）。
   * @param {string} name 阶段名
   * @param {() => T} fn 待计时的同步函数
   * @template T
   */
  exclude(name, fn) {
    const before = { ...this._phases };
    const t0 = now();
    try {
      return fn();
    } finally {
      let inner = 0;
      for (const [key, ms] of Object.entries(this._phases)) inner += ms - (before[key] ?? 0);
      this.add(name, now() - t0 - inner);
    }
  }

  /** 直接累加一段已知耗时（用于无法被 measure 包住的场景，例如批内分段） */
  add(name, ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return;
    this._phases[name] = (this._phases[name] ?? 0) + v;
    this._measured += v;
  }

  /** 快照：各阶段毫秒（取整）+ js（未归类）+ totalMs */
  snapshot() {
    const out = {};
    for (const [key, ms] of Object.entries(this._phases)) out[key] = Math.round(ms);
    out.js = Math.max(0, Math.round(now() - this._startedAt - this._measured));
    out.totalMs = Math.round(now() - this._startedAt);
    return out;
  }

  /** 单行摘要（日志用） */
  summary() {
    return formatPhases(this.snapshot());
  }
}

/**
 * 把阶段快照格式化成一行日志（同进程与子进程两条路径共用，保证格式一致）。
 * @param {Record<string, number>} phases 形如 { scan, fts, docs, txn, js, totalMs }
 */
export const formatPhases = (phases) => {
  if (!phases || Object.keys(phases).length === 0) return '（无分段数据）';
  const { totalMs, ...rest } = phases;
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${v}ms`).join(' ');
  return `总耗时 ${totalMs ?? '-'}ms${detail ? ` | ${detail}` : ''}`;
};

/**
 * 空计时器：让被调用方可以无条件写 `timer.measure(...)` 而不必到处判空
 * （调用方未传 timer 时用它兜底，零开销、零分支）。
 */
export const NOOP_TIMER = Object.freeze({
  measure: (_name, fn) => fn(),
  add: () => {},
  snapshot: () => ({}),
  summary: () => '',
});
