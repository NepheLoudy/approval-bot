// 桩测试：报销交付包——大写金额/中文序号、摘要拼装、归档文件夹名、
// 校格式物料清单 xlsx（严格照《物料清单》模板排版）、投递底单 xlsx（照投递单字段）、
// 批次接取（claimBatch 状态机）。全离线：stub 掉飞书上传。
// 运行：node scripts/stub-test-delivery.js
const assert = require('assert/strict');

const config = require('../src/config');
config.bitable.collectTableId = 'tblCollectTest';
config.bitable.batchTableId = 'tblBatchTest';
// 摘要拼装口径照实样（机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔）
config.batch.season = '27赛季';
// 标黄断言需要确定的「未配置」基线（真实 .env 可能已填 CQ_* 实值，测试内固定清空）
config.batch.reporterStuId = '';
config.batch.reporterName = '';
config.batch.reporterPhone = '';
config.batch.projectCode = '';
config.batch.projectName = '';
config.batch.projectDept = '';
config.batch.projectLeader = '';
config.batch.bankCardNo = '';
config.batch.bankName = '';
config.batch.preparer = '';

const client = require('../src/feishu/client');
const collectStore = require('../src/services/collectStore');

// ---- 上传桩：捕获 (fileName, buffer) ----
const uploaded = [];
client.uploadMediaToBitable = async (buf, fileName) => {
  uploaded.push({ fileName, buffer: buf });
  return `fileToken_${uploaded.length}`;
};

