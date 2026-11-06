'use strict';
// 桩测试：公用卡收支明细同步——首航基线快照（防历史回灌）/收编扫描/链尾余额递推/
// 失败不写追加行状态/幂等重试/dryRun 只查不写/paid 兜底。
// 全离线：stub client.requestAPI 与 ledgerSheetService。运行：node scripts/stub-test-card-flow.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../src/config');
config.cardFlow.nodeToken = 'wiktok_test';
config.cardFlow.tableId = 'tblCardTest';

const client = require('../src/feishu/client');
const ledgerSheetService = require('../src/services/ledgerSheetService');
const cardFlowSyncService = require('../src/services/cardFlowSyncService');

// ---- 台账夹具（sheets 网格，0 基；首两行标题）----
const S35 = '机甲大师实验室-27赛季-对抗赛-步兵机器人-材料费-第三十五笔';
const S36 = '机甲大师实验室-27赛季-对抗赛-重装机器人-材料费-第三十六笔';
const S37 = '机甲大师实验室-27赛季-对抗赛-步兵机器人-材料费-第三十七笔';
const ledgerGrid = [
  ['2027年千里团队报销台账', null],
  ['序号', '投递单号', '报销摘要', '报销金额', '项目编号', '支付方式', '收款方', '收款账号', '经办人', '申请日期', '投递日期', '入账日期', '状态'],
  [44, 8425369, S35, 1523.5, 'pc', '转卡', '贺', 'acct', '贺', '2026/10/20', '2026/10/30', '2026/11/6', null], // 基线成员（wiki 已有同摘要 → 假如无基线也会被收编）
  [45, null, S36, 840.97, 'pc', '转卡', '贺', 'acct', '贺', '2026/10/28', null, null, null], // 未入账
  [46, null, S37, 594.42, 'pc', '转卡', '贺', 'acct', '贺', '2026/11/6', null, null, null], // 未入账（后续模拟 paid 填上）
];
ledgerSheetService.resolveSheet = async () => ({ sheetId: 'shLedger', rowCount: 100 });
ledgerSheetService.readGrid = async () => ledgerGrid.map(r => [...r]);

// ---- wiki 数据表27 夹具 ----
const wikiRows = [
  { record_id: 'w_old', fields: { '购买物资名称': [{ text: '旧账行' }], '余额': { type: 2, value: [8000] }, '日期': Date.UTC(2026, 10, 1) - 8 * 3600e3 } },
  { record_id: 'w_35', fields: { '购买物资名称': [{ text: S35 }], '余额': { type: 2, value: [8837.14] }, '日期': Date.UTC(2026, 10, 5) - 8 * 3600e3 } },
  { record_id: 'w_hold', fields: { '购买物资名称': [{ text: '待付段（无日期）' }] } }, // 无日期行：进 existing 不进链
];
let batchCreateBodies = [];
let failBatchCreate = false;
client.requestAPI = async (method, urlPath, body) => {
  if (method === 'GET' && urlPath.includes('/wiki/v2/spaces/get_node')) {
    return { code: 0, data: { node: { obj_type: 'bitable', obj_token: 'appWikiTest' } } };
  }
  if (method === 'POST' && urlPath.includes('/records/search')) {
    return { code: 0, data: { items: wikiRows.map(r => ({ record_id: r.record_id, fields: r.fields })) } };
  }
  if (method === 'POST' && urlPath.includes('/records/batch_create')) {
    if (failBatchCreate) return { code: 1254004, msg: '模拟写入失败' };
    batchCreateBodies.push(body);
    // 模拟 wiki 侧：新行落表后公式字段「余额」按 上一笔余额+金额（收入）重算，后续读取可见
    body.records.forEach((rec, i) => {
      const f = rec.fields;
      wikiRows.push({
        record_id: `w_new_${batchCreateBodies.length}_${i}`,
        fields: { ...f, '余额': { type: 2, value: [f['上一笔余额'] + f['金额']] } },
      });
    });
    return { code: 0, data: { records: body.records } };
  }
  throw new Error(`测试未预期的飞书调用: ${method} ${urlPath}`);
};

