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
import { FTS_TABLE, DOCS_TABLE, DOCS_SELECT_COLUMNS } from '../store.js';
import { MAX_RESULTS } from '../settings.js';
import { TOKEN_PATTERN } from '../util.js';
import { buildFlatTree } from '../file-tree.js';
import {
  buildMatchExpression,
  normalizeSearchQuery,
  normalizeLatestQuery,
  orderSqlFor,
} from './query.js';

/** 预览条数上限：卡片只展示前几条文件（有关键词时优先展示命中的） */
const PREVIEW_LIMIT = 5;

/** 从检索词里提取「预览优先命中」用的 token（去重、小写；只做包含匹配，与 FTS 分词无关） */
function queryTokens(query) {
  if (!query) return [];
  const matched = String(query).toLowerCase().match(TOKEN_PATTERN);
  return matched ? [...new Set(matched)] : [];
}

/**
 * 选取预览条目 `[{ path, size }]`：有关键词时只保留路径命中者（命中越多越靠前），
 * 否则按原顺序取前 N 条。这是列表路径上唯一读 files 原文的地方；解析失败返回空数组。
 */
function buildPreview(rawFiles, tokens) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawFiles ?? ''));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
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
}

/**
 * 把数据库行加工为对外返回的行对象：丢掉 files 原文，换成 fileCount 与 preview。
 */
function mapRow(row, tokens = []) {
  const { files, ...rest } = row;
  return { ...rest, preview: buildPreview(files, tokens) };
}

/**
 * 检索逻辑工厂：接收「只读数据库连接（drizzle 包装）」，返回同步检索函数。
 *
 * @param {object} dbRO drizzle-orm 包装的只读连接，提供 .all() 执行 SELECT
 * @returns {{ searchMagnetsSync: Function, listLatestSync: Function, getMagnetFilesSync: Function }}
 */
