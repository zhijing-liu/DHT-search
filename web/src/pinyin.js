/**
 * 拼音联想（可选能力，两档都懒加载，默认一个都不加载）
 * ------------------------------------------------------------------
 * 分两档，都只在用户于设置面板主动开启后才下载；不开启时前端产物与改动前
 * 完全一致，且本模块不会产生任何网络请求。
 *
 *   标准档  import('pinyin-pro')                    约 140 KB (gzip)
 *   精确档  + import('@pinyin-pro/data/modern')      约 +605 KB (gzip)
 *
 * 精确档是往 pinyin-pro 里注入一份更完整的现代汉语词典（`addDict`），
 * 提升多音字与词组的判定准确率。注意 `addDict` 是**全局且不可撤销**的副作用
 * （与 navigation 项目的处理一致）：一旦注入，本次会话内即使再把开关关掉，
 * 已生效的字典也不会退回基础版——开关只在「是否注入」这一步起作用。
 * 用户想要真正退回基础档，刷新页面且保持关闭即可。
 *
 * 为词表建索引时**只收含汉字的词**：实测 3 万条热词里仅约 1400 条含汉字，
 * 纯 ASCII / 数字词交给原文匹配即可。索引规模因此比词表小一个量级，
 * 每次按键的额外开销可以忽略。
 *
 * 为什么用现成库而不是自建字表：词表里混着大量繁体与日文汉字
 * （訳 / 艦 / 総 / これ …），自建字表要追着补 Big5 / JIS 字符集，还得维护
 * 多音字修正表，省下的下载量不足以抵消这套字表生命周期管理。
 */

/** 设置项：是否开启拼音联想 */
const KEY_MATCH = 'dht_pinyin_match';
/** 设置项：是否加载精确词典（仅在拼音联想开启时有意义） */
const KEY_PRECISE = 'dht_pinyin_precise';

/** 是否含汉字（含扩展 A 与兼容区，覆盖词表里的繁体、日文汉字） */
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * ü 归一化为 v。
 * pinyin-pro 对「女」输出 `nü`，而用户习惯用 v 代替 ü（输 nv 而非 nü）；
 * 索引侧统一成 v，匹配侧再补一条 u 的容错路径（见 util.js 的 pyTokenScore）。
 */
const normalize = (s) => s.replace(/ü/g, 'v');

let basePromise = null;
let precisePromise = null;

/**
 * 加载 pinyin-pro 模块（ESM 缓存保证只真正下载/求值一次）。
 * 失败时清空缓存，允许用户重试。
 */
function loadBase() {
  if (!basePromise) {
    basePromise = import('pinyin-pro');
    basePromise.catch(() => {
      basePromise = null;
    });
  }
  return basePromise;
}

/**
 * 取得转换引擎。precise=true 时先注入现代汉语词典再返回。
 * addDict 全局生效且不撤销，故 precise 不必每次重复注入（precisePromise 只建一次）。
 *
 * @param {boolean} precise
 * @returns {Promise<{ full: (s: string) => string, initials: (s: string) => string }>}
 */
async function getEngine(precise) {
  const mod = await loadBase();
  if (precise) {
    if (!precisePromise) {
      precisePromise = import('@pinyin-pro/data/modern')
        .then(({ default: dict }) => mod.addDict(dict))
        .catch((err) => {
          precisePromise = null; // 允许重试
          throw err;
        });
    }
    await precisePromise;
  }
  // nonZh: 'consecutive' —— 让「1080P」原样成串，而不是被拆成 1/0/8/0/P
  const opts = { toneType: 'none', type: 'array', nonZh: 'consecutive' };
  return {
    full: (s) => normalize(mod.pinyin(s, opts).join('').toLowerCase()),
    initials: (s) => normalize(mod.pinyin(s, { ...opts, pattern: 'first' }).join('').toLowerCase()),
  };
}

/* ---------------------------------------------------------------- */
/* 设置项读写                                                        */
/* ---------------------------------------------------------------- */

/** 是否开启拼音联想 */
export const isPinyinEnabled = () => localStorage.getItem(KEY_MATCH) === '1';

/** 是否加载精确词典 */
export const isPreciseEnabled = () => localStorage.getItem(KEY_PRECISE) === '1';

/** 持久化「拼音联想」开关 */
export const setPinyinEnabled = (on) => {
  if (on) localStorage.setItem(KEY_MATCH, '1');
  else localStorage.removeItem(KEY_MATCH);
};

/** 持久化「精确词典」开关 */
export const setPreciseEnabled = (on) => {
  if (on) localStorage.setItem(KEY_PRECISE, '1');
  else localStorage.removeItem(KEY_PRECISE);
};

/* ---------------------------------------------------------------- */
/* 索引构建                                                          */
/* ---------------------------------------------------------------- */

/**
 * 为词表构建拼音索引。首次调用会触发对应档位词库的下载与解析。
 *
 * @param {string[]} words 按热度降序的词表
 * @param {{ precise?: boolean }} [opts] precise=true 时使用精确词典（需先下载）
 * @returns {Promise<Array<{ term: string, full: string, initials: string, i: number }>>}
 *   term=原词（用于回显），full=全拼，initials=首字母，i=热度序（同分排序用）
 */
export async function buildPinyinIndex(words, { precise = false } = {}) {
  const engine = await getEngine(precise);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const term = String(words[i]);
    if (!HAN_RE.test(term)) continue; // 纯 ASCII / 数字词：原文匹配已覆盖，不进索引
    const lower = term.toLowerCase();
    out.push({
      term,
      full: engine.full(lower),
      initials: engine.initials(lower),
      i,
    });
  }
  return out;
}
