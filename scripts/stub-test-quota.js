/**
 * 项目额度桩测试（v104 额度功能）：占用口径/upsert 幂等/超支检测/撤销/周报渲染/降级。
 * mock bitableApi + collectStore（require.cache 注入），不触网。接入 npm test（push 闸门）。
 */
process.env.FORM_ALERT_DISABLED = '1';
process.env.BITABLE_QUOTA_TABLE_ID = 'tblQuotaStub'; // config 首次加载前注入（.env 里的空值会被 dotenv 跳过已有 env）
const assert = require('assert');
const path = require('path');

// ---- mock bitableApi（额度表 CRUD）----
let quotaRows = []; // [{record_id, fields}]
let nextRecordId = 1;
const bitableApi = {
  async listAllRecords() { return quotaRows.map(r => ({ record_id: r.record_id, fields: { ...r.fields } })); },
  async createRecord(tableId, fields) { quotaRows.push({ record_id: 'rec_q' + nextRecordId++, fields: { ...fields } }); return { record_id: 'rec_q' + (nextRecordId - 1), fields }; },
  async updateRecord(tableId, recordId, fields) {
    const row = quotaRows.find(r => r.record_id === recordId);
    if (!row) throw new Error('not found');
    Object.assign(row.fields, fields);
    return { record_id: row.record_id, fields: row.fields };
  },
  async deleteRecord(tableId, recordId) {
    const before = quotaRows.length;
    quotaRows = quotaRows.filter(r => r.record_id !== recordId);
    if (quotaRows.length === before) throw new Error('not found');
    return { record_id: recordId };
  },
};

// ---- mock collectStore（占用口径数据源：批次表）----
let batchRows = [];
const collectStoreStub = {
  BATCH_STATUS: { DRAFT: '拟批', LOCKED: '已锁定', SUBMITTED: '已提交', PAID: '已到账', REJECTED: '已退回' },
  async listBatches() { return batchRows.map(r => ({ record_id: r.record_id, fields: { ...r.fields } })); },
  async listCollect() { return []; },
};

// require.cache 注入 stub（quotaService 与其依赖链解析到同一路径即命中）
const bitableRealPath = require.resolve('../src/feishu/bitable');
const collectRealPath = require.resolve('../src/services/collectStore');
require.cache[bitableRealPath] = { id: bitableRealPath, filename: bitableRealPath, loaded: true, exports: bitableApi };
require.cache[collectRealPath] = { id: collectRealPath, filename: collectRealPath, loaded: true, exports: collectStoreStub };

const quotaService = require('../src/services/quotaService');

