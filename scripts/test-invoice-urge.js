// 桩测试：催发票私聊——回复解析 / 延期时长解析 / 间隔闸 / 计数升级 / 满上限跳过
// 全离线：stub 掉多维表格查询、通讯录、IM 发送；催办状态写临时文件，跑完即删
// （接入 push.js 部署前测试闸门，行为改动必须过本套件）
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
config.invoiceUrge.stateFile = path.join(os.tmpdir(), `urge-test-${process.pid}-${Date.now()}.json`);

const urgeStateStore = require('../src/services/urgeStateStore');
const approvalService = require('../src/services/approvalService');
const contacts = require('../src/feishu/contacts');
const bot = require('../src/feishu/bot');
urgeStateStore.init(config.invoiceUrge.stateFile); // 先于首跑指向临时文件（runInvoiceUrge 内 ensureInit 复用同一路径）

// ---- 测试桩 ----
let currentOverdue = [];
let activeOpenIds = new Set();
const sentPosts = [];
approvalService.getOverdueInvoices = async () => currentOverdue;
contacts.listActiveOpenIds = async () => activeOpenIds;
bot.sendPostToUser = async (openId, title) => {
  sentPosts.push({ openId, title });
  // 不返回 chat_id：发送后的回复轮询会跳过无会话用户，测试保持全离线
  return { create_time: Date.now() };
};
bot.sendTextToUser = async () => ({});
bot.sendMessage = async () => ({});

let seq = 0;
function mkRecord() {
  seq += 1;
  const openId = `ou_u${seq}`;
  return {
    openId,
    record_id: `rec_test_${seq}`,
    fields: {
      '发起人': [{ id: openId, name: `测试${seq}` }],
      '申请编号': { text: `2026091500${seq}`, link: 'https://example.feishu.cn/x' },
      '购买物资名称': '测试物资',
      '完成时间': Date.now() - 20 * 24 * 3600 * 1000,
    },
  };
}

