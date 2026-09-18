/**
 * 共享纯函数与轻量助手。
 * ------------------------------------------------------------------
 * 只放「与框架无关」的逻辑：格式化、查询解析、联想匹配、剪贴板、下载、RPC 推送。
 * 所有渲染/事件都交给 Alpine 模板，这里不产生任何 DOM 结构（下载与复制属浏览器 API 例外）。
 */
import { showToast } from './toast.js';

/* ---------- 数据规范化与格式化 ---------- */

/** 把字节数格式化为带单位的可读字符串 */
export const formatBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const pad2 = (x) => String(x).padStart(2, '0');

/** 把时间戳格式化为 YYYY-MM-DD HH:mm */
export const formatDate = (ts) => {
  if (!Number.isFinite(Number(ts))) return '-';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 把毫秒差格式化为 mm:ss / h:mm:ss（用于同步倒计时） */
export const formatCountdown = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
    : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
};

const numberFmt = new Intl.NumberFormat('zh-CN');

/** 千分位整数 */
export const formatCount = (n) => numberFmt.format(Number(n) || 0);

/* ---------- 查询解析 ---------- */

/** 从查询串提取高亮 token（与后端 buildMatchExpression 保持一致：字母数字、小写、去重） */
export const extractTokens = (q) => {
  const m = String(q).match(/[\p{L}\p{N}]+/gu);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
};

/** 判断输入是否为 infohash：连续 40 位十六进制，或带 urn:btih: / hash 前缀 */
export const isInfohash = (q) => {
  const s = String(q).trim().toLowerCase();
  if (s.includes('urn:btih:')) return /^.*urn:btih:[a-f0-9]{40}$/.test(s);
  if (s.startsWith('hash')) return /^hash[a-f0-9]{40}$/.test(s);
  return /^[a-f0-9]{40}$/.test(s);
};

/* ---------- 输入联想（分词 + 权重累加） ---------- */

/**
 * 浏览器原生分词器。零依赖、零体积，且中文按词切分（不是逐字）：
 *   "高清影视之家发布" → ["高清","影视","之家","发布"]
 *   "movie 1080p"     → ["movie","1080p"]（ASCII 组合词不会被拆散）
 *   "同人cg集"        → ["同人","cg","集"]
 */
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
  : null;

/** 无 Intl.Segmenter 时的降级规则：ASCII 连成串，CJK 逐字 */
const FALLBACK_TOKEN = /[A-Za-z0-9]+|[\p{Script=Han}]/gu;

/**
 * 把输入切成匹配用的 token 数组（已小写折叠，与词表存储形态一致）。
 * @param {string} input
 * @returns {string[]}
 */
export const tokenize = (input) => {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return [];
  if (!segmenter) return s.match(FALLBACK_TOKEN) ?? [];
  const out = [];
  for (const seg of segmenter.segment(s)) {
    if (seg.isWordLike) out.push(seg.segment);
  }
  return out.length ? out : (s.match(FALLBACK_TOKEN) ?? []);
};

/** Levenshtein 编辑距离 */
const editDistance = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
};

/** term 是否与 query 模糊相似：编辑距离阈值随长度放宽 */
const isFuzzyMatch = (term, query) => {
  if (Math.abs(term.length - query.length) > 2) return false;
  const d = editDistance(term, query);
  return d <= 1 || (query.length >= 4 && d <= 2);
};

/** 匹配类型权重：完全相等 > 前缀 > 包含 > 模糊 */
const W_EXACT = 100;
const W_PREFIX = 60;
const W_INCLUDE = 30;
const W_FUZZY = 8;

/**
 * 拼音匹配权重。
 *
 * 层级刻意嵌进原文匹配的档位之间，而不是整体压在最下面：
 *   原文精确 100 > 拼音精确 90 > 原文前缀 60 = 拼音首字母 60
 *   > 拼音全拼 45 > 原文包含 30 > 拼音包含 22 > 原文模糊 8
 *
 * 关键在首字母取 60（与「原文前缀」同级）。实测取 14 / 38 时，输入 dy 会有几十条
 * 「词面以 dy 开头」的英文词（dygang / dynasty / dytt89 …）加上几百条「词面含 dy」的
 * 词（阳光电影dygod）把「电影」「第一会所」这类首字母命中挤出前 12 名（中文占比 0/12）。
 * 取 60 让两者同分，改由词表热度序决定先后，中文词因此能进入可见范围
 * （实测 dy 的 top12 中文占比 0/12 → 6/12）；再取更高就会喧宾夺主，
 * 让拼音命中压过词面直接命中。
 *
 * 首字母只做前缀、不做包含：包含太宽松（任何同时含 d 和 y 的词都会被 dy 命中）。
 */