const tmpState = () => path.join(os.tmpdir(), `card-flow-state-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
const readState = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const D6 = Date.UTC(2026, 10, 6) - 8 * 3600e3; // 2026/11/6 北京零点

async function main() {
  // ---------- 单元：parseLedgerDateMs ----------
  assert.equal(cardFlowSyncService.parseLedgerDateMs('2026/11/6'), D6, '北京零点 ms（固定 +08）');
  assert.equal(cardFlowSyncService.parseLedgerDateMs('2026/11/06'), D6, '前导零兼容');
  assert.equal(cardFlowSyncService.parseLedgerDateMs(''), 0, '空 → 0');
  assert.equal(cardFlowSyncService.parseLedgerDateMs('2026-11-6'), 0, '异格式 → 0');

  // ---------- enabled/disabled ----------
  assert.equal(cardFlowSyncService.ledgerEnabled(), true, '双键齐=开启');
  config.cardFlow.nodeToken = '';
  assert.equal(cardFlowSyncService.ledgerEnabled(), false, '缺 token=关闭');
  assert.deepEqual(await cardFlowSyncService.syncOnce(), { action: 'disabled' }, '关闭态直接返回');
  config.cardFlow.nodeToken = 'wiktok_test';

  // ---------- dryRun（基线未建）：给基线警告不预演不落盘 ----------
  let st = tmpState();
  cardFlowSyncService.init(st);
  const dry = await cardFlowSyncService.syncOnce({ dryRun: true });
  assert.equal(dry.pending, 1, '入账且未同步 1 行（第三十五笔）');
  assert.ok(dry.baselineWarning, '基线未建给警告');
  assert.deepEqual(dry.preview, [], '基线未建不预演');
  assert.ok(!fs.existsSync(st), 'dryRun 不落状态');

  // ---------- 首航：基线快照（防历史回灌），只记状态不建行 ----------
  const r1 = await cardFlowSyncService.syncOnce({ trigger: 'cron' });
  assert.equal(r1.baselined, 1, '基线记 1 行');
  assert.equal(batchCreateBodies.length, 0, '首航不写 wiki');
  assert.equal(readState(st).baselined, true, '基线标志落盘');
  assert.ok(readState(st).synced[S35], '基线含第三十五笔');

  // ---------- 模拟 paid 填入账日期 → 新行同步（链尾递推 + 收编双保险） ----------
  ledgerGrid[4][11] = '2026/11/6'; // S37 入账
  const r2 = await cardFlowSyncService.syncOnce({ trigger: 'paid' });
  assert.deepEqual(r2.appended, [S37], '新入账行追加');
  assert.equal(batchCreateBodies.length, 1, 'batch_create 一次');
  assert.equal(batchCreateBodies[0].records.length, 1);
  assert.equal(batchCreateBodies[0].records[0].fields['上一笔余额'], 8837.14, '踩 wiki 链尾');
  assert.equal(batchCreateBodies[0].records[0].fields['金额'], 594.42);
  assert.equal(batchCreateBodies[0].records[0].fields['日期'], D6, '台账 L 列日期按北京零点折算');
  assert.equal(batchCreateBodies[0].records[0].fields['收/支'], '收入');
  assert.equal(batchCreateBodies[0].records[0].fields['来源/去向'], '学校');
  assert.equal(batchCreateBodies[0].records[0].fields['购买物资名称'], S37, '摘要全文进物资名称');
  assert.ok(readState(st).synced[S37], '追加行状态落盘');

  // ---------- 幂等：二轮无新增 ----------
  const r3 = await cardFlowSyncService.syncOnce({ trigger: 'cron' });
  assert.equal(r3.pending, 0, '二轮待同步清零');
  assert.equal(batchCreateBodies.length, 1, '二轮不重复写');

  // ---------- 失败：batch_create 挂 → 追加行不进状态 → 修复后重试成功 ----------
  ledgerGrid[3][11] = '2026/11/7'; // S36 入账（wiki 无此摘要行，走追加）
  failBatchCreate = true;
  const r4 = await cardFlowSyncService.syncOnce({ trigger: 'cron' });
  assert.equal(r4.failed.length, 1, '失败如实上报');
  assert.equal(r4.appended.length, 0, '失败不记 appended');
  assert.ok(!readState(st).synced[S36], '失败的追加行不进状态（收编/基线行可独立落盘）');
  failBatchCreate = false;
  const r5 = await cardFlowSyncService.syncOnce({ trigger: 'paid' });
  assert.deepEqual(r5.appended, [S36], '修复后重试成功');
  assert.equal(batchCreateBodies[1].records[0].fields['上一笔余额'], 9431.56, '递推链：8837.14+594.42=9431.56');
  assert.equal(batchCreateBodies.length, 2, '重试即第二次 batch_create');

  console.log('✅ stub-test-card-flow 全部通过');
}

(async () => {
  await main();
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-card-flow 失败:', err);
  process.exit(1);
});
