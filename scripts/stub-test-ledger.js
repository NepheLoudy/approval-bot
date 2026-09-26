// 桩测试：报销台账电子表格同步——submit 追加行（幂等/投递单号补填/收款方回退）、
// paid·reject 按摘要精确回填、找不到不误改别人的行、未配置关闭。
// 全离线：stub client.requestAPI（sheets v2/v3）。运行：node scripts/stub-test-ledger.js
const assert = require('assert/strict');

const config = require('../src/config');
config.bitable.collectTableId = 'tblCollectTest';
config.bitable.batchTableId = 'tblBatchTest';
config.ledger.spreadsheetToken = 'tok_ledger_test';
config.ledger.sheetId = '';
// 台账写入口径依赖的交付包配置
config.batch.projectCode = '02520011130031';
config.batch.reporterName = '贺韵洁';
config.batch.bankCardNo = '6228480477161786579';

const client = require('../src/feishu/client');
const collectStore = require('../src/services/collectStore');
const ledgerSheetService = require('../src/services/ledgerSheetService');

// ---- 网格夹具（0 基行数组；模拟实表：标题/表头/2 行数据） ----
const Z = () => Array(13).fill(null);
const grid = [
  ['2027年千里团队报销台账', ...Z().slice(1)],
  ['序号', '投递单号', '报销摘要', '报销金额', '项目编号', '支付方式', '收款方', '收款账号', '经办人', '申请日期', '投递日期', '入账日期', '状态'],
  [1, 8294235, 'RM团队-实验室建设-裁判系统-第一笔', 5872, '02520011130031', '转卡', '陈杨明', '6216613200015262463', '陈嘉豪', '2026/8/12', null, null, '已提交至中心'],
  [2, 8331502, '机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔', 237.04, '02520011130031', '转卡', '贺韵洁', '6228480477161786579', '贺韵洁', '2026/9/20', null, null, '已制单'],
  Z(), Z(),
];

