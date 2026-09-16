/**
 * 后端共享纯函数（无运行时依赖，可被任意模块安全 import）
 * ------------------------------------------------------------------
 *   - clampInt         整数钳制（全局唯一实现）
 *   - normalizeKeyword 热词 / 过滤词归一化（HTTP 层与脚本共用）
 *   - TOKEN_PATTERN    字母数字 token 提取规则（检索 MATCH 表达式与索引侧热词统计共用）
 */

/**
 * 只保留字母与数字的 token 提取正则。检索侧与索引侧共用同一份规则，
 * 使「能被搜到的词」与「被统计的词」保持一致。
 */
export const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * 把任意值钳制为 [min, max] 区间内的整数；非有限数值回退为 fallback。
 * @param {unknown} value
 * @param {number} fallback 非有限值时的回退值
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.floor(num), min), max);
}

/**
 * 归一化热词 / 过滤词：去首尾空白 + 小写折叠；不含字母或数字时返回空串。
 * @param {unknown} term
 * @returns {string} 归一化后的词；无效输入返回空串
 */
const KEYWORD_HAS_ALNUM = /[\p{L}\p{N}]/u;
export function normalizeKeyword(term) {
  const t = String(term ?? '').trim().toLowerCase();
  return KEYWORD_HAS_ALNUM.test(t) ? t : '';
}
