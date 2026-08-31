import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * 影子索引库中的去规范化副本表（展示/排序用）。
 * 表结构本身由 db.js 内的 raw DDL 创建（与 FTS5 虚表一并管理），
 * 此处仅用于 drizzle 查询构造器的字段引用与类型推断。
 */
export const magnetsDocs = sqliteTable('magnets_docs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().default(''),
  infohash: text('infohash'),
  magnet: text('magnet'),
  files: text('files'),
  totalSize: integer('totalSize').notNull().default(0),
  fetchedAt: integer('fetchedAt').notNull().default(0),
});

/** 同步水位（tokenizer / last_rowid） */
export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * 热词统计表（构建索引时随 populate 统计写入，供热词榜展示/排序）。
 * 表结构本身由 db.js 内的 raw DDL 创建，此处仅用于 drizzle 字段引用与类型推断。
 */
export const keywordStats = sqliteTable('keyword_stats', {
  term: text('term').primaryKey(),
  docCount: integer('doc_count').notNull().default(0),
  occurrences: integer('occurrences').notNull().default(0),
});

/**
 * 热词过滤表（用户配置的噪声词，热词统计与热词榜均排除）。
 * 表结构本身由 db.js 内的 raw DDL 创建，reindex 不清除。
 */
export const keywordFilter = sqliteTable('keyword_filter', {
  term: text('term').primaryKey(),
  createdAt: integer('created_at').notNull().default(0),
});
