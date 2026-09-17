/**
 * 检索输入契约：参数归一化 + FTS5 MATCH 表达式 + SQL 白名单常量
 * ------------------------------------------------------------------
 * 把任意外部输入收敛为可直接拼进 SQL 的安全值：
 *   - normalizeSearchQuery / normalizeLatestQuery：HTTP 层与数据层共用的归一化入口（幂等）
 *   - buildMatchExpression：把用户输入白名单化为 FTS5 MATCH 表达式
 *   - orderSqlFor：排序白名单常量（列名无法参数化，故写死）
 * 取列清单由 store.js 的副本表列定义派生，不在这里。
 */
import { clampInt, TOKEN_PATTERN } from '../util.js';
import { FTS_TABLE, DEFAULT_LIMIT, MAX_LIMIT, SORT_COLUMNS } from '../store.js';

/**
 * 排序 SQL 白名单（列名与方向无法参数化，故写死）。未传 sortBy 时回退为 id 排序；
 * 都带次排序键 id 保证分页稳定。relevance 用 bm25(fts)，值越小越相关，故 desc 取 ASC。
 */
const ORDER_SQL = Object.freeze({
  'id:asc': `ORDER BY m.id ASC`,
  'id:desc': `ORDER BY m.id DESC`,
  'fetchedAt:asc': 'ORDER BY m.fetchedAt ASC, m.id ASC',
  'fetchedAt:desc': 'ORDER BY m.fetchedAt DESC, m.id DESC',
  'totalSize:asc': 'ORDER BY m.totalSize ASC, m.id ASC',
  'totalSize:desc': 'ORDER BY m.totalSize DESC, m.id DESC',
  'relevance:asc': `ORDER BY bm25(${FTS_TABLE}) DESC, m.id ASC`,
  'relevance:desc': `ORDER BY bm25(${FTS_TABLE}) ASC, m.id ASC`,
});


/** 「最新入库」默认每批条数 */
const DEFAULT_LATEST_LIMIT = 30;

/**
 * 把用户输入清洗为安全的 FTS5 MATCH 表达式：只保留字母数字 token，双引号包裹，
 * AND 连接，末位 token 追加 '*' 实现前缀匹配（原始输入直接拼入会抛 fts5: syntax error）。
 *
 * @param {unknown} input 用户输入的搜索串
 * @param {string} [field] 限定检索字段：'name' 只搜 name 列；不传/其它值搜全部列（name+files）
 * @returns {string|null} 清洗后的 MATCH 表达式；无有效 token 时返回 null
 */
export function buildMatchExpression(input, field) {
  if (input === null || input === undefined) return null;
  const tokens = String(input).match(TOKEN_PATTERN);
  if (!tokens || tokens.length === 0) return null;

  const inner = tokens
    .map((token, index) => {
      const isLast = index === tokens.length - 1;
      // unicode61 会做大小写折叠，这里统一转小写保证确定性
      return `"${token.toLowerCase()}"${isLast ? '*' : ''}`;
    })
    .join(' AND ');
  // 只搜 name 列：用列过滤语法 `name:(...)` 把整段表达式限定到该列（FTS5 虚表列名即 name/files）
  return field === 'name' ? `name:(${inner})` : inner;
}

/**
 * 归一化 limit。
 * - 'all' / 数字 -1 → -1，表示整集拉取（受 WHOLESET_CAP 截断）。
 *   数字 -1 是内部标记，必须原样返回以保证本函数幂等；字符串 '-1' 按用户输入处理。
 * - 缺省 / null / 非数值 / <= 0 → DEFAULT_LIMIT
 * - 其余 → 钳制到 [1, MAX_LIMIT]
 */
function toLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  // -1 是「整集拉取」的内部标记（由本函数或 'all' 产生），必须原样保留：
  // normalizeSearchQuery 是幂等的、各层会重复调用它，若把 -1 当成「负数 → 分页」，
  // 则 HTTP 层归一化出的 -1 传到搜索子进程再归一化一次就会静默退化成分页。
  if (value === -1) return -1;
  const text = String(value).trim().toLowerCase();
  if (text === 'all') return -1;
  const num = Number(text);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_LIMIT;
  return clampInt(num, DEFAULT_LIMIT, 1, MAX_LIMIT);
}

/** 归一化大小筛选（字节）：非有限值或负数一律视为「不限制」 */
function toSize(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

/** 由已校验的 sortBy / order 取白名单内的 ORDER BY 片段 */
export function orderSqlFor({ sortBy, order }) {
  return ORDER_SQL[sortBy ? `${sortBy}:${order}` : `id:${order}`];
}

/**
 * 检索参数归一化——HTTP 层与数据层共用的唯一入口（幂等）：把任意来源的原始输入
 * 收敛为已校验 / 已钳制的规范对象，可直接用于缓存键、子进程派参与 SQL 拼装。
 *
 * @param {object} [raw] 原始检索参数
 * @returns {{ query: string, sortBy: string|undefined, order: 'asc'|'desc',
 *             by: 'hash'|'fts', searchIn: string|undefined,
 *             minSize: number|undefined, maxSize: number|undefined,
 *             limit: number, offset: number, cursor: string|undefined }}
 *   limit 为 -1 表示整集拉取；cursor 为 keyset 深翻页游标（opaque token，原样回传）；
 *   searchIn 为 'name' 时只搜 name 列，其它/缺省搜全部列（name+files）
 */
export function normalizeSearchQuery(raw = {}) {
  const source = raw ?? {};
  // HTTP 查询串的值可能是数组（?q=a&q=b），取首个而不是静默丢弃为空串
  const rawQuery = Array.isArray(source.query) ? source.query[0] : source.query;
  return {
    query: typeof rawQuery === 'string' ? rawQuery.trim() : '',
    sortBy: SORT_COLUMNS.includes(source.sortBy) ? source.sortBy : undefined,
    order: String(source.order).toLowerCase() === 'asc' ? 'asc' : 'desc',
    by: source.by === 'hash' ? 'hash' : 'fts',
    // 搜索范围：仅 'name' 为"只搜种子名"；其余（含缺省）搜 name+files（文件名/路径）
    searchIn: source.searchIn === 'name' ? 'name' : undefined,
    minSize: toSize(source.minSize),
    maxSize: toSize(source.maxSize),
    limit: toLimit(source.limit),
    offset: clampInt(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    // 游标是 opaque token（base64url(JSON {v,i})），只透传给检索层解码；长度钳制防滥用
    cursor:
      typeof source.cursor === 'string' && source.cursor.length > 0 && source.cursor.length <= 256
        ? source.cursor
        : undefined,
  };
}

/**
 * 「最新入库」参数归一化——只有分页（列表固定按 id 倒序，不支持关键词 / 排序 / 过滤，
 * 也不支持整集拉取）。
 * @param {object} [raw] 原始参数（Express 的 req.query 或子进程转发对象）
 * @returns {{ limit: number, offset: number }}
 */
export function normalizeLatestQuery(raw = {}) {
  const source = raw ?? {};
  const n = Number(source.limit);
  return {
    // 不支持「整集拉取」：本列表是浏览式的，一次最多 MAX_LIMIT 条，靠 offset 翻页
    limit: Number.isFinite(n) && n > 0 ? clampInt(n, DEFAULT_LATEST_LIMIT, 1, MAX_LIMIT) : DEFAULT_LATEST_LIMIT,
    offset: clampInt(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
