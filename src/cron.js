/**
 * cron 表达式（标准 5 段：分 时 日 月 周）解析与「下次触发时刻」推算
 * ------------------------------------------------------------------
 * 为什么需要它：node-cron 只负责「到点执行」，不回答「下次什么时候执行」——
 * v3 的 ScheduledTask 只暴露 start/stop/now()，而 now() 是**立即执行一次**，
 * 不是查询接口。设置面板的「下次同步」本质上是 cron 节拍的只读翻译，服务端
 * 又只推时间戳（相对时间交给前端本地逐秒渲染），于是必须能独立推算下一次。
 *
 * 职责边界：本模块只做**翻译**（解析表达式 + 推算时刻），不注册任何定时器；
 * 真正的执行仍由 index.js 里的 node-cron 负责，两侧共用同一份 SYNC_CRON。
 * 纯函数、零依赖，可独立单测（见 test/cron.mjs）。
 *
 * 支持语法：星号  单值  范围(a-b)  步长(a-b/n、星号/n、a/n)  列表(a,b,c)
 * 以及月份 / 星期的英文缩写（JAN / MON），周日可用 0 或 7。
 * 按**本地时区**推算，与 node-cron（未指定 tz 时同样按本地时间）保持一致。
 *
 * 两处刻意**跟随 node-cron v3 而非标准 cron**（面板显示的是真正会执行的时刻，
 * 若按教科书语义推算，倒计时会指向一个实际不触发的时间点）：
 *   1. 日 / 周用 AND（两字段都命中才触发），而非 Vixie cron 的 OR；
 *   2. 步长取「段内能被 step 整除的值」，而非「自段起点累加 step」——
 *      故「星号/2」在日字段是 2,4,…,30（不是 1,3,…,31），「1-10/2」是 2,4,6,8,10。
 * 常见写法（固定时刻、分 / 时的「星号/n」、列表、范围）两种语义结果一致，不受影响。
 * 升级 node-cron 大版本时，这两点需重新核对（见 test/cron.mjs 的交叉验证注释）。
 */

/** 月份 / 星期英文缩写 → 数值（cron 惯例，大小写不敏感） */
const MONTH_ALIASES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_ALIASES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** 五个字段的取值域，顺序即 cron 的段序 */
const FIELDS = [
  { min: 0, max: 59, aliases: null },          // 分
  { min: 0, max: 23, aliases: null },          // 时
  { min: 1, max: 31, aliases: null },          // 日
  { min: 1, max: 12, aliases: MONTH_ALIASES }, // 月
  { min: 0, max: 6, aliases: DOW_ALIASES },    // 周（0 = 周日）
];

/**
 * 解析单段里的一个取值：数字或英文缩写。
 * @returns {number|null} 非法返回 null
 */
function toValue(raw, aliases) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    // 周日兼容：cron 里 0 与 7 等价
    return aliases === DOW_ALIASES && n === 7 ? 0 : n;
  }
  return aliases && t in aliases ? aliases[t] : null;
}

/**
 * 解析单段（如「星号/5」步长、"1,15" 列表、"mon-fri" 范围）为取值集合。
 * @returns {Set<number>|null} 该段非法时返回 null
 */
function parseField(text, field) {
  const out = new Set();
  for (const term of String(text).split(',')) {
    const [rangeRaw, stepRaw] = term.trim().split('/');
    let step = 1;
    if (stepRaw !== undefined) {
      const s = stepRaw.trim();
      if (!/^\d+$/.test(s) || Number(s) < 1) return null;
      step = Number(s);
    }
    const range = String(rangeRaw ?? '').trim().toLowerCase();
    let lo;
    let hi;
    if (range === '*' || range === '?') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const parts = range.split('-');
      if (parts.length !== 2) return null;
      lo = toValue(parts[0], field.aliases);
      hi = toValue(parts[1], field.aliases);
      if (lo == null || hi == null) return null;
    } else {
      lo = toValue(range, field.aliases);
      if (lo == null) return null;
      hi = lo; // 单值只命中自己；'5/20' 这类写法 node-cron 的 validate 会直接拒绝
    }
    if (lo < field.min || hi > field.max || lo > hi) return null;
    // 步长：取段内能被 step 整除的值（与 node-cron v3 一致，见文件头）
    for (let v = lo; v <= hi; v += 1) {
      if (step === 1 || v % step === 0) out.add(v);
    }
  }
  return out.size > 0 ? out : null;
}

/**
 * 解析完整表达式。
 * @param {unknown} expr
 * @returns {{
 *   minutes: Set<number>, hours: Set<number>, doms: Set<number>,
 *   months: Set<number>, dows: Set<number>,
 * }|null} 非法 / 非标准 5 段返回 null
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return null;
  const seg = expr.trim().split(/\s+/);
  if (seg.length !== 5) return null; // 只支持标准 5 段；带秒的 6 段无法推算
  const sets = [];
  for (let i = 0; i < FIELDS.length; i += 1) {
    const s = parseField(seg[i], FIELDS[i]);
    if (!s) return null;
    sets.push(s);
  }
  const [minutes, hours, doms, months, dows] = sets;
  return { minutes, hours, doms, months, dows };
}

/**
 * 求表达式在 from 之后的**下一次**触发时刻（严格晚于 from，按整分钟对齐）。
 * @param {unknown} expr cron 表达式
 * @param {Date|number} [from] 起点，默认当前时刻
 * @returns {Date|null} 无解（表达式非法，或 2 月 30 日这类永不命中）返回 null
 */
export function nextCronTime(expr, from = new Date()) {
  const spec = parseCron(expr);
  const base = from instanceof Date ? from : new Date(from);
  if (!spec || Number.isNaN(base.getTime())) return null;

  const d = new Date(base.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // cron 最小粒度是分钟：从起点的下一分钟找起

  // 上限 4 年（足够覆盖 2 月 29 日这类最长周期），越界按无解处理，杜绝死循环。
  // 实际循环次数远小于它：不匹配的月份 / 日 / 时都会被整段跳过，而非逐分钟推进。
  const LIMIT = 4 * 366 * 24 * 60;
  for (let i = 0; i < LIMIT; i += 1) {
    if (!spec.months.has(d.getMonth() + 1)) {
      // 跳到下月 1 号 00:00：先置 1 号再跳月，否则 1/31 + 1 月会溢出到 3 月
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      d.setMonth(d.getMonth() + 1);
      continue;
    }
    // 日 / 周按 AND 匹配（与 node-cron v3 一致，见文件头说明）
    const dayOk = spec.doms.has(d.getDate()) && spec.dows.has(d.getDay());
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(d.getHours())) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    if (!spec.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d;
  }
  return null;
}