async function main() {
  const { runInvoiceUrge, parseReply, parseDeferDays, announceTodayUrged } = require('../src/services/invoiceUrgeService');

  // ---------- 单元：parseReply（无法提交优先于延期） ----------
  assert.equal(parseReply('无法提交'), 'cannot_submit');
  assert.equal(parseReply('发票开不出来'), 'cannot_submit');
  assert.equal(parseReply('办不了'), 'cannot_submit');
  assert.equal(parseReply('不能提交，要下周才行'), 'cannot_submit');
  assert.equal(parseReply('延期'), 'deferred');
  assert.equal(parseReply('推迟几天'), 'deferred');
  assert.equal(parseReply('发票还没开'), 'deferred');
  assert.equal(parseReply('下周给你'), 'deferred');
  assert.equal(parseReply('稍等，晚点交'), 'deferred');
  assert.equal(parseReply('已线下递交'), null);
  assert.equal(parseReply('好的谢谢'), null);

  // ---------- 单元：parseDeferDays（时长解析 + 钳制 + 无时长回落） ----------
  assert.equal(parseDeferDays('延期3天'), 3);
  assert.equal(parseDeferDays('推迟 7 天'), 7);
  assert.equal(parseDeferDays('延期一周'), 7);
  assert.equal(parseDeferDays('延期两周'), 14);
  assert.equal(parseDeferDays('延期十天'), 10);
  assert.equal(parseDeferDays('延期999天'), 60);
  assert.equal(parseDeferDays('延期'), 0);
  // 中文数字十进制组合 / 周天组合 / 「日」单位 / 半周 / 下周
  assert.equal(parseDeferDays('延期十五天'), 15);
  assert.equal(parseDeferDays('二十天以后'), 20);
  assert.equal(parseDeferDays('延期二十五天'), 25);
  assert.equal(parseDeferDays('两周零三天'), 17);
  assert.equal(parseDeferDays('延期7日'), 7);
  assert.equal(parseDeferDays('半周后再给'), 3);
  assert.equal(parseDeferDays('下周三给'), 7);
  assert.equal(parseDeferDays('下周给'), 7);

  // ---------- 行为：间隔闸（距上次私聊不满 2 天不催） ----------
  const recHold = mkRecord();
  urgeStateStore.updateRecord(recHold.record_id, { urgeCount: 1, lastUrgeAt: Date.now() - 1 * 86400e3 });
  currentOverdue = [recHold];
  let r = await runInvoiceUrge();
  assert.equal(r.statusCounts.intervalHold, 1, '1 天前（第 1 天）催过的应被间隔闸拦下');
  assert.equal(r.sent, false);
  assert.equal(urgeStateStore.getRecord(recHold.record_id).urgeCount, 1);

  // ---------- 行为：间隔闸按上海日历日比较（恰好 48h = 两个日历日前催过 → 允许再催） ----------
  const recEdge = mkRecord();
  urgeStateStore.updateRecord(recEdge.record_id, { urgeCount: 1, lastUrgeAt: Date.now() - 2 * 86400e3 });
  activeOpenIds = new Set([recEdge.openId]);
  currentOverdue = [recEdge];
  sentPosts.length = 0;
  r = await runInvoiceUrge();
  assert.equal(r.sent, true, '恰好 48h（两个上海日历日）前催过的应允许再催');
  assert.equal(urgeStateStore.getRecord(recEdge.record_id).urgeCount, 2, '再催后计数 +1');

  // ---------- 行为：到期催交 + 第 5 次触发升级 ----------
  const recDue = mkRecord();
  urgeStateStore.updateRecord(recDue.record_id, { urgeCount: 4, lastUrgeAt: Date.now() - 3 * 86400e3 });
  activeOpenIds = new Set([recDue.openId]);
  currentOverdue = [recDue];
  sentPosts.length = 0;
  r = await runInvoiceUrge();
  assert.equal(r.sent, true, '满 2 天间隔的记录应被私聊');
  assert.equal(r.urgedRecords.length, 1);
  assert.deepEqual(sentPosts.map((s) => s.openId), [recDue.openId]);
  const stDue = urgeStateStore.getRecord(recDue.record_id);
  assert.equal(stDue.urgeCount, 5, '发送后计数 +1');
  assert.equal(stDue.status, 'escalated', '满 maxTimes(5) 次标记升级');

  // ---------- 行为：满上限跳过私聊 ----------
  currentOverdue = [recDue];
  r = await runInvoiceUrge();
  assert.equal(r.statusCounts.escalated, 1);
  assert.equal(r.sent, false);

  // ---------- 行为：「今日已催」播报闸（当日状态变化也发卡） ----------
  const sentCards = [];
  bot.sendMessage = async (card) => { sentCards.push(card); return {}; };

  // 场景 A：当天无私聊催交，但有当日「无法提交」状态变化 → 发卡（财务看得到）
  const recNotice = mkRecord();
  urgeStateStore.updateRecord(recNotice.record_id, {
    status: 'cannot_submit', statusChangedAt: Date.now(), statusNote: '发起人称无法提交',
  });
  currentOverdue = [recNotice];
  r = await runInvoiceUrge();
  assert.equal(r.sent, false, 'cannot_submit 记录不进私聊');
  sentCards.length = 0;
  let ar = await announceTodayUrged(r);
  assert.equal(ar.announced, true, '当日有状态变化（无法提交）即使无催交也应发卡');
  assert.equal(sentCards.length, 1, '发卡恰好一次');
  assert.ok(JSON.stringify(sentCards[0]).includes('无法提交'), '卡内含「无法提交」关注项');

  // 场景 B：全无（无催交、无当日状态变化）→ 不发卡
  const recQuiet = mkRecord();
  urgeStateStore.updateRecord(recQuiet.record_id, {
    status: 'deferred', snoozeUntil: Date.now() + 86400e3, statusNote: '延期中（无当日状态变化）',
  });
  currentOverdue = [recQuiet];
  r = await runInvoiceUrge();
  sentCards.length = 0;
  ar = await announceTodayUrged(r);
  assert.equal(ar.announced, false, '无催交且无当日状态变化不发卡');
  assert.equal(ar.reason, 'no_urge_today');
  assert.equal(sentCards.length, 0, '静默日不发卡');

  console.log('✅ 桩测试全部通过：parseReply ×10 / parseDeferDays ×16 / 间隔闸（含 48h 边界） / 计数升级 / 满上限跳过 / 今日已催播报闸');
}

main()
  .catch((err) => { console.error('❌ 桩测试失败:', err.message); process.exitCode = 1; })
  .finally(() => { try { fs.unlinkSync(config.invoiceUrge.stateFile); } catch (_) { /* 已清理 */ } });
