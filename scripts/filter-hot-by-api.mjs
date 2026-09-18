#!/usr/bin/env node
/**
 * 通过「热词接口」拉取当前热词榜，按规则自动判定「无搜索意义的宽泛词」，
 * 再批量写入热词黑名单（keyword_filter）入库。
 *
 * 判定维度：
 *   1) 文件格式 / 容器扩展名（mp4 / mkv / pdf / iso ...）
 *   2) 分辨率（1920x1080 / 1280x720 / 1080p / 4k / uhd ...）
 *   3) 编码 / 来源 / 压制标签（x264 / hevc / remux / webrip / hdr ...）
 *   4) 英语停用词（the / and / of ...）
 *   5) 语言 / 地区代码（fr / de / jp ...）
 *   6) 网址 / 路径噪声（www / http / com / torrent ...）
 *
 * 用法：node scripts/filter-hot-by-api.mjs [limit]
 * 默认 limit=1000（接口单页上限）。脚本会先打印分类明细，再入库。
 */
import { normalizeKeyword } from '../src/util.js';

const BASE = process.env.DHT_BASE_URL || 'http://127.0.0.1:3000/dht';
const LIMIT = Math.min(Math.max(Number(process.argv[2]) || 1000, 1), 1000);

/* ----------------------------- 规则集 ----------------------------- */

// 1) 文件格式 / 容器扩展名（无歧义，直接拉黑）
const FILE_FORMATS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
  'm2ts', 'mts', 'ogv', 'ogm', 'rmvb', 'vob', 'ts', 'mka', 'mks', 'mk3d',
  'mp3', 'flac', 'wav', 'aac', 'ac3', 'dts', 'ogg', 'oga', 'opus', 'wma',
  'm4a', 'ape', 'tak', 'tta', 'mp2',
  'pdf', 'epub', 'mobi', 'azw', 'azw3', 'azw4', 'txt', 'doc', 'docx', 'docm',
  'rtf', 'ppt', 'pptx', 'pps', 'xls', 'xlsx', 'xlsm', 'csv',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz4', 'zst', 'tgz', 'tbz',
  'iso', 'img', 'bin', 'cue', 'mds', 'mdf', 'nrg', 'cdi', 'ccd',
  'apk', 'exe', 'dmg', 'pkg', 'msi', 'deb', 'rpm', 'jar', 'whl', 'dll', 'sys', 'drv',
  'nfo', 'srt', 'sub', 'ass', 'idx', 'smi', 'ssa', 'usf', 'vtt',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp',
  'torrent', 'part',
  'blu', 'bluray',
]);

// 2) 分辨率（严格模式，避免误伤真实词）：
//    1920x1080 / 1280x720 / 3840x2160、1080p / 720p / 2160p / 1440p / 480p / 360p / 576p、
//    hd1080p / hd720p、fullhd / 2k / 4k / 8k / uhd / qhd / fhd / hd / sd
const RESOLUTION_RE = /^(\d{3,4}x\d{3,4}p?|\d{3,4}p|hd\d{3,4}p?|fullhd|2k|4k|8k|uhd|qhd|fhd|hd|sd)$/i;

// 3) 编码 / 来源 / 压制标签（release 质量标记，纯属宽泛噪声）
const CODEC_TAGS = new Set([
  'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'avc', 'vc1', 'vp9',
  '10bit', '8bit', '24bit', '16bit', '60fps', '120fps',
  'hdr', 'hdr10', 'hdr10plus', 'hdrplus', 'dolby', 'atmos', 'truehd',
  'dtshd', 'eac3', 'dd', 'ddp', 'ddp5', 'dd5', 'dd2',
  'remux', 'bdrip', 'webrip', 'webdl', 'web-dl', 'brrip', 'hdrip',
  'hdtv', 'hdtvrip', 'dvrip', 'dvdrip', 'dvdscr', 'cam', 'scr', 'r5',
  'telecine', 'repack', 'proper', 'dual', 'multi', 'dualaudio', '2audio',
  'subs', 'multisub', 'subbed', 'dubbed', 'raws',
  'chs', 'cht', 'eng', 'jpn', 'kor', 'chi', 'fre', 'ger', 'span', 'ita', 'rus',
]);

// 4) 英语停用词（看不出具体含义的功能词）；保留有检索价值的类别词
const CATEGORY_KEEP = new Set([
  'movie', 'movies', 'game', 'games', 'anime', 'manga', 'music', 'comic',
  'comics', 'novel', 'novels', 'book', 'books', 'film', 'films', 'tv',
  'show', 'shows', 'hentai', 'doujin', 'doujinshi', 'drama', 'dramas',
  'cartoon', 'cartoons', 'documentary', 'documentaries', 'album', 'albums',
  'serial', 'series', 'action', 'adult', 'adventure', 'comedy', 'horror',
  'romance', 'thriller', 'fantasy', 'scifi', 'genre', 'story', 'stories',
  'season', 'episode', 'episodes',
]);
const STOPWORDS = new Set([
  'the', 'and', 'of', 'to', 'in', 'by', 'with', 'for', 'from', 'is', 'it',
  'or', 'on', 'at', 'as', 'an', 'be', 'that', 'this', 'are', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'but', 'if',
  'then', 'than', 'so', 'not', 'no', 'nor', 'only', 'own', 'same', 'too',
  'very', 'just', 'dont', 'now', 'into', 'over', 'under', 'again', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'which', 'who', 'whom',
  'whose', 'what', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'out', 'up', 'down', 'off', 'about', 'above',
  'below', 'a', 'we', 'you', 'your', 'they', 'them', 'their', 'our', 'us',
]);

