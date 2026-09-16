#!/usr/bin/env node
/**
 * 自动筛选「宽泛英语热词」：把 keyword_stats 中纯字母且属于常用英语词表
 * （data/common-english.txt）的词挑出来作为黑名单候选，另补一小撮语言 / 地区代码噪声。
 * 结果写入 scripts/hot-filter-en.auto.txt 供人工审阅，不直接动库。
 *
 * 用法：node scripts/filter-common-en.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORD_TABLE, KEYWORD_FILTER_TABLE, DEFAULT_INDEX_DB_PATH } from '../src/store.js';
import { openDatabase, setPragma, allRows, pluckAll, closeDb } from '../src/db-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(process.env.DHT_INDEX_DB_PATH || DEFAULT_INDEX_DB_PATH);
const commonPath = path.join(HERE, '..', 'data', 'common-english.txt');
const outPath = path.join(HERE, 'hot-filter-en.auto.txt');

// 1) 加载常用英语词表（小写、纯字母）
const common = new Set(
  fs.readFileSync(commonPath, 'utf8').split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]+$/.test(w))
);

// 2) 明显的语言/地区代码噪声（非词典词，torrent 名里高频无意义）
const langCodes = new Set([
  'fr', 'es', 'it', 'pt', 'nl', 'de', 'ru', 'pl', 'us', 'uk', 'jp', 'kr', 'cn',
  'br', 'mx', 'ca', 'au', 'se', 'no', 'dk', 'fi', 'tr', 'gr', 'ar', 'il', 'ir',
  'th', 'vn', 'id', 'my', 'ph', 'in', 'za', 'ng', 'ke', 'eg', 'sa', 'ae',
]);

// 3) 类别/导航词白名单：作为检索入口有意保留，不视为宽泛词拉黑
const categoryKeep = new Set([
  'movie', 'movies', 'game', 'games', 'anime', 'manga', 'music', 'comic', 'comics',
  'novel', 'novels', 'book', 'books', 'film', 'films', 'tv', 'show', 'shows',
  'hentai', 'doujin', 'doujinshi', 'drama', 'dramas', 'cartoon', 'cartoons',
  'documentary', 'documentaries', 'album', 'albums', 'serial', 'series',
  'action', 'adult', 'adventure', 'comedy', 'horror', 'romance', 'thriller',
  'fantasy', 'scifi', 'sci', 'genre', 'story', 'stories',
]);

// 4) doc_count 阈值：只处理真正会出现在前排热词里的高频宽泛词，
//    低频长尾词本就不会展示，拉黑只会虚增黑名单规模，故忽略。
const DOC_COUNT_MIN = 50;

const db = openDatabase(indexPath, { readonly: true });
setPragma(db, 'busy_timeout', 5000);

// 已黑名单化的词（避免重复）
const blacklisted = new Set(pluckAll(db, `SELECT term FROM ${KEYWORD_FILTER_TABLE}`));

// 全部纯 ASCII 热词（未黑名单化）
const rows = allRows(db, `
  SELECT term, doc_count FROM ${KEYWORD_TABLE}
  WHERE term NOT IN (SELECT term FROM ${KEYWORD_FILTER_TABLE})
`).filter((r) => /^[\x20-\x7e]+$/.test(r.term));

const candidates = new Map(); // term -> reason
for (const { term, doc_count } of rows) {
  const t = term.toLowerCase();
  if (blacklisted.has(t) || categoryKeep.has(t)) continue;
  if (/^[a-z]{2,}$/.test(t) && common.has(t) && doc_count >= DOC_COUNT_MIN) {
    candidates.set(t, `常用英语词(doc_count=${doc_count})`);
  } else if (langCodes.has(t)) {
    candidates.set(t, `语言/地区代码噪声(doc_count=${doc_count})`);
  }
}

const sorted = [...candidates.keys()].sort();
const lines = [
  '# 自动筛选：宽泛英语热词候选（常用英语词表交集 + 语言代码噪声）',
  '# 审阅后由 scripts/seed-filter.mjs 入库；行尾 # 注释为命中原因，入库时会被忽略',
  ...sorted.map((t) => `${t}  # ${candidates.get(t)}`),
];
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`候选 ${sorted.length} 条，已写入 ${outPath}`);
closeDb(db);