async function main() {
  const { numToCnyUpper, numToCnOrdinal } = require('../src/utils/cny');
  const ExcelJS = require('exceljs');

  // ---------- 单元：大写金额（投递底单「大写金额」列） ----------
  const cnyCases = [
    [237.04, '贰佰叁拾柒圆零肆分'],
    [237, '贰佰叁拾柒圆整'],
    [60, '陆拾圆整'],
    [113.51, '壹佰壹拾叁圆伍角壹分'],
    [3.97, '叁圆玖角柒分'],
    [0.5, '伍角'],
    [0.05, '伍分'],
    [100, '壹佰圆整'],
    [12000, '壹万贰仟圆整'],
    [10005, '壹万零伍圆整'],
  ];
  for (const [n, want] of cnyCases) {
    assert.equal(numToCnyUpper(n), want, `大写金额 ${n}`);
  }
  assert.equal(numToCnyUpper(-1), '', '非法金额返回空（留白人工补）');

  // ---------- 单元：中文序号（摘要「第N笔」） ----------
  const ordCases = [[1, '一'], [3, '三'], [10, '十'], [11, '十一'], [20, '二十'], [24, '二十四'], [100, '一百'], [105, '一百零五'], [110, '一百一十'], [111, '一百一十一']];
  for (const [n, want] of ordCases) {
    assert.equal(numToCnOrdinal(n), want, `中文序号 ${n}`);
  }

  const batchService = require('../src/services/batchService');

  // ---------- 单元：摘要拼装（照投递单实样） ----------
  assert.equal(
    batchService.composeSummary({ project: '对抗赛', purpose: '飞镖机器人', ordinal: 24 }),
    '机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔',
    '摘要拼装严格照实样段序'
  );

  // ---------- 单元：归档文件夹名（照财务实样命名） ----------
  const sep20 = new Date('2026-09-20T12:00:00+08:00').getTime();
  assert.equal(
    batchService.buildArchiveFolderName({ dateMs: sep20, project: '对抗赛', purpose: '飞镖', ordinal: 24, amount: 237.04 }),
    '20260920-对抗赛-飞镖-第二十四笔-237.04',
    '归档名严格照实样'
  );
  assert.ok(batchService.buildArchiveFolderName({ project: 'A/B', purpose: 'x', amount: 1 }).includes('A-B'), '项目含 / 替换（Windows 非法字符）');

  // ---------- 生成器：校格式物料清单（严格照模板：标题合并/表头/列序/总金额/制单人） ----------
  const items = [
    { invoiceNo: '24312000000123456789', totalAmount: 52.93, invoiceContent: '*电子元件*存储器', invoiceType: '全电发票', invoiceCode: '', sellerName: '深圳市立创电子商务有限公司', issueDateMs: new Date('2026-09-20T00:00:00+08:00').getTime() },
    { invoiceNo: '24312000000123459999', totalAmount: 60, invoiceContent: '', invoiceType: '全电发票', invoiceCode: '', sellerName: '深圳市金芯源半导体有限公司', issueDateMs: new Date('2026-09-17T00:00:00+08:00').getTime() },
  ];
  uploaded.length = 0;
  await batchService.uploadBatchMaterialList('27对抗赛飞镖24', items, { purpose: '飞镖机器人', purchaseType: '机器人零件' });
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].fileName, '报销单_27对抗赛飞镖24_物料清单.xlsx', '物料清单文件名');

  const wb1 = new ExcelJS.Workbook();
  await wb1.xlsx.load(uploaded[0].buffer);
  const ws1 = wb1.getWorksheet('Sheet1');
  assert.ok(ws1, '工作表名 Sheet1（同模板）');
  assert.equal(ws1.getCell('A1').value, '物料清单', 'A1 标题');
  assert.deepEqual(ws1.model.merges.map(String), ['A1:E1'], '标题 A1:E1 合并（同模板）');
  assert.deepEqual(
    ws1.getRow(2).values.slice(1),
    ['序号', '项目', '金额', '用途', '采购类型'],
    '表头严格照模板'
  );
  assert.deepEqual(
    ws1.getRow(3).values.slice(1),
    [1, '*电子元件*存储器', 52.93, '飞镖机器人', '机器人零件'],
    '数据行：项目列=开票内容、用途/采购类型按参数'
  );
  const missingCell = ws1.getRow(4).getCell(2);
  assert.equal(missingCell.value, '', '缺开票内容 → 项目列留空');
  assert.equal(missingCell.fill && missingCell.fill.fgColor && missingCell.fill.fgColor.argb, 'FFFFFF00', '缺开票内容 → 标黄');
  const totalLabel = ws1.getRow(5).getCell(2);
  assert.equal(totalLabel.value, '总金额：', '总金额行标签');
  assert.equal(totalLabel.alignment && totalLabel.alignment.horizontal, 'right', '总金额标签右对齐（同模板）');
  const totalCell = ws1.getRow(5).getCell(3);
  assert.equal(totalCell.formula, 'SUM(C3:C4)', '总金额 SUM 公式（同模板）');
  assert.equal(totalCell.result, 112.93, '公式缓存结果');
  assert.equal(ws1.getRow(6).getCell(2).value, '制单人：', '制单人行标签');

  // ---------- 生成器：投递底单（照投递单字段全预填 + 电子发票明细） ----------
  uploaded.length = 0;
  const summary = batchService.composeSummary({ project: '对抗赛', purpose: '飞镖机器人', ordinal: 24 });
  await batchService.uploadBatchDeliverySheet('27对抗赛飞镖24', items, { purpose: '飞镖机器人', ordinal: 24, summary });
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].fileName, '报销单_27对抗赛飞镖24_投递底单.xlsx', '投递底单文件名');

  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(uploaded[0].buffer);
  const ws2 = wb2.getWorksheet('投递底单');
  // 表单区：label(A 列) → value(B 列) 映射
  const form = {};
  let detailHeadRow = 0;
  for (let r = 1; r <= ws2.rowCount; r++) {
    const label = ws2.getRow(r).getCell(1).value;
    if (label === '发票代码') { detailHeadRow = r; break; }
    if (label) form[label] = ws2.getRow(r).getCell(2).value;
  }
  for (const key of ['投递号', '填报时间', '公章', '报销人工号', '姓名', '联系电话', '项目编号', '项目所属部门', '项目名称', '项目负责人', '团队负责人', '摘要', '附件张数', '备注', '费用项', '报销金额', '申请总金额', '大写金额', '财务核准报销金额', '支付方式', '收款人工号', '收款人姓名', '卡号', '开户行', '金额']) {
    assert.ok(key in form, `投递底单含字段「${key}」（照投递单全字段）`);
  }
  assert.equal(form['摘要'], summary, '摘要预填');
  assert.equal(form['大写金额'], '壹佰壹拾贰圆玖角叁分', '大写金额自动转换');
  assert.equal(form['附件张数'], 2, '附件张数=张数');
  assert.equal(form['支付方式'], '转卡', '支付方式=转卡');
  assert.equal(form['费用项'], '实验室用品', '费用项默认（config）');
  // 缺失配置标黄（测试环境 CQ_* 未配置）
  const stuRow = (() => {
    for (let r = 1; r <= ws2.rowCount; r++) {
      if (ws2.getRow(r).getCell(1).value === '报销人工号') return ws2.getRow(r).getCell(2);
    }
  })();
  assert.equal(stuRow.fill && stuRow.fill.fgColor && stuRow.fill.fgColor.argb, 'FFFFFF00', '报销人工号缺失 → 标黄');
  // 明细区：表头 + 每票一行（发票代码=数电票映射）
  assert.ok(detailHeadRow > 0, '电子发票明细表头存在');
  assert.deepEqual(
    ws2.getRow(detailHeadRow).values.slice(1, 8),
    ['发票代码', '发票号码', '开票单位', '开票日期', '开票内容', '发票金额', '是否已认证'],
    '明细表头照投递单'
  );
  const d1 = ws2.getRow(detailHeadRow + 1).values.slice(1, 8);
  assert.equal(d1[0], '数电票', '全电发票 → 发票代码「数电票」');
  assert.equal(d1[1], '24312000000123456789');
  assert.equal(d1[2], '深圳市立创电子商务有限公司', '开票单位=销售方名称');
  assert.equal(d1[3], '2026-09-20', '开票日期格式 YYYY-MM-DD');
  assert.equal(d1[6], '', '认证状态留空（学校系统生成）');
  const d2 = ws2.getRow(detailHeadRow + 2).getCell(5);
  assert.equal(d2.fill && d2.fill.fgColor && d2.fill.fgColor.argb, 'FFFFFF00', '明细缺开票内容 → 标黄');

  // ---------- 链路：批次接取（claimBatch 状态机） ----------
  const batchRows = [
    { record_id: 'bat1', fields: { '批次号': '27对抗赛飞镖23', '项目': '对抗赛', '状态': '已提交', '张数': 3, '金额合计': 100 } },
    { record_id: 'bat2', fields: { '批次号': '27对抗赛飞镖24', '项目': '对抗赛', '状态': '已锁定', '锁定时间': 100, '张数': 6, '金额合计': 237.04, '摘要': summary } },
    { record_id: 'bat3', fields: { '批次号': '27备赛20步兵5', '项目': '步兵机器人', '状态': '已锁定', '锁定时间': 200, '张数': 1, '金额合计': 10 } },
  ];
  collectStore.listBatches = async () => batchRows;
  collectStore.findBatchByName = async (name) => batchRows.find(b => String(b.fields['批次号']) === String(name)) || null;
  const updates = [];
  collectStore.updateBatch = async (recordId, fields) => {
    const row = batchRows.find(b => b.record_id === recordId);
    if (row) row.fields = { ...row.fields, ...fields };
    updates.push({ recordId, fields });
    return { record_id: recordId };
  };

  // 不带批次号 → 接最近锁定的未接取批次（bat3 锁定时间更新）
  const t1 = await batchService.claimBatch('', '贺韵洁');
  assert.equal(t1.batchNo, '27备赛20步兵5', '默认接取最近锁定的未接取批次');
  assert.equal(t1.taker, '贺韵洁');
  assert.equal(updates[0].fields['接取人'], '贺韵洁', '接取人落表');
  assert.ok(updates[0].fields['接取时间'] > 0, '接取时间落表');

  // 重复接取（同一人）幂等；他人接取报错
  const t2 = await batchService.claimBatch('27备赛20步兵5', '贺韵洁');
  assert.equal(t2.reClaim, true, '同人重复接取幂等');
  await assert.rejects(() => batchService.claimBatch('27备赛20步兵5', '王财务'), /已由 贺韵洁 接取/, '他人重复接取报错');
  assert.equal(updates.length, 1, '幂等路径不重复写表');

  // 已提交批次不可接取；不存在批次报错；无未接取批次报错
  await assert.rejects(() => batchService.claimBatch('27对抗赛飞镖23', '贺韵洁'), /仅【已锁定】批次可接取/);
  await assert.rejects(() => batchService.claimBatch('不存在的批次', '贺韵洁'), /批次不存在/);
  await assert.rejects(async () => {
    await batchService.claimBatch('27对抗赛飞镖24', '贺韵洁'); // 唯一剩余未接取 → 成功
    await batchService.claimBatch('', '别人'); // 此后无未接取 → 报错
  }, /没有待接取/);

  // ---------- 安全审查 #2：操作人实名反查（open_id 优先于自报名）+ markBatch 留痕 ----------
  const contacts = require('../src/feishu/contacts');
  const chatService = require('../src/services/chatService');
  const realListUsers = contacts.listActiveUsers;
  contacts.listActiveUsers = async () => new Map([['ou_hh', '贺韵洁'], ['ou_cj', '陈嘉豪']]);
  const verified = await chatService.resolveOperator({ senderId: 'ou_hh', senderName: '冒名者' });
  assert.equal(verified.operator, '贺韵洁', 'open_id 反查实名优先于自报名（防冒名）');
  assert.equal(verified.verified, true);
  const unknown = await chatService.resolveOperator({ senderId: 'ou_ghost', senderName: '自报名' });
  assert.equal(unknown.operator, '自报名', '查无此人如实降级为自报名');
  assert.equal(unknown.verified, false);
  contacts.listActiveUsers = async () => { throw new Error('通讯录挂了'); };
  const failOpen = await chatService.resolveOperator({ senderId: 'ou_hh', senderName: '自报名' });
  assert.equal(failOpen.operator, '自报名', '通讯录失败 fail-open 回落自报名');
  assert.equal(failOpen.verified, false);
  const noIdentity = await chatService.resolveOperator({});
  assert.equal(noIdentity.operator, '', '无身份不编造操作人');
  contacts.listActiveUsers = realListUsers;

  const mbOp = await batchService.markBatch('27备赛20步兵5', '已提交', '陈嘉豪');
  assert.equal(mbOp.status, '已提交');
  const mbRow = batchRows.find(b => b.record_id === 'bat3');
  assert.equal(mbRow.fields['最后操作人'], '陈嘉豪', '操作留痕落表');
  assert.ok(mbRow.fields['最后操作时间'] > 0, '操作时间落表');
  await batchService.markBatch('27备赛20步兵5', '已到账', '');
  assert.equal(mbRow.fields['最后操作人'], '陈嘉豪', '无身份调用不覆盖既有留痕');
  // status 总览带操作人
  const overview = await batchService.batchOverview();
  const opRow = overview.find(b => b.batchNo === '27备赛20步兵5');
  assert.equal(opRow.operator, '陈嘉豪', '总览含最后操作人');
}

(async () => {
  await main();
  console.log('✅ stub-test-delivery 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-delivery 失败:', err);
  process.exit(1);
});
