/**
 * 搜索子进程池（按需 spawn + 有界并发 + 等待队列）
 * ------------------------------------------------------------------
 * 用「进程」而非「线程」：驱动是同步 API，一条查询会把执行单元阻塞在 C++ 里，
 * terminate() 的终止标志要等执行权回到 JS 才被检查，只有操作系统级 kill 能真正中断
 * ——这是「关页面即停」的唯一手段。
 *
 * 内存模型（常驻 0 个进程）：第一个查询到来才 spawn；未达 maxProcesses 则继续 spawn，
 * 已达上限则新查询进 FIFO 等待队列；客户端断开即 SIGKILL 并移出池（不补位）；
 * 查询完成后按 recycleImmediate 决定立刻回收还是保留复用（空闲超过 idleMs 回收）。
 *
 * 取消是两级的：仍在队列中直接移除；已派发则 SIGKILL 该进程。
 */
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import { clampInt } from './util.js';
import { spawnChild } from './child-process.js';
import { SEARCH_WORKER_FLAG } from './worker-flags.js';

const CHILD_PATH = fileURLToPath(new URL('./search-child.mjs', import.meta.url));

export class SearchExecutor {
  /**
   * @param {object} opts
   * @param {number} [opts.maxProcesses=2]       最大并发进程数
   * @param {number} [opts.idleMs=60000]         进程空闲多久后回收（ms），0 = 不回收
   * @param {number} [opts.queueMax=16]          等待队列上限
   * @param {number} [opts.queueTimeoutMs=10000] 排队超时（ms），0 = 不限时
   * @param {boolean} [opts.recycleImmediate=false] 查询完成即回收进程；为 true 时 idleMs 被忽略
   * @param {string} [opts.indexPath]            主进程解析出的索引库（热库）路径，透传给子进程
   * @param {string} [opts.filesPath]            主进程解析出的冷库路径，透传给子进程
   */
  constructor({
    maxProcesses = 2,
    idleMs = 60_000,
    queueMax = 16,
    queueTimeoutMs = 10_000,
    recycleImmediate = false,
    indexPath,
    filesPath,
  } = {}) {
    this.maxProcesses = clampInt(maxProcesses, 2, 1, 16);
    this.idleMs = clampInt(idleMs, 60_000, 0, Number.MAX_SAFE_INTEGER);
    this.queueMax = clampInt(queueMax, 16, 0, 1024);
    this.queueTimeoutMs = clampInt(queueTimeoutMs, 10_000, 0, Number.MAX_SAFE_INTEGER);
    // 严格判等：config 里若误写成字符串 'false'，也应走「延迟回收」而非「立即回收」
    this.recycleImmediate = recycleImmediate === true;
    this.indexPath = indexPath;
    this.filesPath = filesPath;

    /** 存活的进程槽位；初始为空，随查询按需增长、随空闲/断开收缩 */
    /** @type {Array<{child: object, busy: boolean, dead: boolean, seq: number, task: object|null, lastUsed: number}>} */
    this.pool = [];
    /** @type {Array<object>} 等待中的任务（FIFO） */
    this.queue = [];
    /** 已派发但客户端已断开的任务计数，仅用于日志观测 */
    this.abandoned = 0;
    this._shuttingDown = false;
    /**
     * 暂停派发（索引库原子切换窗口内为真）：期间不派生新进程（新进程会立刻打开即将
     * 被替换的旧库文件，使 rename 重试甚至失败）。队列仍可接收任务，由 resume() 解除。
     */
    this._paused = false;

    // 立即回收模式下不存在「空闲进程」，无需启动回收扫描
    if (!this.recycleImmediate && this.idleMs > 0) {
      // 扫描间隔取 idleMs 与 30s 的较小值，且不小于 5s
      const sweep = Math.max(5_000, Math.min(this.idleMs, 30_000));
      this._reclaimTimer = setInterval(() => this._reclaimIdle(), sweep);
      if (typeof this._reclaimTimer.unref === 'function') this._reclaimTimer.unref();
    }
  }