const W_PY_EXACT = 90;
const W_PY_PREFIX = 45;
const W_PY_INCLUDE = 22;
const W_PY_INITIAL = 60;

/** 拼音匹配的最短 token：单字符命中面太广（d 会命中所有 d 开头的词），无实用价值 */
const PY_MIN_TOKEN = 2;

/**
 * 模糊（编辑距离）只对最热的这些词做。
 * 编辑距离是 O(n·m) 的 DP，对整份 3 万词表逐条算要几十毫秒、且每次按键都要付一遍；
 * 而冷门词的拼写容错几乎没有价值，故只在头部区间启用。
 */
const FUZZY_SCAN_MAX = 3000;

/** 单个 token 对一个词的匹配权重（0 = 不匹配） */
const tokenScore = (term, token, allowFuzzy) => {
  if (term === token) return W_EXACT;
  if (term.startsWith(token)) return W_PREFIX;
  if (term.includes(token)) return W_INCLUDE;
  return allowFuzzy && isFuzzyMatch(term, token) ? W_FUZZY : 0;
};

/**
 * 单个 token 对一条拼音记录的匹配权重（0 = 不匹配）。
 * @param {{ full: string, initials: string }} rec 拼音索引条目
 * @param {string} token 已小写折叠的输入 token
 */
const pyTokenScore = (rec, token) => {
  if (rec.full === token) return W_PY_EXACT;
  if (rec.full.startsWith(token)) return W_PY_PREFIX;
  // 「女」的 ü 在索引里写作 v，但用户也可能按 ü 本音输 u（nushen）：
  // 索引侧含 v 时补一条 v→u 的容错，避免两套写法互相搜不到
  if (rec.full.includes('v') && rec.full.replace(/v/g, 'u').startsWith(token)) return W_PY_PREFIX;
  if (rec.initials.startsWith(token)) return W_PY_INITIAL;
  if (rec.full.includes(token)) return W_PY_INCLUDE;
  return 0;
};

/**
 * 从词表里匹配联想候选。
 *
 * 两段式：先把输入切成多个 token，再让**每个 token 独立匹配整份词表**，同一条词被
 * 多个 token 命中时把权重**相加**。于是「同时命中更多关键词」的词自然排到前面，
 * 而不再依赖固定分组的优先级硬拼。
 *
 * 词表本身已按热度降序，故同分时用原始下标兜底 —— 权重相同则更热的在前。
 * 正因顺序即排名，服务端不必下发 doc_count，省掉两个整数字段。
 *
 * 传入 pyIndex 时额外跑一轮拼音匹配：索引只含含汉字的词（约为词表的 1/20，
 * 见 pinyin.js），两轮命中同一条词时权重继续累加 —— 词面与读音都命中是更强的信号。
 *
 * @param {string[]} words 按热度降序的词表
 * @param {string} query 用户输入
 * @param {number} [max=12] 返回条数
 * @param {Array<{term: string, full: string, initials: string, i: number}>|null} [pyIndex]
 *        拼音索引；null / 空数组表示本次不做拼音匹配（功能未开启或索引未就绪）
 * @returns {string[]} 命中的词（按「权重降序 → 热度降序」）
 */
