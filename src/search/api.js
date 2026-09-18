/**
 * 检索实现（主进程与搜索子进程共用）
 * ------------------------------------------------------------------
 * 接收一个只读 drizzle 连接，返回同步检索函数：createMagnetDb 用它构建主进程查询 API，
 * search-child.mjs 也用它（各自持有独立连接），Node / Bun 共用同一套实现。
 *
 * 「客户端断开即停」不在本模块实现：驱动是同步 API，单条 SQL 执行期间无法从 JS 打断，
 * 只能由 HTTP 层把查询放进独立子进程、断开时 SIGKILL（见 src/searchPool.js）。
 * 本模块只负责查出结果，并对整集拉取做内存上限保护（WHOLESET_CAP）。
 */
import { sql } from 'drizzle-orm';
import {
  FTS_TABLE,
  DOCS_TABLE,
  DOCS_LIST_SELECT,
  FILES_TABLE,
  PREVIEW_TABLE,
  STATE_KEYS,
} from '../store.js';
import { prepareStmt, execRaw, pluckAll, runStmt, transaction } from '../db-driver.js';
import { MAX_RESULTS } from '../settings.js';
import { TOKEN_PATTERN } from '../util.js';
import { buildFlatTree } from '../file-tree.js';
import { decodeFiles } from '../index/files-store.js';
import {
  buildMatchExpression,
  normalizeSearchQuery,
  normalizeLatestQuery,
  orderSqlFor,
} from './query.js';

/** 预览条数上限：卡片只展示前几条文件（有关键词时优先展示命中的） */
const PREVIEW_LIMIT = 5;

/**
 * TEMP 物化快路径的匹配集规模阈值：id 排序 + size 筛选时，匹配集小于该值走普通 JOIN
 * （小集排序本就快，不值得物化），达到才物化 FTS 匹配 rowid 进 TEMP 表做主键探测。
 */
const TEMP_HITS_MIN_TOTAL = 10_000;

/** count 缓存条目上限：受益场景是「同词翻页」，几十条已覆盖一次会话 */
const COUNT_CACHE_MAX = 200;

/**
 * keyset 游标编解码：base64url(JSON `{ v: 排序键值, i: 行id })`。v 仅列排序使用，
 * id 排序只用 i。游标是 opaque token：调用方必须原样回传上一次响应给出的 nextCursor。
 */
const encodeCursor = (v, id) =>
  Buffer.from(JSON.stringify({ v, i: id })).toString('base64url');

/** 解码游标；非法输入直接抛错（比静默回退 offset 更利于暴露调用方 bug） */
const decodeCursor = (text) => {
  try {
    const o = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    if (o && Number.isFinite(o.v) && Number.isInteger(o.i) && o.i >= 0) {
      return { v: Number(o.v), id: Number(o.i) };
    }
  } catch {
    /* 落入下方统一报错 */
  }
  throw new TypeError('cursor 非法：请原样回传上一次响应的 nextCursor');
};

/** 从检索词里提取「预览优先命中」用的 token（去重、小写；只做包含匹配，与 FTS 分词无关） */
const queryTokens = (query) => {
  if (!query) return [];
  const matched = String(query).toLowerCase().match(TOKEN_PATTERN);
  return matched ? [...new Set(matched)] : [];
};

/**
 * 从已解析的文件条目列表挑选预览 `[{ path, size }]`：有关键词时只保留路径命中者
 * （命中越多越靠前），否则按原顺序取前 N 条。这是列表路径上唯一读文件列表的地方。
 */