  /** 标记槽位死亡、移出池并 SIGKILL 其进程（对已移除的槽位幂等） */
  _killSlot(slot) {
    slot.dead = true;
    this._remove(slot);
    try {
      slot.child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }

  /** 当前存活进程数（观测用） */
  get size() {
    return this.pool.length;
  }

  /** 派生一个子进程并挂进池中（按需调用：池初始为空，首个查询才走到这里） */
  _spawn() {
    // 通过环境变量把主进程解析好的库路径交给子进程（比 IPC 消息更早生效，无竞态）
    let env = process.env;
    if (this.indexPath) env = { ...env, DHT_SEARCH_INDEX_DB_PATH: this.indexPath };
    if (this.filesPath) env = { ...env, DHT_SEARCH_FILES_DB_PATH: this.filesPath };
    // 统一派生入口：源码态跑脚本，编译态由 exe 自拉起（见 src/child-process.js）
    const child = spawnChild({ entryPath: CHILD_PATH, flag: SEARCH_WORKER_FLAG, env });
    const slot = {
      child,
      busy: false,
      dead: false,
      seq: 0,
      task: null,
      lastUsed: Date.now(),
    };

    child.on('message', (msg) => {
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      slot.lastUsed = Date.now();
      // task 为空说明客户端已断开、结果被丢弃（见 cancel）
      if (!task) return;
      if (msg?.type === 'result') task.resolve(msg.result);
      else {
        task.reject(
          Object.assign(new Error(msg?.error || 'search failed'), {
            code: msg?.code || 'SEARCH_ERROR',
          })
        );
      }
      // 立即回收模式：查询一完成就杀进程（代价是每次查询重新 spawn，换来空闲内存最低）
      if (this.recycleImmediate) this._killSlot(slot);
      // 槽位空出（或已回收），立即把队列头部的任务派过来
      this._dispatch();
    });

    child.on('error', (err) => {
      slot.dead = true;
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      task?.reject(err);
      this._remove(slot);
      this._dispatch();
    });

    child.on('exit', (code) => {
      slot.dead = true;
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      // seq 仍为 0 说明刚 spawn 就退出（多半是索引库不可用或子进程脚本报错）
      if (slot.seq === 0) {
        log.error(`搜索子进程启动即退出（code=${code}）：索引库是否可用？`);
      }
      task?.reject(new Error('搜索子进程意外退出'));
      // 不补位：进程数随查询按需增长、随空闲/断开收缩，空闲时回到 0
      this._remove(slot);
      this._dispatch();
    });

    this.pool.push(slot);
    return slot;
  }

  _remove(slot) {
    const i = this.pool.indexOf(slot);
    if (i >= 0) this.pool.splice(i, 1);
  }

  _dequeue(task) {
    const i = this.queue.indexOf(task);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** 从队列头部取任务派发给空闲进程；无空闲且未达上限则 spawn 新的 */
  _dispatch() {
    while (this.queue.length > 0 && !this._shuttingDown && !this._paused) {
      const slot = this.pool.find((s) => !s.busy && !s.dead);
      if (!slot) {
        if (this.pool.length < this.maxProcesses) {
          this._spawn();
          continue; // 新进程已入池，下一轮循环会选中它
        }
        return; // 已达上限，任务留在队列里等
      }
      const task = this.queue.shift();
      slot.busy = true;
      slot.seq += 1;
      slot.task = task;
      slot.lastUsed = Date.now();
      task.slot = slot;
      slot.child.send({ id: slot.seq, params: task.params });
    }
  }

  /** 回收空闲超时的进程：空闲足够久后进程数回到 0 */
  _reclaimIdle() {
    if (this._shuttingDown) return;
    const now = Date.now();
    for (let i = this.pool.length - 1; i >= 0; i -= 1) {
      const slot = this.pool[i];
      if (slot.busy || slot.dead || slot.task) continue;
      if (now - slot.lastUsed < this.idleMs) continue;
      slot.dead = true;
      this.pool.splice(i, 1);
      try {
        // 空闲状态下 kill 立即生效（不涉及卡在原生调用里的情况）
        slot.child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }

  /**
   * 派发一次搜索。
   * @param {object} params 透传给 buildSearchApi().searchMagnetsSync 的参数
   * @returns {{ done: Promise<any>, cancel: () => void }} cancel 在客户端断开时调用：
   *   仍在队列中则零成本移除，已派发则 SIGKILL 该进程（真正中断同步查询）
   */
  run(params) {
    let task;
    const done = new Promise((resolve, reject) => {
      if (this._shuttingDown) {
        reject(new Error('服务正在关闭'));
        return;
      }
      // queueMax=0 语义为「不排队」：仅当有空闲槽位或还能扩容时立即执行，否则快速失败。
      // （旧实现 `queue.length >= 0` 恒真，会把所有请求无差别拒绝）
      const canRunNow =
        this.pool.some((s) => !s.busy && !s.dead) || this.pool.length < this.maxProcesses;
      const saturated = this.queueMax === 0 ? !canRunNow : this.queue.length >= this.queueMax;
      if (saturated) {
        reject(Object.assign(new Error('搜索队列已满，请稍后重试'), { code: 'QUEUE_FULL', status: 503 }));
        return;
      }
      // 统一收口：清排队定时器 + 防止重复 settle
      const settle = (fn, value) => {
        if (task.settled) return;
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        fn(value);
      };
      task = {
        params,
        slot: null,
        timer: null,
        settled: false,
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
      };
      if (this.queueTimeoutMs > 0) {
        task.timer = setTimeout(() => {
          this._dequeue(task);
          task.reject(Object.assign(new Error('搜索排队超时'), { code: 'QUEUE_TIMEOUT', status: 503 }));
        }, this.queueTimeoutMs);
      }
      this.queue.push(task);
      this._dispatch();
    });

    return {
      done,
      cancel: () => {
        if (!task || task.settled) return;
        if (task.timer) clearTimeout(task.timer);
        if (task.slot) {
          // 已派发：SIGKILL 是唯一能中断同步 SQLite 调用的手段（见文件头）
          const slot = task.slot;
          task.slot = null;
          slot.task = null; // 结果回来后直接丢弃
          this._killSlot(slot);
          this.abandoned += 1;
        } else {
          // 还在排队：零成本取消
          this._dequeue(task);
        }
        // 必须 reject，否则调用方的 `await job.done` 会永远挂起
        task.reject(Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' }));
      },
    };
  }

  /**
   * 为「索引库原子切换」回收全部搜索子进程：杀掉并清空池，但保持池可用。
   * 只置 _paused 而不用 terminateAll（后者置 _shuttingDown 且不恢复，复用会让此后所有
   * 检索都返回「服务正在关闭」）：暂停期间不派发也不派生新进程，由 resume() 解除。
   * 在飞的查询随进程被杀而失败（它们读的正是将被替换的旧库）。
   *
   * @returns {number} 被回收的进程数
   */
  recycleAll() {
    const n = this.pool.length;
    for (const slot of this.pool.slice()) this._killSlot(slot);
    this._paused = true;
    return n;
  }

  /** 切换完成后解除暂停，并把暂停期间积压的查询继续派发出去 */
  resume() {
    if (this._shuttingDown) return;
    this._paused = false;
    this._dispatch();
  }

  /** 关闭所有子进程（进程退出时调用），覆盖空闲 / 忙碌 / 排队中全部状态 */
  terminateAll() {
    this._shuttingDown = true;
    if (this._reclaimTimer) clearInterval(this._reclaimTimer);
    for (const task of this.queue) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(new Error('服务正在关闭'));
    }
    this.queue = [];
    for (const slot of this.pool) {
      slot.dead = true;
      try {
        slot.child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    this.pool = [];
  }
}

export function createSearchExecutor(options) {
  return new SearchExecutor(options);
}