async function main() {
  // ---------- 1. setQuota 幂等 upsert ----------
  const r1 = await quotaService.setQuota('对抗赛', 20000);
  assert.equal(r1.action, 'created', '首次设置=created');
  const r2 = await quotaService.setQuota('对抗赛', 25000, 3000);
  assert.equal(r2.action, 'updated', '同名行再次设置=updated（幂等 upsert）');
  assert.equal(quotaRows.length, 1, '不重复建行');
  await assert.rejects(() => quotaService.setQuota('', 100), /项目名不能为空/);
  await assert.rejects(() => quotaService.setQuota('X', -5), /总额度非法/);
  await assert.rejects(() => quotaService.setQuota('X', 100, 200), /初始已用.*大于总额度/);

  // ---------- 2. 占用口径：锁定/提交/到账占，退回/拟批不占，多项目批次按主项目 ----------
  batchRows = [
    { record_id: 'b1', fields: { '批次号': 'B1', '项目': '对抗赛', '金额合计': 1000, '状态': '已到账' } },
    { record_id: 'b2', fields: { '批次号': 'B2', '项目': '对抗赛', '金额合计': 500, '状态': '已提交' } },
    { record_id: 'b3', fields: { '批次号': 'B3', '项目': '对抗赛', '金额合计': 200, '状态': '已锁定' } },
    { record_id: 'b4', fields: { '批次号': 'B4', '项目': '对抗赛', '金额合计': 999, '状态': '已退回' } }, // 释放
    { record_id: 'b5', fields: { '批次号': 'B5', '项目': '对抗赛', '金额合计': 888, '状态': '拟批' } },   // 不占
    { record_id: 'b6', fields: { '批次号': 'B6', '项目': '对抗赛/团队建设', '金额合计': 300, '状态': '已到账' } }, // 主项目归属
    { record_id: 'b7', fields: { '批次号': 'B7', '项目': '宣运物资', '金额合计': 220.43, '状态': '已到账' } },
  ];
  const ov = await quotaService.getQuotaOverview();
  const dui = ov.items.find(i => i.project === '对抗赛');
  assert.ok(dui, '额度表项目在总览中');
  assert.equal(dui.locked, 200, '已锁定占用 200');
  assert.equal(dui.submitted, 500, '已提交占用 500');
  assert.equal(dui.paid, 1300, '已到账占用 1000+300（多项目批次按主项目归属）');
  assert.equal(dui.spent, 2000, '总占用 = 200+500+1300');
  assert.equal(dui.remaining, 25000 - 3000 - 2000, '剩余 = 额度-初始已用-占用');
  assert.equal(dui.overspend, false, '未超支');
  assert.ok(ov.unmanaged.some(u => u.project === '宣运物资'), '无额度配置但有消耗的项目进 unmanaged 提示');

  // ---------- 3. 超支检测 + 排序（超支在前） ----------
  await quotaService.setQuota('团队建设', 100);
  const ov2 = await quotaService.getQuotaOverview();
  const team = ov2.items.find(i => i.project === '团队建设');
  assert.equal(team.remaining, 100, '无消耗项目剩余=额度');
  await quotaService.setQuota('对抗赛', 4000, 3000); // 4000-3000-2000 = -1000 制造超支
  const ov3 = await quotaService.getQuotaOverview();
  assert.equal(ov3.items[0].project, '对抗赛', '超支项目排序置顶（剩余升序）');
  assert.equal(ov3.items[0].remaining, -1000, '剩余为负');
  assert.equal(ov3.items[0].overspend, true, '超支标记');

  // ---------- 4. deleteQuota ----------
  const d1 = await quotaService.deleteQuota('团队建设');
  assert.equal(d1.action, 'deleted', '撤销额度');
  const d2 = await quotaService.deleteQuota('不存在');
  assert.equal(d2.action, 'not_found', '撤销不存在的项目=not_found');
  const ov4 = await quotaService.getQuotaOverview();
  assert.ok(!ov4.items.some(i => i.project === '团队建设'), '撤销后不再出现在额度总览');

  // ---------- 5. 周报卡渲染（buildWeeklyFinanceCard 额度段） ----------
  const bot = require('../src/feishu/bot');
  const card = bot.buildWeeklyFinanceCard(
    { missingInvoice: [], missingForm: [], missingTransfer: [] },
    { weekNew: 0, weekApproved: 0, weekRejected: 0 },
    { quotaOverview: { items: [{ project: '对抗赛', quota: 4000, initialSpent: 3000, locked: 200, submitted: 500, paid: 1300, spent: 2000, remaining: -1000, overspend: true }], unmanaged: [{ project: '宣运物资', spent: 220.43 }] } },
  );
  const md = JSON.stringify(card);
  assert.ok(md.includes('项目额度'), '周报含额度段');
  assert.ok(md.includes('🚨'), '超支标记渲染');
  assert.ok(md.includes('对抗赛'), '项目名渲染');
  assert.ok(md.includes('宣运物资'), '未设额度提示渲染');

  // ---------- 6. 额度表未配置降级（子进程真实验证：.env 空配置 → 明确报错不静默） ----------
  const { execFileSync } = require('child_process');
  const out = execFileSync('node', ['-e', `
    process.env.BITABLE_QUOTA_TABLE_ID = '';
    const q = require('./src/services/quotaService');
    q.setQuota('X', 1).then(() => console.log('NO_ERROR'), (e) => console.log('ERR:' + e.message));
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.ok(out.includes('ERR:未配置项目额度表'), '空配置时 setQuota 明确报错（实际: ' + out.slice(0, 80) + '）');

  console.log('✅ stub-test-quota 全部通过（占用口径/upsert/超支/撤销/周报渲染/降级）');
}

main().catch(err => { console.error('❌', err); process.exit(1); });
