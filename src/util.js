/**
 * 后端共享纯函数（无运行时依赖，可被任意模块安全 import）
 * ------------------------------------------------------------------
 * 把原本散落在 db.js / searchPool.js 里的「数值钳制」与「热词归一化」两类
 * 纯工具收敛到此处，避免多处各写一份、行为漂移：
 *   - clampInt        全局唯一的整数钳制实现（原 db.js / searchPool.js 各一份）
 *   - normalizeKeyword 热词 / 过滤词归一化（HTTP 层与脚本共用）
 */

/**
 * 把任意值钳制为 [min, max] 区间内的整数。
 * 非有限数值（undefined / null / 非数字串）一律回退为 fallback；
 * 用 Math.floor 取整（与「负数 → 向下取整」的语义对齐），且所有调用点的
 * min 均为非负，故与 Math.trunc 在实际上等价。
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
 * 归一化热词 / 过滤词：去首尾空白 + 小写折叠。
 * 不含任何字母或数字时返回空串，调用方自行决定跳过还是报错。
 * @param {unknown} term
 * @returns {string} 归一化后的词；无效输入返回空串
 */
const KEYWORD_HAS_ALNUM = /[\p{L}\p{N}]/u;
export function normalizeKeyword(term) {
  const t = String(term ?? '').trim().toLowerCase();
  return KEYWORD_HAS_ALNUM.test(t) ? t : '';
}