let writes = [];
client.requestAPI = async (method, urlPath, body) => {
  if (method === 'GET' && urlPath.includes('/sheets/v3/') && urlPath.endsWith('/sheets/query')) {
    return { code: 0, data: { sheets: [{ sheet_id: 'shTest', grid_properties: { row_count: 100 } }] } };
  }
  if (method === 'GET' && urlPath.includes('/sheets/v2/') && urlPath.includes('/values/')) {
    return { code: 0, data: { valueRange: { values: grid.map(r => [...r]) } } };
  }
  if (method === 'PUT' && urlPath.includes('/sheets/v2/') && urlPath.endsWith('/values')) {
    const vr = body.valueRange;
    const m = String(vr.range).match(/shTest!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    assert.ok(m, `写入 range 形如 shTest!A5:M5（实际 ${vr.range}）`);
    const startRow = Number(m[2]);
    writes.push({ range: vr.range, values: vr.values });
    vr.values.forEach((row, i) => {
      const target = grid[startRow - 1 + i] || (grid[startRow - 1 + i] = Z());
      row.forEach((v, col) => { target[col] = v; });
    });
    return { code: 0, data: {} };
  }
  throw new Error(`测试未预期的飞书调用: ${method} ${urlPath}`);
};

// ---- 批次桩 ----
const batches = {
  '27对抗赛步兵25': { record_id: 'bat25', fields: {
    '批次号': '27对抗赛步兵25', '摘要': '机甲大师实验室-27赛季-对抗赛-步兵-材料费-第二十五笔',
    '金额合计': 123.45, '锁定时间': new Date('2026-09-25T10:00:00+08:00').getTime(),
    '接取人': '陈嘉豪', '收款方': '', '收款账号': '',
  } },
  '27备赛20步兵5': { record_id: 'bat5', fields: {
    '批次号': '27备赛20步兵5', '摘要': '',
    '金额合计': 10, '锁定时间': Date.now(), '接取人': '', '收款方': '陈杨明', '收款账号': '6216613200015262463',
  } },
};
collectStore.findBatchByName = async (name) => batches[name] || null;

async function main() {
  // ---------- 单元：网格工具 ----------
  assert.equal(ledgerSheetService.findRowBySummary(grid, '机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔'), 4, '按摘要精确匹配（1 基行号）');
  assert.equal(ledgerSheetService.findRowBySummary(grid, '不存在的摘要'), 0);
  assert.equal(ledgerSheetService.lastNonEmptyRow(grid), 4, '最后非空数据行');
  assert.deepEqual(await ledgerSheetService.resolveSheet(), { sheetId: 'shTest', rowCount: 100 }, '首工作表解析');
  assert.deepEqual(ledgerSheetService.findRowsBySummary(grid, '机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔'), [4], 'findRowsBySummary 单命中');
  assert.deepEqual(ledgerSheetService.findRowsBySummary(grid, '不存在的摘要'), []);

  // ---------- resolveSheet：显式 LEDGER_SHEET_ID 也查元信息取真实行数（复查 P2：不再硬编码 500） ----------
  config.ledger.sheetId = 'shTest';
  assert.deepEqual(await ledgerSheetService.resolveSheet(), { sheetId: 'shTest', rowCount: 100 }, '显式 LEDGER_SHEET_ID 分支取 grid_properties.row_count');
  config.ledger.sheetId = 'shMissing';
  await assert.rejects(() => ledgerSheetService.resolveSheet(), /不在该电子表格的工作表清单中/, '配置了不存在的 sheet_id 如实报错');
  config.ledger.sheetId = '';

  // ---------- submit：追加行（收款方/收款账号回退默认、经办人=接取人、状态沿用财务词表） ----------
  writes = [];
  const r1 = await ledgerSheetService.syncOnSubmit('27对抗赛步兵25');
  assert.equal(r1.action, 'appended');
  assert.equal(r1.rowIndex, 5, '追加到首个空行');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].range, 'shTest!A5:M5');
  const row = writes[0].values[0];
  assert.equal(row.length, 13, '一行 13 列（照实表 A..M）');
  assert.equal(row[0], 3, '序号=上一行+1');
  assert.equal(row[1], '', '投递单号未带 → 留空财务补');
  assert.equal(row[2], '机甲大师实验室-27赛季-对抗赛-步兵-材料费-第二十五笔');
  assert.equal(row[3], 123.45);
  assert.equal(row[4], '02520011130031');
  assert.equal(row[5], '转卡');
  assert.equal(row[6], '贺韵洁', '收款方缺省回退报销人');
  assert.equal(row[7], '6228480477161786579');
  assert.equal(row[8], '陈嘉豪', '经办人=接取人');
  assert.equal(row[9], '2026/9/25', '申请日期=锁定日（人工填写风格）');
  assert.equal(row[11], '', '入账日期留空');
  assert.equal(row[12], '已提交至中心', '状态沿用财务词表');

  // ---------- submit：幂等（摘要已存在不重复追加）+ 投递单号补填 ----------
  writes = [];
  const r2 = await ledgerSheetService.syncOnSubmit('27对抗赛步兵25');
  assert.equal(r2.action, 'exists', '摘要已存在 → 跳过');
  assert.equal(r2.rowIndex, 5);
  assert.equal(writes.length, 0, '幂等路径不写表');
  const r2b = await ledgerSheetService.syncOnSubmit('27对抗赛步兵25', '8367064');
  assert.equal(r2b.updated, 'deliveryNo', '存量行补填投递单号');
  assert.equal(writes[0].range, 'shTest!B5:B5');
  assert.equal(writes[0].values[0][0], 8367064, '纯数字投递单号写数值（同实表）');

  // ---------- submit：批次带收款方 → 覆盖默认 ----------
  batches['27对抗赛步兵25'].fields['收款方'] = '陈杨明';
  batches['27对抗赛步兵25'].fields['收款账号'] = '6216613200015262463';
  batches['27对抗赛步兵25'].fields['摘要'] = '机甲大师实验室-27赛季-对抗赛-步兵-材料费-第二十六笔';
  writes = [];
  const r3 = await ledgerSheetService.syncOnSubmit('27对抗赛步兵25');
  assert.equal(r3.rowIndex, 6);
  assert.equal(writes[0].values[0][6], '陈杨明', '批次收款方优先');
  assert.equal(writes[0].values[0][7], '6216613200015262463');

  // ---------- paid：按摘要回填入账日期+已到账 ----------
  writes = [];
  const r4 = await ledgerSheetService.syncOnStatus('27对抗赛步兵25', { paid: true });
  assert.equal(r4.action, 'updated');
  assert.equal(r4.rowIndex, 6);
  assert.equal(writes[0].range, 'shTest!L6:M6');
  assert.match(writes[0].values[0][0], /^\d{4}\/\d{1,2}\/\d{1,2}$/, '入账日期格式');
  assert.equal(writes[0].values[0][1], '已到账');

  // ---------- reject：标记已退回 ----------
  writes = [];
  const r5 = await ledgerSheetService.syncOnStatus('27对抗赛步兵25', { rejected: true });
  assert.equal(writes[0].range, 'shTest!M6:M6');
  assert.equal(writes[0].values[0][0], '已退回');

  // ---------- not_found：摘要对不上不误写 ----------
  batches['27对抗赛步兵25'].fields['摘要'] = '被人工改过的摘要';
  const r6 = await ledgerSheetService.syncOnStatus('27对抗赛步兵25', { paid: true });
  assert.equal(r6.action, 'not_found', '找不到行如实上报');
  assert.equal(writes.length, 1, 'not_found 不产生写入');

  // ---------- no_summary：老批次无摘要不进台账 ----------
  const r7 = await ledgerSheetService.syncOnSubmit('27备赛20步兵5');
  assert.equal(r7.action, 'no_summary');

  // ---------- 并发互斥（安全审查 #3）：两个 submit 同时追加，必须落在不同行 ----------
  batches['27对抗赛无人机26'] = { record_id: 'bat26', fields: { '批次号': '27对抗赛无人机26', '摘要': '机甲大师实验室-27赛季-对抗赛-无人机-材料费-第二十六笔', '金额合计': 50, '锁定时间': Date.now(), '接取人': '贺韵洁', '收款方': '', '收款账号': '' } };
  batches['27对抗赛重装27'] = { record_id: 'bat27', fields: { '批次号': '27对抗赛重装27', '摘要': '机甲大师实验室-27赛季-对抗赛-重装-材料费-第二十七笔', '金额合计': 60, '锁定时间': Date.now(), '接取人': '贺韵洁', '收款方': '', '收款账号': '' } };
  writes = [];
  const realRequestAPI = client.requestAPI;
  let readDelayArmed = true;
  client.requestAPI = async (method, urlPath, body) => {
    // 首次读网格延迟 50ms，制造 await 交错窗口：无互斥时两个调用会算出同一追加行
    if (readDelayArmed && method === 'GET' && urlPath.includes('/values/')) {
      readDelayArmed = false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return realRequestAPI(method, urlPath, body);
  };
  try {
    const [c1, c2] = await Promise.all([
      ledgerSheetService.syncOnSubmit('27对抗赛无人机26'),
      ledgerSheetService.syncOnSubmit('27对抗赛重装27'),
    ]);
    assert.equal(c1.action, 'appended');
    assert.equal(c2.action, 'appended');
    assert.notEqual(c1.rowIndex, c2.rowIndex, `互斥下两次追加必须落在不同行（实际 ${c1.rowIndex}/${c2.rowIndex}）`);
    assert.deepEqual([c1.rowIndex, c2.rowIndex].sort((a, b) => a - b), [7, 8], '串行化：第二次写入看到第一次的结果');
  } finally {
    client.requestAPI = realRequestAPI;
  }

  // ---------- disabled：未配置 token 时整体关闭 ----------
  config.ledger.spreadsheetToken = '';
  const r8 = await ledgerSheetService.syncOnSubmit('27对抗赛步兵25');
  assert.equal(r8.action, 'disabled');
  config.ledger.spreadsheetToken = 'tok_ledger_test';

  // ---------- 不存在的批次 ----------
  await assert.rejects(() => ledgerSheetService.syncOnSubmit('不存在的批次'), /批次不存在/);

  // ==================== 2026-09-27 对抗审查批新增断言 ====================

  // ---------- ambiguous：摘要命中多行转人工，绝不猜行（复查 P2） ----------
  const dupSummary = '机甲大师实验室-27赛季-对抗赛-无人机-材料费-第二十六笔';
  batches['27对抗赛无人机26'].fields['摘要'] = dupSummary;
  grid.push([9, null, dupSummary, 50, '02520011130031', '转卡', '贺韵洁', '6228480477161786579', '贺韵洁', '2026/9/26', null, null, '已提交至中心']);
  writes = [];
  const ambSubmit = await ledgerSheetService.syncOnSubmit('27对抗赛无人机26');
  assert.equal(ambSubmit.action, 'ambiguous', 'submit 摘要多行 → ambiguous');
  assert.equal(ambSubmit.rows, 2, 'ambiguous 带命中行数');
  assert.equal(writes.length, 0, 'ambiguous 不产生写入');
  const ambStatus = await ledgerSheetService.syncOnStatus('27对抗赛无人机26', { paid: true });
  assert.equal(ambStatus.action, 'ambiguous', 'status 摘要多行 → ambiguous');
  assert.equal(writes.length, 0, 'ambiguous 状态回填也不写表');
  const ambReject = await ledgerSheetService.syncOnStatus('27对抗赛无人机26', { rejected: true });
  assert.equal(ambReject.action, 'ambiguous');
  grid.pop(); // 移除重复行，恢复单命中

  // ---------- ledger 子指令模式（chatService 层）：paid/reject 补回填 L/M 列（复查 P2 缺口） ----------
  delete require.cache[require.resolve('../src/services/chatService')];
  const chatService = require('../src/services/chatService');
  // 摘要恢复到 grid 第 6 行实值（此前 not_found 用例改成了人工摘要）
  batches['27对抗赛步兵25'].fields['摘要'] = '机甲大师实验室-27赛季-对抗赛-步兵-材料费-第二十六笔';
  writes = [];
  const ledPaid = await chatService.executeCommand('/approval-batch', ['ledger', 'paid', '27对抗赛步兵25']);
  assert.match(ledPaid, /台账已回填：入账日期 \+ 已到账/, 'ledger paid 模式回执');
  assert.equal(writes[0].range, 'shTest!L6:M6', 'ledger paid 模式回填 L/M 列');
  assert.equal(writes[0].values[0][1], '已到账');
  writes = [];
  const ledReject = await chatService.executeCommand('/approval-batch', ['ledger', 'reject', '27对抗赛步兵25']);
  assert.match(ledReject, /台账已标记：已退回/, 'ledger reject 模式回执');
  assert.equal(writes[0].range, 'shTest!M6:M6', 'ledger reject 模式只标记 M 列');
  const ledDefault = await chatService.executeCommand('/approval-batch', ['ledger', '27对抗赛步兵25']);
  assert.match(ledDefault, /台账已有该批次行/, 'ledger 首参非模式 → 默认 submit（幂等 exists）');
  // paid 模式 not_found：批次真实存在但台账无该摘要行
  batches['27无台账批次'] = { record_id: 'batNL', fields: { '批次号': '27无台账批次', '摘要': '机甲大师实验室-27赛季-对抗赛-步兵-材料费-第九百九十九笔', '金额合计': 1 } };
  const ledNotFound = await chatService.executeCommand('/approval-batch', ['ledger', 'paid', '27无台账批次']);
  assert.match(ledNotFound, /台账未找到该批次行/, 'paid 模式 not_found 如实上报');

  // ---------- ambiguous 的 chatService 回执 ----------
  grid.push([9, null, dupSummary, 50, '02520011130031', '转卡', '贺韵洁', '6228480477161786579', '贺韵洁', '2026/9/26', null, null, '已提交至中心']);
  const ambReply = await chatService.executeCommand('/approval-batch', ['ledger', 'paid', '27对抗赛无人机26']);
  assert.match(ambReply, /台账存在多行同摘要，请人工处理/, 'ambiguous 回执提示人工处理');
  grid.pop();
}

(async () => {
  await main();
  console.log('✅ stub-test-ledger 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-ledger 失败:', err);
  process.exit(1);
});
