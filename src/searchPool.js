/**
 * 搜索子进程池。
 *
 * 为什么用子进程而不是 worker 线程
 * ------------------------------------------------------------------
 * better-sqlite3 / bun:sqlite 都是同步 API，一条查询会把整个执行单元阻塞在 C++
 * 里。worker.terminate() 走的是 V8 的 Isolate::TerminateExecution —— 终止标志要等
 * 执行权回到 JS 才被检查，卡在原生调用里的查询根本收不到信号。实测（scripts/spike
 * 下的对照实验）：
 *   - Node + better-sqlite3：terminate() 到 worker 真正退出 = 23328ms（＝查询跑完）
 *   - Bun + bun:sqlite     ：6s 后 worker 仍存活
 * 即两个运行时都无法中断。唯一能打断同步原生调用的是操作系统级 kill：实测
 * kill(SIGKILL) -> exit 在 Node / Bun 下均为 6ms。子进程以只读方式打开索引库，
 * 被 SIGKILL 不会造成任何数据损坏。
 *
 * 设计要点
 * ------------------------------------------------------------------
 * - 预先 fork N 个常驻子进程（各自持有一条只读连接），以「槽位（slot）」管理：
 *   检索到来时取一个空闲槽位，完成后归还复用。槽位对象始终留在池中，
 *   进程被杀后由 exit 事件在「原槽位」补一个新进程 —— 池容量恒定，
 *   不会像「pop 出去再补位」那样在每次客户端断开时静默缩水。
 * - 并发超过池容量时临时 fork 一次性进程，用完即回收，避免进程数无上限增长。
 * - 进程崩溃（非主动 kill 的 exit）同样原地补位；若某个槽位从未派发过任何检索
 *   就退出（多半是启动即失败），则放弃补位并告警，避免 spawn 风暴。
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { log } from './logger.js';

const CHILD_PATH = fileURLToPath(new URL('./search-child.mjs', import.meta.url));

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export class SearchExecutor {
  /**
   * @param {number} [size] 池容量。每个槽位都是一个独立 OS 进程（各自一套 V8 堆），
   *   内存开销远大于线程，故默认容量比线程方案更保守（最多 4）。
   * @param {string} [indexPath] 主进程实际解析出的索引库路径，透传给每个子进程，
   *   保证子进程打开的库与主进程完全一致（否则自定义路径时子进程会查错库）。
   */
  constructor(size, indexPath) {
    this.size = clampInt(size, Math.max(2, Math.min(4, os.cpus().length)), 1, 16);
    this.indexPath = indexPath;
    /** @type {Array<{child: object, busy: boolean, killed: boolean, extra: boolean, seq: number, pending: object|null}>} */
    this.pool = [];
    /** 全部存活进程（含临时扩容的一次性进程），供 terminateAll 收口 */
    this._all = new Set();
    for (let i = 0; i < this.size; i += 1) this.pool.push(this._spawn());
  }

  _spawn() {
    // 通过环境变量把主进程解析好的索引库路径交给子进程（比 IPC 消息更早生效，无竞态）
    const env = this.indexPath
      ? { ...process.env, DHT_SEARCH_INDEX_DB_PATH: this.indexPath }
      : process.env;
    const child = fork(CHILD_PATH, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env });
    const slot = {
      child,
      busy: false,
      killed: false,
      /** 并发溢出时临时扩容的一次性进程，不在池中、用完即回收 */
      extra: false,
      seq: 0,
      pending: null,
    };

    child.on('message', (msg) => {
      if (!slot.pending || msg.id !== slot.pending.id) return;
      const p = slot.pending;
      slot.pending = null;
      if (msg.type === 'result') p.resolve(msg.result);
      else {
        p.reject(
          Object.assign(new Error(msg.error || 'search failed'), {
            code: msg.code || 'SEARCH_ERROR',
          })
        );
      }
    });

    child.on('error', (err) => {
      if (slot.pending) {
        slot.pending.reject(err);
        slot.pending = null;
      }
    });

    child.on('exit', () => {
      this._all.delete(child);
      slot.killed = true;
      if (slot.pending) {
        slot.pending.reject(new Error('search 子进程意外退出'));
        slot.pending = null;
      }
      // 一次性进程不在池中，无需补位
      const i = this.pool.indexOf(slot);
      if (i < 0) return;
      if (slot.seq === 0) {
        // 从未派发过检索就退出 —— 多半是启动即失败（如索引库不可用）。
        // 此时反复补位会变成 spawn 风暴，故放弃该槽位并告警。
        log.error('搜索子进程启动即退出，已放弃该槽位（索引库是否可用？）');
        return;
      }
      this.pool[i] = this._spawn();
    });

    this._all.add(child);
    return slot;
  }

  _acquire() {
    const idle = this.pool.find((s) => !s.busy && !s.killed);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    // 池中进程全部忙碌：临时 fork 一个一次性进程，用完即回收
    const extra = this._spawn();
    extra.busy = true;
    extra.extra = true;
    return extra;
  }

  /**
   * 派发一次搜索到子进程。
   * @param {object} params 透传给 buildSearchApi().searchMagnetsSync 的参数
   * @returns {{ done: Promise<any>, release: () => void, terminate: () => void }}
   *   - done: 解析为检索结果（或 reject 为错误）
   *   - release: 查询正常完成后归还槽位到池
   *   - terminate: 客户端断开时调用——SIGKILL 该进程，中断其正在执行的同步 SQLite 查询
   */
  run(params) {
    const slot = this._acquire();
    return {
      done: new Promise((resolve, reject) => {
        const id = (slot.seq += 1);
        slot.pending = { id, resolve, reject };
        slot.child.send({ id, params });
      }),
      release: () => {
        slot.busy = false;
        // 一次性进程用完即回收，避免进程数随并发无上限增长
        if (slot.extra && !slot.killed) {
          slot.killed = true;
          try {
            slot.child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
        }
      },
      terminate: () => {
        if (slot.killed) return;
        slot.killed = true;
        // SIGKILL：由操作系统直接回收进程，不受同步原生调用阻塞的影响。
        // 这是唯一能真正中断 better-sqlite3 / bun:sqlite 查询的手段（见文件头说明）。
        try {
          slot.child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      },
    };
  }

  /** 关闭所有子进程（进程退出时调用），覆盖空闲 / 忙碌 / 一次性全部进程 */
  terminateAll() {
    for (const child of this._all) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    this.pool = [];
    this._all.clear();
  }
}

export function createSearchExecutor(size, indexPath) {
  return new SearchExecutor(size, indexPath);
}