export function buildSearchApi(dbRO) {
  /** 整集拉取安全上限（与 config.js 的 MAX_RESULTS 对齐，配置缺失则回退 20000） */
  const WHOLESET_CAP =
    Number.isFinite(Number(MAX_RESULTS)) && Number(MAX_RESULTS) > 0 ? Number(MAX_RESULTS) : 20000;

  /**
   * 构造大小筛选片段（值已由 normalizeSearchQuery 校验为「有限非负」或 undefined）。
   * 无条件时返回空片段，调用方无需再判空。
   */
  function buildSizeCond({ minSize, maxSize }) {
    const conds = [];
    if (minSize !== undefined) conds.push(sql`m.totalSize >= ${minSize}`);
    if (maxSize !== undefined) conds.push(sql`m.totalSize <= ${maxSize}`);
    // bun 下 drizzle 会把 sql.join 的字符串分隔符参数化成 `?`，故显式拼接而不用 join
    if (conds.length === 0) return sql``;
    if (conds.length === 1) return sql` AND ${conds[0]}`;
    return sql` AND ${conds[0]} AND ${conds[1]}`;
  }

  /** 归一化 infohash：剥离 magnet 链接里的 urn:btih: 前缀，并去除所有非字母数字字符 */
  function normalizeInfohash(query) {
    return String(query ?? '')
      .replace(/^.*urn:btih:/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  /** FTS5 模糊检索：JOIN FTS 表，顺带剔除源库中已删除的残留索引行（保证 total 与返回数一致） */
  function ftsWhere(query) {
    const match = buildMatchExpression(query);
    if (!match) {
      throw new TypeError('searchMagnets: options.query 不能为空，且需包含至少一个字母或数字');
    }
    // FTS5 MATCH 必须接收「SQL 字符串字面量」形式的查询表达式（单引号包裹），否则 SQLite 会把
    // 双引号短语误当标识符、或把参数化占位符 ? 在 prepare 阶段抛 fts5: near "?"。
    // match 已白名单化（仅字母数字 / 双引号 / AND / *），安全。
    return {
      join: sql`JOIN ${sql.raw(FTS_TABLE)} f ON m.id = f.rowid`,
      cond: sql`${sql.raw(FTS_TABLE)} MATCH ${sql.raw(`'${match}'`)}`,
    };
  }

  /** infohash 精确检索：无需 JOIN，直接匹配副本表，兼容「带/不带 hash 前缀」并支持前缀检索 */
  function hashWhere(query) {
    const raw = normalizeInfohash(query);
    if (!raw) {
      throw new TypeError('searchByHash: 未提供有效的 infohash');
    }
    return {
      join: sql``,
      cond: sql`lower(m.infohash) = lower(${raw})
        OR lower(m.infohash) = lower(${'hash' + raw})
        OR lower(m.infohash) LIKE lower(${raw + '%'})`,
    };
  }

  /**
   * 由归一化参数构造 count / 分页 SQL 工厂（两种检索模式的差异只有是否 JOIN FTS 表
   * 与匹配条件，其余拼装共用。count 与 page 各针对宽泛词做了优化，见下方各处注释）。
   */
  function prepareSearch(options) {
    const s = normalizeSearchQuery(options);
    const { join, cond } = s.by === 'hash' ? hashWhere(s.query) : ftsWhere(s.query);
    const fromWhere = sql`
      FROM ${sql.raw(DOCS_TABLE)} m ${join}
      WHERE ${cond}${buildSizeCond(s)}
    `;
    const hasSize = s.minSize !== undefined || s.maxSize !== undefined;
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
          return sql`
            SELECT ${sql.raw(DOCS_SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
            JOIN (SELECT rowid FROM ${sql.raw(FTS_TABLE)}
                  WHERE ${cond} ORDER BY rowid ${sql.raw(dir)}
                  LIMIT ${lim} OFFSET ${off}) f ON m.id = f.rowid
            ORDER BY m.id ${sql.raw(dir)}
          `;
        }
        return sql`
          SELECT ${sql.raw(DOCS_SELECT_COLUMNS)} ${fromWhere}
          ${sql.raw(orderSqlFor(s))}
          LIMIT ${lim} OFFSET ${off}
        `;
      },
      wholeSet: s.limit === -1,
      effLimit: s.limit,
      effOffset: s.offset,
      query: s.query, // 供调用方挑预览：mapRow 需要按关键词优先
      cond,
      s,
    };
  }

  /**
   * 同步检索：先 count 再取页（整集拉取则一次取到 CAP），一次性返回。
   * @param {object} options 见 normalizeSearchQuery
   * @returns {{ total: number, limit: number|'all', offset: number, items: Array, truncated?: boolean }}
   */
  function searchMagnetsSync(options) {
    const { buildCount, buildPage, wholeSet, effLimit, effOffset, query, cond, s } = prepareSearch(options);
    const total = Number(dbRO.all(buildCount())[0]?.total ?? 0);
    // 预览按关键词优先挑：token 只算一次，本页所有行复用
    const tokens = queryTokens(query);
    const toItem = (row) => mapRow(row, tokens);
    const hasSize = s.minSize !== undefined || s.maxSize !== undefined;

    // 副本表普通列排序（totalSize / fetchedAt）走「两步法」，规避 SQLite 在 SELECT 含 files 大列时
    // 改写执行计划、退化为「每候选行重跑一次完整 FTS 匹配」（宽泛词下整体数十秒）：
    //   第一步只 SELECT id —— 触发 SQLite 对 IN(SELECT rowid FROM fts WHERE MATCH) 建自动索引，
    //     沿排序列索引倒序扫描、O(1) 成员判定凑够 LIMIT 即停（实测 ~0.5s）；
    //   第二步用本页 id 主键回查整行（含 files 预览），20 行主键查找代价可忽略。
    // 仅 FTS + 无大小筛选时可用（大小筛选会先过滤匹配行，预取行再排序会偏少）。
    const plainColSort = s.by === 'fts' && !hasSize && (s.sortBy === 'totalSize' || s.sortBy === 'fetchedAt');
    if (total && plainColSort) {
      const dir = s.order === 'asc' ? 'ASC' : 'DESC';
      const col = s.sortBy;
      const lim = wholeSet ? WHOLESET_CAP + 1 : effLimit;
      const off = wholeSet ? 0 : effOffset;
      const ids = dbRO
        .all(sql`
          SELECT m.id FROM ${sql.raw(DOCS_TABLE)} m
          WHERE m.id IN (SELECT rowid FROM ${sql.raw(FTS_TABLE)} WHERE ${cond})
          ORDER BY m.${sql.raw(col)} ${sql.raw(dir)}, m.id ${sql.raw(dir)}
          LIMIT ${lim} OFFSET ${off}
        `)
        .map((r) => r.id);
      const items = ids.length
        ? dbRO
            .all(sql`SELECT ${sql.raw(DOCS_SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m WHERE m.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
            .map(toItem)
        : [];
      if (wholeSet) {
        const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
        if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
        return { total, limit: 'all', offset: 0, items, truncated };
      }
      return { total, limit: effLimit, offset: effOffset, items };
    }

    if (wholeSet) {
      // 一次性取到 CAP 上限，只排一次序（分批翻页会让带 bm25 的排序每轮重排一次匹配集）
      const items = dbRO.all(buildPage(WHOLESET_CAP + 1, 0)).map(toItem);
      const truncated = total > WHOLESET_CAP || items.length > WHOLESET_CAP;
      if (items.length > WHOLESET_CAP) items.length = WHOLESET_CAP;
      return { total, limit: 'all', offset: 0, items, truncated };
    }
    const items = total ? dbRO.all(buildPage(effLimit, effOffset)).map(toItem) : [];
    return { total, limit: effLimit, offset: effOffset, items };
  }

  /**
   * 「最新入库」列表：不经 FTS、无任何条件，固定按 id 倒序取一段。
   * 没有关键词与 MATCH，故不存在 JOIN 剔除残留行的机制（total 会略偏大）。
   *
   * @param {object} [options] 见 normalizeLatestQuery（只有 limit / offset）
   * @returns {{ total: number, limit: number, offset: number, items: Array }}
   */
  function listLatestSync(options) {
    const { limit, offset } = normalizeLatestQuery(options);
    const total = Number(
      dbRO.all(sql`SELECT count(*) AS total FROM ${sql.raw(DOCS_TABLE)}`)[0]?.total ?? 0
    );
    const items = dbRO.all(sql`
      SELECT ${sql.raw(DOCS_SELECT_COLUMNS)} FROM ${sql.raw(DOCS_TABLE)} m
      ORDER BY m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `).map((row) => mapRow(row));
    return { total, limit, offset, items };
  }

  /**
   * 取某条 magnet 的完整文件树（扁平树：parent 指向父节点下标，根为 -1）。
   * 列表接口只下发 fileCount + 预览，整棵树在此按需构建。
   *
   * @param {number} id magnet 主键
   * @returns {{ id: number, nodes: Array } | null} 该 id 不存在时返回 null
   */
  function getMagnetFilesSync(id) {
    const row = dbRO.all(sql`SELECT files FROM ${sql.raw(DOCS_TABLE)} WHERE id = ${id}`)[0];
    if (!row) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(row.files);
    } catch {
      parsed = null; // 源数据本身不是合法 JSON：返回空树，前端显示「无文件列表」
    }
    return { id, nodes: buildFlatTree(parsed) };
  }

  return { searchMagnetsSync, listLatestSync, getMagnetFilesSync };
}
