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
let searchCalls = 0;
client.requestAPI = async (method, urlPath, body) => {
  if (method === 'GET' && urlPath.includes('/wiki/v2/spaces/get_node')) {
    return { code: 0, data: { node: { obj_type: 'bitable', obj_token: 'appWikiTest' } } };
  }
  if (method === 'POST' && urlPath.includes('/records/search')) {
    // 翻页夹具（2026-11-09 审查 P1 修复回归）：search 单页 500 上限，第 1 页带
    // has_more+page_token，第二页放一条早日期独立行——无翻页实现会漏读第二页
    // （收编扫描失效）；早日期不影响链尾断言（链尾仍由第 1 页 w_35 决定）
    searchCalls++;
    if (urlPath.includes('page_token=pt2')) {
      return {
        code: 0,
        data: {
          items: [{ record_id: 'w_p2', fields: { '购买物资名称': [{ text: '第二页独有旧账行' }], '日期': Date.UTC(2026, 8, 1) - 8 * 3600e3 } }],
          has_more: false,
        },
      };
    }
    return {
      code: 0,
      data: {
        items: wikiRows.map(r => ({ record_id: r.record_id, fields: r.fields })),
        has_more: true,
        page_token: 'pt2',
      },
    };
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
  const searchBefore = searchCalls;
  const r2 = await cardFlowSyncService.syncOnce({ trigger: 'paid' });
  assert.equal(searchCalls - searchBefore, 2, 'readWikiTable 应翻页读完两页（单页 500 上限的翻页回归）');
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

  // ---------- 状态丢失重启 → 收编兜底（幂等第 2 层真覆盖，2026-11-09 审查批补） ----------
  // 场景：S37 写 wiki 成功但状态 save 失败后进程重启（状态文件缺 S37 键）——
  // 重启首轮 S37 进 pending，收编扫描对上 wiki 已有行 → 记状态不追加，不双写
  const stLost = readState(st);
  delete stLost.synced[S37];
  fs.writeFileSync(st, JSON.stringify(stLost, null, 2));
  cardFlowSyncService.init(st);
  const r6 = await cardFlowSyncService.syncOnce({ trigger: 'cron' });
  assert.deepEqual(r6.adopted, [S37], '状态丢失的已写行被收编进状态');
  assert.deepEqual(r6.appended, [], '收编行不再追加');
  assert.equal(batchCreateBodies.length, 2, '收编不产生新 batch_create');
  assert.ok(readState(st).synced[S37], '收编后状态恢复');

  // ---------- dryRun 预演（基线后路径）+ 链尾余额缺失残行跳过 ----------
  // wiki 预置「日期最晚但余额缺失」的人工残行：不跳过会把链尾拉成 0 污染递推
  const S38 = '机甲大师实验室-27赛季-对抗赛-无人机机器人-材料费-第三十八笔';
  wikiRows.push({ record_id: 'w_nobal', fields: { '购买物资名称': [{ text: '人工残行（有日期无余额）' }], '日期': Date.UTC(2026, 10, 8) - 8 * 3600e3 } });
  ledgerGrid.push([47, null, S38, 300, 'pc', '转卡', '贺', 'acct', '贺', '2026/11/8', null, '2026/11/8', null]);
  const dry2 = await cardFlowSyncService.syncOnce({ dryRun: true });
  assert.equal(dry2.pending, 1, 'S38 进待同步');
  assert.equal(dry2.preview.length, 1, '基线后 dryRun 预演待同步行（递推链路径）');
  assert.equal(dry2.preview[0].summary, S38);
  assert.equal(dry2.preview[0].prevBalance, 10272.53, '链尾跳过余额缺失残行（取 11/7 的 10272.53 而非 0）');
  assert.equal(dry2.preview[0].amount, 300);

  console.log('✅ stub-test-card-flow 全部通过');
}

(async () => {
  await main();
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-card-flow 失败:', err);
  process.exit(1);
});
