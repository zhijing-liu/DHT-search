#!/usr/bin/env node
/**
 * 导出热词清单：读取 keyword_stats 中尚未被黑名单过滤的词，
 * 按 doc_count 降序导出为纯文本，供人工/AI 审阅挑选宽泛词。
 * 仅导出纯 ASCII 词（本次只过滤英语宽泛词）。
 *
 * 用法：node scripts/dump-keywords.mjs
 * 输出：scripts/hot-keywords-dump.txt（每行：term<TAB>doc_count<TAB>occurrences）
 */
import fs from 'node:fs';
import path from 'node:path';
import { KEYWORD_TABLE, KEYWORD_FILTER_TABLE, DEFAULT_INDEX_DB_PATH } from '../src/store.js';
import { openDatabase, setPragma, allRows, closeDb } from '../src/db-driver.js';

const HERE = import.meta.dirname;
const indexPath = path.resolve(process.env.DHT_INDEX_DB_PATH || DEFAULT_INDEX_DB_PATH);
const outPath = path.join(HERE, 'hot-keywords-dump.txt');

const db = openDatabase(indexPath, { readonly: true });
setPragma(db, 'busy_timeout', 5000);

const rows = allRows(db, `
  SELECT term, doc_count, occurrences
  FROM ${KEYWORD_TABLE}
  WHERE term NOT IN (SELECT term FROM ${KEYWORD_FILTER_TABLE})
  ORDER BY doc_count DESC, occurrences DESC
`).filter((r) => /^[\x20-\x7e]+$/.test(r.term)); // 仅保留纯 ASCII（英语）

const header = '# 热词导出（未黑名单化、纯ASCII），按 doc_count 降序：term<TAB>doc_count<TAB>occurrences';
fs.writeFileSync(outPath, header + '\n' + rows.map((r) => `${r.term}\t${r.doc_count}\t${r.occurrences}`).join('\n') + '\n', 'utf8');
console.log(`已导出 ${rows.length} 条到 ${outPath}`);
closeDb(db);
