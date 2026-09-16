#!/usr/bin/env node
/**
 * 热词过滤词种子脚本
 * ---------------------------------------------------------------
 * 读取同目录的 hot-filter-words.txt（每行一个词，支持 # 注释），批量写入索引库的
 * keyword_filter 表（幂等，可重复运行）。
 *
 * 用法：npm run seed:filter（或 node scripts/seed-filter.mjs）
 * 扩充过滤词：编辑 hot-filter-words.txt 追加行后再跑一次即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORD_FILTER_TABLE, DEFAULT_INDEX_DB_PATH } from '../src/store.js';
import { openDatabase, setPragma, execRaw, prepareStmt, runStmt, transaction, closeDb, getRow } from '../src/db-driver.js';
import { normalizeKeyword } from '../src/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORDS_FILE = path.join(HERE, 'hot-filter-words.txt');
// 索引库路径：环境变量优先，否则用 db.js 的默认路径（data/dht.search.db）
const indexPath = path.resolve(process.env.DHT_INDEX_DB_PATH || DEFAULT_INDEX_DB_PATH);

let raw;
try {
  raw = fs.readFileSync(WORDS_FILE, 'utf8');
} catch {
  console.error(`找不到过滤词文件：${WORDS_FILE}`);
  process.exit(1);
}

// 按行读取，去掉首尾空白（含去除 BOM），跳过空行与 # 注释行
const words = raw
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

if (!words.length) {
  console.log(`${WORDS_FILE} 中没有有效过滤词，未做任何写入`);
  process.exit(0);
}

const db = openDatabase(indexPath);
setPragma(db, 'busy_timeout', 5000);
// 表不存在则创建（与 db.js 的 DDL 保持一致）
execRaw(db, `CREATE TABLE IF NOT EXISTS ${KEYWORD_FILTER_TABLE} (
  term TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT 0
)`);

const ins = prepareStmt(db, `INSERT OR IGNORE INTO ${KEYWORD_FILTER_TABLE} (term, created_at) VALUES (?, ?)`);
const now = Date.now();
let added = 0;
transaction(db, (list) => {
  for (const w of list) {
    // 复用 db 层的归一化：小写折叠 + 剔除不含字母数字的行
    const term = normalizeKeyword(w);
    if (!term) continue;
    const info = runStmt(ins, [term, now]);
    if (info.changes > 0) added += 1;
  }
})(words);

const total = getRow(db, `SELECT count(*) AS c FROM ${KEYWORD_FILTER_TABLE}`).c;
console.log(`写入完成：本次新增 ${added} 条（文件 ${words.length} 行），过滤表现有 ${total} 条`);
closeDb(db);