export const matchSuggestions = (words, query, max = 12, pyIndex = null) => {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // term -> { term, score, i }：两轮命中同一条词时累加权重，顺带避免结果里出现重复词
  const acc = new Map();
  const add = (term, score, i) => {
    const key = String(term);
    const prev = acc.get(key);
    if (prev) prev.score += score;
    else acc.set(key, { term, score, i });
  };

  /* 轮 1：词面匹配（遍历整份词表） */
  for (let i = 0; i < words.length; i += 1) {
    const term = String(words[i]).toLowerCase();
    const allowFuzzy = i < FUZZY_SCAN_MAX;
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(term, token, allowFuzzy);
      // 乘 token 长度：越长的 token 越有区分度（单字「中」不该与 movie 同权）
      if (s > 0) score += s * token.length;
    }
    if (score > 0) add(words[i], score, i);
  }

  /* 轮 2：拼音匹配（只遍历索引，规模远小于词表） */
  if (pyIndex && pyIndex.length) {
    const pyTokens = tokens.filter((t) => t.length >= PY_MIN_TOKEN);
    if (pyTokens.length) {
      for (const rec of pyIndex) {
        let score = 0;
        for (const token of pyTokens) {
          const s = pyTokenScore(rec, token);
          if (s > 0) score += s * token.length;
        }
        if (score > 0) add(rec.term, score, rec.i);
      }
    }
  }

  // i 即热度序：同分时保留词表原本的顺序
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.term);
};

/* ---------- 高亮（输出可直接 x-html 的安全字符串） ---------- */

/** 转义正则元字符，避免 token 破坏构造出的正则 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** HTML 转义：x-html 绑定的所有文本都必须先过这里（仅本模块内部使用） */
const escapeHtml = (text) => {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/**
 * 把 text 中命中 tokens 的片段用 <mark> 高亮，返回转义后的安全 HTML。
 * tokens 为空时退化为纯转义文本。
 */
export const highlightHtml = (text, tokens) => {
  const s = String(text ?? '');
  if (!tokens || tokens.length === 0) return escapeHtml(s);
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // 防止零宽匹配死循环
    out += escapeHtml(s.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
};

/* ---------- 浏览器能力：复制 / 下载 / 迅雷链接 ---------- */

/** 复制文本到剪贴板（带 execCommand 降级）。两条路都失败时抛错，交由调用方提示失败。 */
export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 非安全上下文（http 且非 localhost）没有 clipboard API，落到下面的降级实现 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('复制失败');
};

/** 触发浏览器下载一个文本文件 */
export const downloadText = (filename, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/** 把 magnet 链接编码成迅雷 thunder:// 协议链接 */
export const toThunder = (magnet) => {
  if (!magnet) return '';
  const raw = 'AA' + magnet + 'ZZ';
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
  return 'thunder://' + b64;
};

/* ---------- RPC 推送（aria2 / Motrix JSON-RPC 2.0） ---------- */

const RPC_URL_KEY = 'dht_rpc_url';
const RPC_SECRET_KEY = 'dht_rpc_secret';
const DEFAULT_RPC_URL = 'http://localhost:16800/jsonrpc';

/** 读取 RPC 推送配置（地址默认 localhost:16800，密钥默认空） */
export const getRpcConfig = () => {
  return {
    url: (localStorage.getItem(RPC_URL_KEY) || DEFAULT_RPC_URL).trim(),
    secret: (localStorage.getItem(RPC_SECRET_KEY) || '').trim(),
  };
};

/** 保存 RPC 推送配置到 localStorage（空值则清除对应键，回退默认） */
export const saveRpcConfig = ({ url, secret } = {}) => {
  if (url && url.trim()) localStorage.setItem(RPC_URL_KEY, url.trim());
  else localStorage.removeItem(RPC_URL_KEY);
  if (secret) localStorage.setItem(RPC_SECRET_KEY, secret);
  else localStorage.removeItem(RPC_SECRET_KEY);
};

/**
 * 把磁力链接推送到 aria2 / Motrix 下载器（JSON-RPC 2.0 的 aria2.addUri）。
 * 设了密钥时按 aria2 约定在 params 头部加 `token:<secret>`；结果用 toast 反馈。
 */
export const pushToAria2 = async (magnet) => {
  if (!magnet) {
    showToast('没有可推送的磁力链接');
    return;
  }
  const { url, secret } = getRpcConfig();
  const params = [[magnet]];
  if (secret) params.unshift(`token:${secret}`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'aria2.addUri', params }),
    });
    const data = await resp.json();
    if (data.error) showToast(`推送失败：${data.error.message}`);
    else showToast(`已推送到下载器，GID: ${data.result}`);
  } catch (err) {
    showToast(`推送出错：${err.message}`);
  }
};