// 5) 语言 / 地区代码（torrent 名里高频无意义）
const LANG_CODES = new Set([
  'fr', 'es', 'it', 'pt', 'nl', 'de', 'ru', 'pl', 'jp', 'kr', 'cn', 'br',
  'mx', 'ca', 'au', 'se', 'no', 'dk', 'fi', 'tr', 'gr', 'ar', 'il', 'ir',
  'th', 'vn', 'id', 'my', 'ph', 'in', 'za', 'ng', 'ke', 'eg', 'sa', 'ae',
  'tw', 'hk', 'uk', 'us', 'ch',
]);

// 6) 网址 / 路径噪声
const WEB_NOISE = new Set([
  'www', 'http', 'https', 'httpd', 'ftp', 'ftps', 'magnet', 'btih', 'urn',
  'dn', 'tr', 'com', 'org', 'net', 'io', 'info', 'edu', 'gov', 'mil',
  'sample', 'trailer', 'screenshot', 'thumb', 'cover', 'folder', 'backup',
  'cache', 'temp',
]);

/** 判定分类；返回原因字符串或 null（保留） */
function classify(term) {
  const t = String(term).toLowerCase();
  if (FILE_FORMATS.has(t)) return '文件格式';
  if (RESOLUTION_RE.test(t)) return '分辨率';
  if (CODEC_TAGS.has(t)) return '编码/来源标签';
  if (WEB_NOISE.has(t)) return '网址/路径噪声';
  if (LANG_CODES.has(t)) return '语言/地区代码';
  if (STOPWORDS.has(t)) return '英语停用词';
  return null;
}

/* ----------------------------- 主流程 ----------------------------- */

async function main() {
  const headers = { accept: 'application/json' };
  const get = async (url) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status} ${r.statusText}`);
    return r.json();
  };

  // 1) 拉取热词榜
  const hot = await get(`${BASE}/api/hot?limit=${LIMIT}`);
  const items = Array.isArray(hot?.items) ? hot.items : [];
  if (!items.length) {
    console.log('热词榜为空（索引可能尚未就绪或无数据）。');
    return;
  }
  console.log(`已拉取热词 ${items.length} 条（前 ${LIMIT} 名）。`);

  // 2) 拉取已有黑名单，避免重复统计
  const existing = await get(`${BASE}/api/hot/filter`);
  const blacklisted = new Set(
    (Array.isArray(existing?.items) ? existing.items : []).map((i) => String(i.term).toLowerCase())
  );

  // 3) 分类
  const byReason = new Map(); // reason -> [term]
  const toAdd = [];           // 待入库的新词
  const kept = [];            // 保留（有搜索价值）的热词示例
  for (const { term, doc_count } of items) {
    const reason = classify(term);
    if (!reason) {
      kept.push(term);
      continue;
    }
    (byReason.get(reason) ?? byReason.set(reason, []).get(reason)).push(`${term}(${doc_count})`);
    // 归一化（与后端一致）后入库；已存在的跳过
    const n = normalizeKeyword(term);
    if (n && !blacklisted.has(n)) toAdd.push(n);
  }

  // 4) 打印明细
  console.log('\n===== 判定为「无搜索意义」的热词（按原因分组）=====');
  let totalClassified = 0;
  for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    totalClassified += list.length;
    console.log(`\n[${reason}]  ${list.length} 条`);
    console.log('  ' + list.join('  '));
  }
  console.log(`\n判定无用合计 ${totalClassified} 条；其中待新增入库 ${toAdd.length} 条（其余已存在于黑名单）。`);
  console.log(`\n保留（有搜索价值）样本 ${Math.min(kept.length, 40)} / ${kept.length} 条：`);
  console.log('  ' + kept.slice(0, 40).join('  '));

  if (!toAdd.length) {
    console.log('\n没有需要新增的过滤词，结束。');
    return;
  }

  // 5) 批量入库
  const importRes = await fetch(`${BASE}/api/hot/filter/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ terms: toAdd }),
  });
  if (!importRes.ok) {
    const text = await importRes.text();
    throw new Error(`导入失败 HTTP ${importRes.status}: ${text}`);
  }
  const out = await importRes.json();
  console.log(
    `\n已入库：本次接受 ${out.accepted} 条，黑名单现有 ${out.total} 条。`
  );
}

main().catch((e) => {
  console.error('执行失败：', e?.message || e);
  process.exit(1);
});
