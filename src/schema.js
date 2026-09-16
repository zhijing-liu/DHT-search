/**
 * drizzle 表定义（仅覆盖真正用查询构造器访问的表）
 * ------------------------------------------------------------------
 * 表结构始终由 index/ddl.js 的 raw DDL 创建，本文件只提供查询构造器的字段引用与类型推断。
 * 副本表（magnets_docs）不在此定义：其列清单唯一定义在 store.js 的 DOCS_COLUMN_DEFS，
 * 且它的查询只有 count(*)，一条 raw SQL 足够，无需再镜像一份表定义。
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { STATE_TABLE } from './store.js';

/** 索引状态（数据水位 / 格式水位 / 维护状态），键的语义见 store.js 的 STATE_KEYS */
export const syncMeta = sqliteTable(STATE_TABLE, {
  key: text('key').primaryKey(),
  value: text('value'),
});
