/**
 * 定时同步接线测试（node-cron v4）：校验调度接线与边界行为。
 * 用法：node test/cron.mjs（或 npm run test:cron）
 */

import assert from 'node:assert/strict';
import cron from 'node-cron';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${label}`);
};

/** 建一个已调度任务并在断言后立即销毁（避免残留定时器让进程退不出） */
function withTask(expr, fn) {
  const task = cron.schedule(expr, () => {});
  try {
    fn(task);
  } finally {
    task.stop();
    task.destroy();
  }
}

/* ---------- 表达式校验：index.js 的 SYNC_CRON_ON 直接用它 ---------- */

check('validate 接受标准 5 段表达式', () => {
  for (const expr of ['0 4 * * *', '*/5 * * * *', '0 0 1,15 * *', '0 0 * * 1-5', '30 2 * * 0']) {
    assert.equal(cron.validate(expr), true, `应判合法: ${expr}`);
  }
});

check('validate 拒绝非法表达式（面板据此不显示倒计时）', () => {
  const bad = ['', '   ', 'abc', '0 0 * *', '60 0 * * *', 'not-a-cron'];
  for (const expr of bad) {
    assert.equal(cron.validate(expr), false, `应判非法: ${JSON.stringify(expr)}`);
  }
});

check('v4 也接受带秒的 6 段表达式（v3 会判非法，属能力扩展）', () => {
  // 注意这是相对 v3 的行为变化：以前 '*/30 * * * * *' 会被 SYNC_CRON_ON 判为无效并告警，
  // 现在会被真正注册为「每 30 秒」的定时同步。config.js 的说明仍推荐标准 5 字段。
  assert.equal(cron.validate('*/30 * * * * *'), true);
});

/* ---------- 下次触发时刻：面板「下次同步」的数据源 ---------- */

check('getNextRun 返回将来的 Date，且落在表达式允许的位置（*/5）', () => {
  withTask('*/5 * * * *', (task) => {
    const next = task.getNextRun();
    assert.ok(next instanceof Date, `应返回 Date，实际 ${next}`);
    assert.ok(next.getTime() > Date.now(), `应晚于当前时刻：${next?.toISOString()}`);
    assert.equal(next.getSeconds(), 0, 'cron 最小粒度是分钟');
    assert.equal(next.getMinutes() % 5, 0, `应落在 5 分钟边界：${next.toISOString()}`);
  });
});

check('每天固定时刻：下次触发的小时/分钟与表达式一致', () => {
  withTask('30 4 * * *', (task) => {
    const next = task.getNextRun();
    assert.equal(next.getHours(), 4);
    assert.equal(next.getMinutes(), 30);
  });
});

check('停止后没有下次触发（getNextRun 为 null，面板显示空）', () => {
  const task = cron.schedule('*/5 * * * *', () => {});
  task.stop();
  assert.equal(task.getNextRun(), null);
  task.destroy();
});

check('表达式无解时不抛错（2 月 30 日：返回 null 或由库直接拒绝）', () => {
  // 两种可能都算通过：库在 schedule 时就拒绝，或建好后 getNextRun() 返回 null
  let task = null;
  try {
    task = cron.schedule('0 0 30 2 *', () => {});
  } catch {
    return;
  }
  try {
    assert.equal(task.getNextRun(), null);
  } finally {
    task.stop();
    task.destroy();
  }
});

console.log(`\ncron: ${passed} 项断言通过`);