const pickPreview = (list, tokens) => {
  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    const path = f && typeof f.path === 'string' ? f.path : '';
    if (!path) continue;
    let score = 0;
    if (tokens.length > 0) {
      const lower = path.toLowerCase();
      for (const t of tokens) if (lower.includes(t)) score += 1;
      if (score === 0) continue;
    }
    scored.push({ path, size: Number(f.size) || 0, score, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, PREVIEW_LIMIT).map((x) => ({ path: x.path, size: x.size }));
};

/** 从索引期派生的 preview 小列（前 N 条 {path,size} 的 JSON 文本）挑预览 */
const buildStoredPreview = (stored, tokens = []) => {
  if (!stored) return [];
  let parsed;
  try {
    parsed = JSON.parse(String(stored));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? pickPreview(parsed, tokens) : [];
};

/**
 * 检索逻辑工厂：接收两个只读连接，返回同步检索函数。
 *
 * @param {object} dbRO    热库只读连接（drizzle 包装）：副本表 + FTS5
 * @param {object} [filesRO] 冷库只读连接（drizzle 包装）：magnets_files / magnets_preview。
 *        检索子进程若不传，详情与该页预览会退化为空（检索本身仍可用）。
 * @returns {{ searchMagnetsSync: Function, listLatestSync: Function, getMagnetFilesSync: Function }}
 */
export const buildSearchApi = (dbRO, filesRO = null) => {
  /**
   * 给一页副本表行附着 preview（冷库按 id 批量回查，一次查询搞定整页）。
   *
   * preview 是纯「最后一公里」数据：count / 排序 / 筛选都不需要它，只有最终返回的
   * 那几十行需要。放在冷库而不是副本表里，副本表就能保持窄表——这正是列排序快路径
   * 的关键（回表成本取决于副本表的页数）。
   *
   * @param {Array<object>} rows 副本表行（不含 preview）
   * @param {string[]} tokens 查询 token（用于「命中优先」挑预览）
   */
  const attachPreviews = (rows, tokens = []) => {
    if (rows.length === 0) return [];
    const stored = new Map();
    if (filesRO) {
      const ids = rows.map((r) => r.id);
      for (const r of filesRO.all(
        sql`SELECT id, preview FROM ${sql.raw(PREVIEW_TABLE)}
            WHERE id IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `
            )})`
      )) {
        stored.set(r.id, r.preview);
      }
    }
    return rows.map((row) => ({ ...row, preview: buildStoredPreview(stored.get(row.id), tokens) }));
  };
  /** 整集拉取安全上限（与 config.js 的 MAX_RESULTS 对齐，配置缺失则回退 20000） */
  const WHOLESET_CAP =
    Number.isFinite(Number(MAX_RESULTS)) && Number(MAX_RESULTS) > 0 ? Number(MAX_RESULTS) : 20000;

  /**
   * 构造大小筛选片段（值已由 normalizeSearchQuery 校验为「有限非负」或 undefined）。
   * 无条件时返回空片段，调用方无需再判空。
   */
  const buildSizeCond = ({ minSize, maxSize }) => {
    const conds = [];
    if (minSize !== undefined) conds.push(sql`m.totalSize >= ${minSize}`);
    if (maxSize !== undefined) conds.push(sql`m.totalSize <= ${maxSize}`);
    // bun 下 drizzle 会把 sql.join 的字符串分隔符参数化成 `?`，故显式拼接而不用 join
    if (conds.length === 0) return sql``;
    if (conds.length === 1) return sql` AND ${conds[0]}`;
    return sql` AND ${conds[0]} AND ${conds[1]}`;
  };

  /** 归一化 infohash：剥离 magnet 链接里的 urn:btih: 前缀，并去除所有非字母数字字符 */
  const normalizeInfohash = (query) =>
    String(query ?? '')
      .replace(/^.*urn:btih:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();

  /** FTS5 模糊检索：JOIN FTS 表，顺带剔除源库中已删除的残留索引行（保证 total 与返回数一致） */
  const ftsWhere = (query, field) => {
    const match = buildMatchExpression(query, field);
    if (!match) {
      throw new TypeError('searchMagnets: options.query 不能为空，且需包含至少一个字母或数字');
    }
    // FTS5 MATCH 必须接收「SQL 字符串字面量」形式的查询表达式（单引号包裹），否则 SQLite 会把
    // 双引号短语误当标识符、或把参数化占位符 ? 在 prepare 阶段抛 fts5: near "?"。
    // match 已白名单化（仅字母数字 / 双引号 / AND / * / 列过滤），安全。
    return {
      join: sql`JOIN ${sql.raw(FTS_TABLE)} f ON m.id = f.rowid`,
      cond: sql`${sql.raw(FTS_TABLE)} MATCH ${sql.raw(`'${match}'`)}`,
    };
  };

  /** infohash 精确检索：无需 JOIN，直接匹配副本表，兼容「带/不带 hash 前缀」并支持前缀检索 */
  const hashWhere = (query) => {
    const raw = normalizeInfohash(query);
    if (!raw) {
      throw new TypeError('searchByHash: 未提供有效的 infohash');
    }
    return {
      join: sql``,
      // 前缀检索用范围条件而非 LIKE：LIKE 的左操作数是 lower(...) 表达式，无法使用
      // lower(infohash) 表达式索引（SQLite 的 LIKE 优化只认裸列），会导致整个 OR 退化
      // 成全索引扫描；范围条件可走索引，使 OR 优化生效（三个分支各自走索引）。
      // 上界取 \uffff 保证覆盖所有前缀。
      cond: sql`lower(m.infohash) = lower(${raw})
        OR lower(m.infohash) = lower(${'hash' + raw})
        OR (lower(m.infohash) >= lower(${raw}) AND lower(m.infohash) < lower(${raw + '\uffff'}))`,
    };
  };

  /**
   * 由归一化参数构造 count / 分页 SQL 工厂（两种检索模式的差异只有是否 JOIN FTS 表
   * 与匹配条件，其余拼装共用。count 与 page 各针对宽泛词做了优化，见下方各处注释）。
   */
  const prepareSearch = (options) => {
    const s = normalizeSearchQuery(options);
    const { join, cond } = s.by === 'hash' ? hashWhere(s.query) : ftsWhere(s.query, s.searchIn);
    const fromWhere = sql`
      FROM ${sql.raw(DOCS_TABLE)} m ${join}
      WHERE ${cond}${buildSizeCond(s)}
    `;
    const hasSize = s.minSize !== undefined || s.maxSize !== undefined;
    // keyset 游标（E）：仅 FTS 模式支持；整集拉取无分页语义，忽略游标。
    // relevance（bm25）排序的键不在副本表上、无法 keyset，同样忽略游标回退 offset。
    const cursor =
      s.by === 'fts' && s.limit !== -1 && s.cursor && s.sortBy !== 'relevance'
        ? decodeCursor(s.cursor)
        : null;
    return {
      // count 无大小筛选时直接查 FTS 虚表，省掉「每个匹配 rowid 回 docs 主键查找」；
      // 代价是残留行会让 total 略偏大（DHT 场景删除极少，可接受）
      buildCount: () =>
        s.by === 'fts' && !hasSize
          ? sql`SELECT count(*) AS total FROM ${sql.raw(FTS_TABLE)} WHERE ${cond}`
          : sql`SELECT count(*) AS total ${fromWhere}`,
      buildPage: (lim, off) => {
        // 预取 rowid 再 JOIN：利用 FTS5 对 rowid 的有序输出提前终止。
        // 仅在「FTS + 无大小筛选 + 默认 id 排序」下可用（其余情况的排序键不是 rowid，
        // 或有大小筛选时预取行会被外层过滤掉导致结果偏少）。
        if (s.by === 'fts' && !hasSize && !s.sortBy) {
          const dir = s.order === 'asc' ? 'ASC' : 'DESC';
          // keyset：游标模式用 rowid 谓词替代 OFFSET（FTS5 原生支持 rowid 范围约束）
          const cursorCond = cursor
            ? sql` AND rowid ${sql.raw(s.order === 'asc' ? '>' : '<')} ${cursor.id}`
            : sql``;
          return sql`
            SELECT ${sql.raw(DOCS_LIST_SELECT)} FROM ${sql.raw(DOCS_TABLE)} m
            JOIN (SELECT rowid FROM ${sql.raw(FTS_TABLE)}
                  WHERE ${cond}${cursorCond} ORDER BY rowid ${sql.raw(dir)}
                  LIMIT ${lim} OFFSET ${off}) f ON m.id = f.rowid
            ORDER BY m.id ${sql.raw(dir)}
          `;
        }
        return sql`
          SELECT ${sql.raw(DOCS_LIST_SELECT)} ${fromWhere}
          ${sql.raw(orderSqlFor(s))}
          LIMIT ${lim} OFFSET ${off}
        `;
      },
      wholeSet: s.limit === -1,
      effLimit: s.limit,
      effOffset: s.offset,
      query: s.query, // 供调用方挑预览：attachPreviews 需要按关键词优先
      cond,
      s,
      cursor,
      // count 缓存键：同一检索词 + size 区间 + 搜索范围（name/files）的 total 相同（水位失效见 cachedTotal）
      countKey: `${s.by}|${s.query}|${s.searchIn ?? ''}|${s.minSize ?? ''}|${s.maxSize ?? ''}`,
    };
  };

  /**
   * 同步检索：先 count 再取页（整集拉取则一次取到 CAP），一次性返回。
   * @param {object} options 见 normalizeSearchQuery
   * @returns {{ total: number, limit: number|'all', offset: number, items: Array, truncated?: boolean }}
   */
  /**
   * count 水位缓存（D）：宽词 count 要枚举完整 doclist（开销大），而同词
   * 翻页期间 total 不变。以 sync_meta 数据水位为失效依据：水位未变 ⇒ 数据未变。
   * 读水位是一次主键查找，远小于一次宽词 count 重算。
   */
  const countCache = new Map();
  /** 当前数据水位；sync_meta 不可读时返回 null（调用方据此跳过缓存写入） */
  const readWatermark = () => {
    try {
      return String(
        dbRO.all(sql`SELECT value FROM sync_meta WHERE key = ${STATE_KEYS.dataWatermark}`)[0]?.value ?? ''
      );
    } catch {
      return null;
    }
  };
  const cachedTotal = (key, compute) => {
    const wm = readWatermark();
    if (wm === null) return compute(); // sync_meta 不可读的异常环境：退化为不缓存
    const hit = countCache.get(key);
    if (hit && hit.wm === wm) {
      // LRU touch：Map 迭代序即插入序，删了重插把命中项挪到最新
      countCache.delete(key);
      countCache.set(key, hit);
      return hit.total;
    }
    const total = compute();
    countCache.set(key, { wm, total });
    if (countCache.size > COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
    return total;
  };

  /**
   * 列排序第一步（A，只取 id）：INDEXED BY 强制沿排序列索引（覆盖索引，含 id）扫描，
   * IN 列表物化后走 bloom filter 做整型成员判定，凑够 LIMIT 即停。
   * 形状决定索引价值：若不加 INDEXED BY，planner 会走 TEMP B-TREE 物化全部匹配再排序
   * （宽词极慢）；本形状下宽词与深分页都很快。
   * 投影刻意只有 id：不给 planner 任何「SELECT 含 files 大列就改写计划、逐行重跑 FTS」的机会。
   * INDEXED BY 是硬约束（索引缺失直接报错），对缺索引的只读连接回退无提示形状（慢但正确）。
   */
  const buildColSortIds = ({ col, dir, cond, sizeCond, lim, off, cursor }) => {
    const op = dir === 'ASC' ? '>' : '<';
    // keyset（E）：游标模式用 (col,id) 谓词替代 OFFSET，深翻页不随页深线性变慢
    const keyset = cursor
      ? sql` AND (m.${sql.raw(col)} ${sql.raw(op)} ${cursor.v}
          OR (m.${sql.raw(col)} = ${cursor.v} AND m.id ${sql.raw(op)} ${cursor.id}))`
      : sql``;
    const where = sql`WHERE m.id IN (SELECT rowid FROM ${sql.raw(FTS_TABLE)} WHERE ${cond})${sizeCond}${keyset}`;
    const order = sql`ORDER BY m.${sql.raw(col)} ${sql.raw(dir)}, m.id ${sql.raw(dir)}`;
    try {
      return dbRO
        .all(
          sql`SELECT m.id FROM ${sql.raw(DOCS_TABLE)} m INDEXED BY ${sql.raw(`idx_${DOCS_TABLE}_${col}`)}
              ${where} ${order} LIMIT ${lim} OFFSET ${off}`
        )
        .map((r) => r.id);
    } catch {
      return dbRO
        .all(sql`SELECT m.id FROM ${sql.raw(DOCS_TABLE)} m ${where} ${order} LIMIT ${lim} OFFSET ${off}`)
        .map((r) => r.id);
    }
  };

  /**
   * TEMP 物化公共段（A）：把 FTS 匹配 rowid 物化进 TEMP 表（INTEGER PRIMARY KEY，
   * 主键探测 O(log n)），fn 在 hits 就绪后执行，结束必清表。
   * TEMP 表需要连接允许写临时 schema：读连接开着 query_only=ON（连 temp 写入也拦），
   * 故期间临时切 OFF——主库文件本身以 readonly 模式打开，主库数据仍不可写；finally 恢复。
   * 个别驱动仍可能限制 TEMP 写入（抛错），由调用方回退通用 JOIN 路径。
   */
  const withHits = (match, fn) => {
    const raw = dbRO.$client ?? dbRO.session?.client;
    execRaw(raw, 'PRAGMA query_only = OFF');
    try {
      execRaw(raw, 'DROP TABLE IF EXISTS temp.hits');
      execRaw(raw, 'CREATE TEMP TABLE hits (rid INTEGER PRIMARY KEY)');
      const ids = pluckAll(raw, `SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH '${match}'`);
      const ins = prepareStmt(raw, 'INSERT INTO hits (rid) VALUES (?)');
      transaction(raw, () => {
        for (const id of ids) runStmt(ins, [id]);
      })();
      return fn();
    } finally {
      try {
        execRaw(raw, 'DROP TABLE IF EXISTS temp.hits');
      } catch {
        /* 清理失败不影响结果 */
      }
      try {
        execRaw(raw, 'PRAGMA query_only = ON');
      } catch {
        /* 恢复失败只影响误写防护，不影响结果 */
      }
    }
  };

  /** 「id 排序 + size 筛选 + 大匹配集」取页：主表沿 rowid 序扫描、逐行探测 hits 与 size
   *  条件，凑够 LIMIT 即停 —— 无 TEMP B-TREE 排序、不碰 files 大页（列表取列）。 */
  const tempHitsPage = ({ match, dir, lim, off, cursor, sizeCond, tokens }) => {
    if (!match) throw new TypeError('tempHitsPage: 缺少 MATCH 表达式');
    return withHits(match, () => {
      // keyset（E）：id 排序的游标就是 rowid 谓词
      const keyset = cursor ? sql` AND m.id ${sql.raw(dir === 'ASC' ? '>' : '<')} ${cursor.id}` : sql``;
      const rows = dbRO.all(sql`
        SELECT ${sql.raw(DOCS_LIST_SELECT)} FROM ${sql.raw(DOCS_TABLE)} m
        CROSS JOIN temp.hits h
        WHERE h.rid = m.id${sizeCond}${keyset}
        ORDER BY m.id ${sql.raw(dir)}
        LIMIT ${lim} OFFSET ${off}`);
      return attachPreviews(rows, tokens);
    });
  };

  const searchMagnetsSync = (options) => {
    const { buildCount, buildPage, wholeSet, effLimit, effOffset, query, cond, s, countKey, cursor } =
      prepareSearch(options);
    // 预览按关键词优先挑：token 只算一次，本页所有行复用
    const tokens = queryTokens(query);
    const hasSize = s.minSize !== undefined || s.maxSize !== undefined;
    // 游标模式下位置由游标决定，OFFSET 无意义；整集拉取从 0 开始
    const off0 = wholeSet || cursor ? 0 : effOffset;
    const sizeCond = buildSizeCond(s);

    /**
     * 闸门用「未过滤的 FTS 匹配数」：FTS-only count 是 doclist 枚举快路径。
     * 若为决策先算 size 过滤的 JOIN count（宽词 = 匹配数 × 随机主键回查 docs），决策本身
     * 就要付出整轮回查的代价。仅在大匹配集时才动用 TEMP 物化。
     */
    const ftsTotal =
      s.by === 'fts' && hasSize
        ? cachedTotal(`${countKey}|__match`, () =>
            Number(dbRO.all(sql`SELECT count(*) AS total FROM ${sql.raw(FTS_TABLE)} WHERE ${cond}`)[0]?.total ?? 0)
          )
        : null;
    const bigMatches = ftsTotal !== null && ftsTotal >= TEMP_HITS_MIN_TOTAL;

    // total：大匹配集的 size 过滤 count 走「hits 驱动的覆盖索引计数」（逐行主键探测，
    // 规避大量随机主键回查）；其余场景沿用原 count（FTS-only 或小集 JOIN）
    const total =
      s.by === 'fts' && hasSize && bigMatches
        ? cachedTotal(countKey, () => {
            try {
              return withHits(buildMatchExpression(s.query, s.searchIn), () =>
                Number(
                  dbRO.all(sql`
                    SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)} m
                    CROSS JOIN temp.hits h
                    WHERE h.rid = m.id${sizeCond}`)[0]?.total ?? 0
                )
              );
            } catch {
              // TEMP 不可用（个别驱动的只读连接限制等）：回退 JOIN count（慢但正确）
              return Number(dbRO.all(buildCount())[0]?.total ?? 0);
            }
          })
        : Number(cachedTotal(countKey, () => Number(dbRO.all(buildCount())[0]?.total ?? 0)));

    /** 第二步：按 ids 主键回查副本表整行并按 ids 顺序重排——
     *  IN(ids) 回查按 rowid 返回，顺序不可靠，必须重排否则列排序退化成按 id 排序】
     *  （preview 不在此列：它由 attachPreviews 从冷库按页回查） */
    const hydrateIds = (ids) => {
      const rows = dbRO.all(
        sql`SELECT ${sql.raw(DOCS_LIST_SELECT)} FROM ${sql.raw(DOCS_TABLE)} m
            WHERE m.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
      );
      const byId = new Map(attachPreviews(rows, tokens).map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    };
    /** 可能还有下一页时给出 keyset 游标；整集拉取或未取满一页不产生。col=null 表示 id 排序 */
    const nextOf = (items, col, lim) => {
      if (wholeSet || items.length === 0 || items.length < lim) return null;
      const last = items.at(-1);
      return encodeCursor(col ? last[col] : last.id, last.id);
    };

    // 副本表普通列排序（totalSize / fetchedAt）——带不带 size 筛选统一走 INDEXED BY 快路径，
    // 第二步主键回查不变（见 buildColSortIds 注释）
    const colSort = s.by === 'fts' && (s.sortBy === 'totalSize' || s.sortBy === 'fetchedAt');
    if (total && colSort) {
      const dir = s.order === 'asc' ? 'ASC' : 'DESC';
      const col = s.sortBy;
      const lim = wholeSet ? WHOLESET_CAP + 1 : effLimit;
      const ids = buildColSortIds({ col, dir, cond, sizeCond, lim, off: off0, cursor });
      const items = ids.length ? hydrateIds(ids) : [];
      if (wholeSet) {
        const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
        if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
        return { total, limit: 'all', offset: 0, items, truncated };
      }
      return { total, limit: effLimit, offset: effOffset, items, nextCursor: nextOf(items, col, lim) };
    }

    // 默认 id 排序 + size 筛选 + 大匹配集：TEMP 物化快路径（小集走下方 JOIN，不值得物化）
    if (total && s.by === 'fts' && hasSize && !s.sortBy && bigMatches) {
      const dir = s.order === 'asc' ? 'ASC' : 'DESC';
      const lim = wholeSet ? WHOLESET_CAP + 1 : effLimit;
      try {
        const items = tempHitsPage({
          match: buildMatchExpression(s.query, s.searchIn),
          dir,
          lim,
          off: off0,
          cursor,
          sizeCond,
          tokens,
        });
        if (wholeSet) {
          const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
          if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
          return { total, limit: 'all', offset: 0, items, truncated };
        }
        return { total, limit: effLimit, offset: effOffset, items, nextCursor: nextOf(items, null, lim) };
      } catch {
        // TEMP 表不可用（个别驱动的只读连接限制等）：落回通用 JOIN 路径
      }
    }

    if (wholeSet) {
      // 一次性取到 CAP 上限，只排一次序（分批翻页会让带 bm25 的排序每轮重排一次匹配集）
      const items = attachPreviews(dbRO.all(buildPage(WHOLESET_CAP + 1, 0)), tokens);
      const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
      if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
      return { total, limit: 'all', offset: 0, items, truncated };
    }
    const items = total ? attachPreviews(dbRO.all(buildPage(effLimit, off0)), tokens) : [];
    // 通用路径（hash 模式 / relevance 排序 / 小集 + size）不支持 keyset，游标恒为 null
    return { total, limit: effLimit, offset: effOffset, items, nextCursor: null };
  };

  /**
   * 「最新入库」列表：不经 FTS、无任何条件，固定按 id 倒序取一段。
   * 没有关键词与 MATCH，故不存在 JOIN 剔除残留行的机制（total 会略偏大）。
   *
   * @param {object} [options] 见 normalizeLatestQuery（只有 limit / offset）
   * @returns {{ total: number, limit: number, offset: number, items: Array }}
   */
  const listLatestSync = (options) => {
    const { limit, offset } = normalizeLatestQuery(options);
    // total 优先用调用方传入值：主进程已有事件驱动的全表总数，省掉子进程每次重新
    // count(*)（O(n)，需扫描最小索引）。子进程被单独调用（测试等）时缺失该值，回退自算。
    const total = Number.isFinite(options?.total)
      ? Number(options.total)
      : Number(dbRO.all(sql`SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)}`)[0]?.total ?? 0);
    const items = attachPreviews(
      dbRO.all(sql`
      SELECT ${sql.raw(DOCS_LIST_SELECT)} FROM ${sql.raw(DOCS_TABLE)} m
      ORDER BY m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `)
    );
    return { total, limit, offset, items };
  };

  /**
   * 取某条 magnet 的完整文件树（扁平树：parent 指向父节点下标，根为 -1）。
   * 列表接口只下发 fileCount + 预览，整棵树在此按需从冷库点查并解压构建。
   *
   * @param {number} id magnet 主键
   * @returns {{ id: number, nodes: Array } | null} 该 id 在冷库中不存在时返回 null
   */
  const getMagnetFilesSync = (id) => {
    const row = filesRO
      ? filesRO.all(sql`SELECT fmt, files FROM ${sql.raw(FILES_TABLE)} WHERE id = ${id}`)[0]
      : null;
    const text = row ? decodeFiles(Number(row.fmt), row.files) : readLegacyFiles(id);
    if (text === null) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // 源数据本身不是合法 JSON：返回空树，前端显示「无文件列表」
    }
    return { id, nodes: buildFlatTree(parsed) };
  };

  /**
   * 冷库未命中时的兜底：读旧格式副本表里的 files 列原文。
   *
   * 只在格式迁移重建期间有意义：那时线上仍用旧副本表服务，而冷库还是空的。
   * 当前副本表没有 files 列，查询会抛错并被吞掉，回到「该 id 不存在」的正常语义。
   */
  const readLegacyFiles = (id) => {
    try {
      const row = dbRO.all(sql`SELECT files FROM ${sql.raw(DOCS_TABLE)} WHERE id = ${id}`)[0];
      return row ? String(row.files ?? '') : null;
    } catch {
      return null; // 副本表已无 files 列：本兜底自然失效
    }
  };

  return { searchMagnetsSync, listLatestSync, getMagnetFilesSync };
};
