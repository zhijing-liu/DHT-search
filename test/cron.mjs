/**
 * src/cron.js 单元测试（纯函数，无需数据库）
 * 用法：node test/cron.mjs
 * 覆盖：表达式解析（合法/非法）、步长与列表、日/周 OR 语义、英文缩写、
 *      闰年 2 月 29 日、无解表达式、以及「严格晚于起点」的边界。
 */

import assert from 'node:assert/strict';
import { parseCron, nextCronTime } from '../src/cron.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${label}`);
};

/** 本地时间构造：at(2026, 9, 9, 4, 0) = 2026-09-09 04:00:00.000 */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const ts = (d) => (d == null ? 'null' : d.toLocaleString('zh-CN'));
const isSame = (a, b) => a != null && b != null && a.getTime() === b.getTime();

/* ---------- 解析：非法表达式一律 null ---------- */

check('非法 / 非标准 5 段表达式返回 null', () => {
  const bad = ['', '   ', 'abc', '0 0 * *', '* * * * * *', '60 0 * * *', '0 24 * * *',
    '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '5-1 * * * *', null, undefined, 42];
  for (const expr of bad) assert.equal(parseCron(expr), null, `应判非法: ${String(expr)}`);
});

check('合法表达式解析出取值集合', () => {
  const s = parseCron('*/15 9-17 1 * mon');
  assert.deepEqual([...s.minutes], [0, 15, 30, 45]);
  assert.equal(s.hours.size, 9); // 9..17
  assert.equal(s.months.size, 12);
  assert.deepEqual([...s.doms], [1]);
  assert.deepEqual([...s.dows], [1]);
});

check('* 展开为整段取值域', () => {
  const s = parseCron('0 4 * * *');
  assert.equal(s.minutes.size, 1);
  assert.equal(s.hours.size, 1);
  assert.equal(s.doms.size, 31);
  assert.equal(s.months.size, 12);
  assert.equal(s.dows.size, 7);
});

/* ---------- 基本推算 ---------- */

check('每天固定时刻：起点前 → 今天同一时刻', () => {
  const next = nextCronTime('0 4 * * *', at(2026, 9, 9, 3, 0));
  assert.ok(isSame(next, at(2026, 9, 9, 4, 0)), ts(next));
});

check('每天固定时刻：恰在触发点上 → 取明天（严格晚于起点）', () => {
  const next = nextCronTime('0 4 * * *', at(2026, 9, 9, 4, 0));
  assert.ok(isSame(next, at(2026, 9, 10, 4, 0)), ts(next));
});

check('秒 / 毫秒被忽略，按整分钟对齐', () => {
  const next = nextCronTime('0 4 * * *', new Date(2026, 8, 9, 3, 59, 59, 999));
  assert.ok(isSame(next, at(2026, 9, 9, 4, 0)), ts(next));
});

check('步长：*/5 取下一个 5 分整点', () => {
  assert.ok(isSame(nextCronTime('*/5 * * * *', at(2026, 9, 9, 10, 3)), at(2026, 9, 9, 10, 5)));
  assert.ok(isSame(nextCronTime('*/5 * * * *', at(2026, 9, 9, 10, 5)), at(2026, 9, 9, 10, 10)));
  assert.ok(isSame(nextCronTime('*/5 * * * *', at(2026, 9, 9, 10, 58)), at(2026, 9, 9, 11, 0)));
});

check('步长取「能被 step 整除」的值（与 node-cron v3 一致，非标准 cron 的段起点累加）', () => {
  assert.deepEqual([...parseCron('1-10/2 * * * *').minutes], [2, 4, 6, 8, 10]);
  // 日字段因此是偶数日（node-cron 实际行为），而非 1,3,5…
  assert.deepEqual([...parseCron('0 0 */2 * *').doms], [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);
  // 分 / 时段从 0 起算，两种语义结果相同
  assert.deepEqual([...parseCron('*/5 * * * *').minutes], [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.ok(isSame(nextCronTime('0 0 */2 * *', at(2026, 9, 9, 10, 0)), at(2026, 9, 10, 0, 0)));
});

check('列表：15,45 取下一个列表值（跨小时）', () => {
  assert.ok(isSame(nextCronTime('15,45 * * * *', at(2026, 9, 9, 10, 16)), at(2026, 9, 9, 10, 45)));
  assert.ok(isSame(nextCronTime('15,45 * * * *', at(2026, 9, 9, 10, 46)), at(2026, 9, 9, 11, 15)));
});

/* ---------- 日 / 周 / 月 ---------- */

check('每周一 03:30（周三起算）', () => {
  // 2026-09-09 是周三，下一个周一为 2026-09-14
  const next = nextCronTime('30 3 * * 1', at(2026, 9, 9, 4, 0));
  assert.ok(isSame(next, at(2026, 9, 14, 3, 30)), ts(next));
});

check('周日可用 0 或 7', () => {
  const from = at(2026, 9, 9, 4, 0); // 周三
  const a = nextCronTime('0 0 * * 0', from);
  const b = nextCronTime('0 0 * * 7', from);
  assert.ok(isSame(a, at(2026, 9, 13, 0, 0)), ts(a)); // 2026-09-13 是周日
  assert.ok(isSame(a, b));
});

check('日与周同时限定 → AND 语义（与 node-cron 一致，非标准 cron 的 OR）', () => {
  // 既是 1 号又是周一：2026-09-12 之后的第一个是 2027-02-01（周一）
  const next = nextCronTime('0 0 1 * 1', at(2026, 9, 12, 12, 0));
  assert.ok(isSame(next, at(2027, 2, 1, 0, 0)), ts(next));
});

check('仅限定日：周字段为 * 不参与过滤', () => {
  const next = nextCronTime('0 0 15 * *', at(2026, 9, 9, 12, 0));
  assert.ok(isSame(next, at(2026, 9, 15, 0, 0)), ts(next));
});

check('月份英文缩写 + 跨年', () => {
  const next = nextCronTime('0 0 1 JAN *', at(2026, 9, 9, 12, 0));
  assert.ok(isSame(next, at(2027, 1, 1, 0, 0)), ts(next));
});

check('闰年 2 月 29 日：跳到下一个真正的 29 号', () => {
  const next = nextCronTime('0 0 29 2 *', at(2026, 3, 1, 0, 0));
  assert.ok(isSame(next, at(2028, 2, 29, 0, 0)), ts(next));
});

check('无解表达式（2 月 30 日）返回 null', () => {
  assert.equal(nextCronTime('0 0 30 2 *', at(2026, 9, 9, 0, 0)), null);
});

/* ---------- 连续序列自洽 ---------- */

check('连续 100 次触发严格递增且命中分钟集合', () => {
  const spec = parseCron('*/7 */2 * * *');
  let cur = at(2026, 9, 9, 0, 0);
  for (let i = 0; i < 100; i += 1) {
    const next = nextCronTime('*/7 */2 * * *', cur);
    assert.ok(next.getTime() > cur.getTime(), '必须严格晚于上一次');
    assert.ok(spec.minutes.has(next.getMinutes()), `分钟应命中集合: ${ts(next)}`);
    assert.ok(spec.hours.has(next.getHours()), `小时应命中集合: ${ts(next)}`);
    cur = next;
  }
});

console.log(`\ncron 单测通过 ${passed} 项`);
