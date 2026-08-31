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
