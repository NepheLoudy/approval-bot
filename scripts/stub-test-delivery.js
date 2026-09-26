// 桩测试：报销交付包——大写金额/中文序号、摘要拼装、归档文件夹名、
// 校格式物料清单 xlsx（严格照《物料清单》模板排版）、投递底单 xlsx（照投递单字段）、
// 批次接取（claimBatch 状态机）。全离线：stub 掉飞书上传。
// 运行：node scripts/stub-test-delivery.js
const assert = require('assert/strict');

const config = require('../src/config');
config.bitable.appToken = 'appTokenTest';
config.bitable.collectTableId = 'tblCollectTest';
config.bitable.batchTableId = 'tblBatchTest';
// 交付卡表链接断言需要确定性的租户子域（真实 .env 可能已配 FEISHU_TENANT_BASE_URL）
config.feishu.tenantBaseUrl = 'https://test-tenant.feishu.cn';
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

// ---- 打印件占位文本提取（pdf-lib 内容流 Flate 压缩 + 文本 hex 编码；
//      解压后按流在文件中的先后 = 页序，用于断言打印件顺序） ----
function pdfSlotLines(buf) {
  const zlib = require('zlib');
  const lines = [];
  let idx = 0;
  while (true) {
    const start = buf.indexOf('stream', idx);
    if (start < 0) break;
    let s0 = start + 6;
    while (s0 < buf.length && (buf[s0] === 13 || buf[s0] === 10)) s0++; // 跳过 EOL
    const end = buf.indexOf('endstream', s0);
    if (end < 0) break;
    try {
      const content = zlib.inflateSync(buf.slice(s0, end)).toString('latin1');
      for (const m of content.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const text = Buffer.from(m[1], 'hex').toString('latin1');
        if (text.startsWith('Slot ')) lines.push(text);
      }
    } catch (e) { /* 对象流/交叉引用流非页面内容，跳过 */ }
    idx = end + 9;
  }
  return lines;
}

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

  // ---------- 状态机（复查 P1-3）：非法流转拒绝，终态不可再流转 ----------
  await assert.rejects(
    () => batchService.markBatch('27备赛20步兵5', '已退回', ''),
    /当前【已到账】，合法去向【无（终态，不可再流转）】/,
    '已到账再 reject 必须拒绝（防重复报销）'
  );
  assert.equal(mbRow.fields['状态'], '已到账', '非法流转不落表');
  await assert.rejects(
    () => batchService.markBatch('27对抗赛飞镖24', '已到账', ''),
    /当前【已锁定】，合法去向【已提交\/已退回】/,
    '已锁定不得直跳已到账（漏了已提交）'
  );
  assert.equal(batchRows.find(b => b.record_id === 'bat2').fields['状态'], '已锁定', '非法流转不落表');

  // ---------- 乱序入库两票（复查 P1-8）：regen 后打印件顺序=采集时间序 ----------
  const bitableApi = require('../src/feishu/bitable');
  bitableApi.listAllRecords = async () => []; // 审批表空 → 项目回落「未归类」
  // 采集表里后扫的票先入库（乱序），打印件必须按采集时间排回录入序
  const regenRows = [
    { record_id: 'col_late', fields: { '发票号码': '999999', '价税合计': 60, '采集时间': 200, '批次': '27乱序批次1' } },
    { record_id: 'col_early', fields: { '发票号码': '111111', '价税合计': 52.93, '采集时间': 100, '批次': '27乱序批次1' } },
  ];
  collectStore.listCollect = async () => regenRows;
  batchRows.push({ record_id: 'bat_regen', fields: { '批次号': '27乱序批次1', '项目': '未归类', '状态': '已锁定', '笔序': 1, '摘要': '' } });
  uploaded.length = 0;
  await batchService.regenerateBatchFiles('27乱序批次1');
  const regenPdf = uploaded.find(u => u.fileName === '报销单_27乱序批次1_打印件.pdf');
  assert.ok(regenPdf, 'regen 生成打印件 PDF');
  const slots = pdfSlotLines(regenPdf.buffer);
  assert.equal(slots.length, 2, '两票各占一个票位');
  assert.ok(slots[0].includes('no.111111'), `先采集的票排在前（实际 ${slots[0]}）`);
  assert.ok(slots[1].includes('no.999999'), `后采集的票排在后（实际 ${slots[1]}）`);

  // ---------- lock 回执含锁定人 + 批次记录留痕（复查 P2-4）；打标失败暴露（复查 P2-6） ----------
  const bot = require('../src/feishu/bot');
  const sentCards = [];
  bot.sendMessage = async (msg) => { sentCards.push(msg); return {}; };
  // chatService 顶层解构了 bot 的函数引用，须清缓存重载才能吃到发送桩
  delete require.cache[require.resolve('../src/services/chatService')];
  const chatServiceFresh = require('../src/services/chatService');
  contacts.listActiveUsers = async () => new Map([['ou_hh', '贺韵洁']]);
  const poolRows = [
    { record_id: 'col_p1', fields: { '发票号码': '555555', '价税合计': 11, '采集时间': 300 } },
    { record_id: 'col_p2', fields: { '发票号码': '666666', '价税合计': 22, '采集时间': 400 } },
  ];
  collectStore.listCollect = async () => poolRows;
  collectStore.createBatch = async (fields) => {
    const row = { record_id: `bat_new${batchRows.length + 1}`, fields };
    batchRows.push(row);
    return row;
  };
  // col_p1 故意回写失败 → 验证打标失败在回执与批次备注都暴露（复查 P2-6）
  collectStore.updateCollect = async (recordId, fields) => {
    if (recordId === 'col_p1') throw new Error('模拟回写失败');
    const row = poolRows.find(r => r.record_id === recordId);
    if (row) row.fields = { ...row.fields, ...fields };
    return { record_id: recordId };
  };
  const lockReply = await chatServiceFresh.executeCommand('/approval-batch', ['lock', '27回执批次9'], { senderId: 'ou_hh', senderName: '冒名者' });
  assert.match(lockReply, /✅ 批次已锁定：27回执批次9/);
  assert.ok(lockReply.includes('· 👤 锁定人：贺韵洁'), `锁定回执含实名锁定人（实际：${lockReply}）`);
  const lockRow = batchRows.find(b => b.fields['批次号'] === '27回执批次9');
  assert.equal(lockRow.fields['最后操作人'], '贺韵洁', '批次记录含最后操作人（open_id 实名反查，非自报「冒名者」）');
  assert.ok(lockRow.fields['最后操作时间'] > 0, '批次记录含最后操作时间');
  assert.ok(lockReply.includes('1 张打标失败'), '打标失败在回执暴露');
  assert.ok(String(lockRow.fields['备注'] || '').includes('1 张打标失败'), '打标失败记入批次备注');
  assert.equal(sentCards.length, 1, '交付卡已发送');
  assert.ok(
    JSON.stringify(sentCards[0]).includes('https://test-tenant.feishu.cn/base/appTokenTest'),
    '交付卡表链接带租户子域（复查 P2-13）'
  );

  // ---------- 并发「接取」互斥（复查 P2-5）：同时抢只能各自落到不同批次 ----------
  lockRow.fields['状态'] = '已提交'; // 27回执批次9 挪出待接取池，让并发测试只抢下面两批
  batchRows.push(
    { record_id: 'bat_c1', fields: { '批次号': '27并发批次1', '项目': '未归类', '状态': '已锁定', '锁定时间': 300, '张数': 1, '金额合计': 1 } },
    { record_id: 'bat_c2', fields: { '批次号': '27并发批次2', '项目': '未归类', '状态': '已锁定', '锁定时间': 400, '张数': 1, '金额合计': 2 } },
  );
  const [claimA, claimB] = await Promise.all([
    batchService.claimBatch('', '张三'),
    batchService.claimBatch('', '李四'),
  ]);
  assert.notEqual(claimA.batchNo, claimB.batchNo, '并发接取必须落在不同批次（互斥）');
  assert.deepEqual([claimA.batchNo, claimB.batchNo].sort(), ['27并发批次1', '27并发批次2'], '两个待接取批次都被领走');

  // ==================== 2026-09-27 对抗审查批新增断言 ====================

  // ---------- 中文序号 n>999：返回空串走数字兜底（复查 P2，消灭「第undefined百」） ----------
  assert.equal(numToCnOrdinal(999), '九百九十九', '999 仍在中文序号区间');
  assert.equal(numToCnOrdinal(1000), '', 'n>999 返回空串（composeSummary 回落「第N笔」数字兜底）');
  assert.equal(batchService.composeSummary({ project: '对抗赛', purpose: '飞镖机器人', ordinal: 1000 }).endsWith('第1000笔'), true, '序号越界摘要走数字兜底');

  // ---------- BOM：校验状态空值渲染「未校验」+ 工作表名对批次号消毒（复查 P2） ----------
  uploaded.length = 0;
  await batchService.uploadBatchBom('27批次A/B:C', [
    { invoiceNo: 'BOM1', totalAmount: 10, verifyStatus: '' },
    { invoiceNo: 'BOM2', totalAmount: 20, verifyStatus: '通过' },
  ]);
  const wbBom = new ExcelJS.Workbook();
  await wbBom.xlsx.load(uploaded[0].buffer);
  const wsBom = wbBom.getWorksheet('BOM-27批次ABC');
  assert.ok(wsBom, 'BOM 工作表名已消毒（剥批次号中的 / : 等非法字符）');
  // 表头经 ws.columns 定义占第 1 行，数据行自第 2 行起
  assert.equal(wsBom.getRow(2).getCell(10).value, '未校验', '校验状态空值渲染「未校验」而非「通过」');
  assert.equal(wsBom.getRow(3).getCell(10).value, '通过', '已有校验状态原样渲染');

  // ---------- 采集行解析：千分位逗号金额 + 金额异常计入 warningCount（复查 P2） ----------
  const prevListCollect = collectStore.listCollect;
  collectStore.listCollect = async () => [
    { record_id: 'amt1', fields: { '发票号码': 'AMT1', '价税合计': '1,234.56', '采集时间': 1 } },
    { record_id: 'amt2', fields: { '发票号码': 'AMT2', '价税合计': 'abc', '采集时间': 2 } },
  ];
  const pv = await batchService.previewBatch();
  assert.equal(pv.poolSize, 2);
  const pvGroup = pv.suggestions[0];
  assert.equal(pvGroup.amount, 1234.56, '千分位逗号金额正确解析（parseFloat 前去逗号）');
  assert.equal(pvGroup.warningCount, 2, '「未校验」空值 + 金额异常均计入 warningCount');
  collectStore.listCollect = prevListCollect;

  // ---------- 投递底单金额格标黄（金额解析失败/<=0 的票，复查 P2） ----------
  uploaded.length = 0;
  await batchService.uploadBatchDeliverySheet('27金额异常批次', [
    { invoiceNo: 'AMT2', totalAmount: 0, amountInvalid: true, sellerName: 'x', issueDateMs: 0, invoiceContent: '有内容' },
  ], {});
  const wbAmt = new ExcelJS.Workbook();
  await wbAmt.xlsx.load(uploaded[0].buffer);
  const wsAmt = wbAmt.getWorksheet('投递底单');
  let amtYellow = false;
  for (let r = 1; r <= wsAmt.rowCount; r++) {
    if (wsAmt.getRow(r).getCell(2).value === 'AMT2') {
      const c = wsAmt.getRow(r).getCell(6);
      amtYellow = Boolean(c.fill && c.fill.fgColor && c.fill.fgColor.argb === 'FFFFFF00');
    }
  }
  assert.ok(amtYellow, '投递底单金额异常票的金额格标黄');

  // ---------- 投递底单收款方走 meta（复查 P1：lock 收款方= 覆盖要进底单，账实不分离） ----------
  uploaded.length = 0;
  await batchService.uploadBatchDeliverySheet('27对抗赛飞镖24', items, { purpose: '飞镖机器人', ordinal: 24, summary, payee: '陈杨明', payeeAccount: '6216613200015262463' });
  const wbPayee = new ExcelJS.Workbook();
  await wbPayee.xlsx.load(uploaded[0].buffer);
  const wsPayee = wbPayee.getWorksheet('投递底单');
  const payeeForm = {};
  for (let r = 1; r <= wsPayee.rowCount; r++) {
    const label = wsPayee.getRow(r).getCell(1).value;
    if (label && label !== '发票代码') payeeForm[label] = wsPayee.getRow(r).getCell(2).value;
  }
  assert.equal(payeeForm['收款人姓名'], '陈杨明', '收款人姓名=meta.payee（lock 收款方= 覆盖）');
  assert.equal(payeeForm['卡号'], '6216613200015262463', '卡号=meta.payeeAccount（lock 收款账号= 覆盖）');

  // ---------- regen：收款方从批次记录读回进底单 + 金额漂移暴露（复查 P1） ----------
  bitableApi.listAllRecords = async () => []; // 审批表空 → 项目回落「未归类」
  const driftRows = [
    { record_id: 'd1', fields: { '发票号码': 'D1', '价税合计': 52.93, '采集时间': 10, '批次': '27漂移批次1' } },
    { record_id: 'd2', fields: { '发票号码': 'D2', '价税合计': 60, '采集时间': 20, '批次': '27漂移批次1' } },
  ];
  collectStore.listCollect = async () => driftRows;
  batchRows.push({
    record_id: 'bat_drift',
    fields: { '批次号': '27漂移批次1', '项目': '未归类', '状态': '已锁定', '笔序': 1, '金额合计': 999, '收款方': '陈杨明', '收款账号': '6216613200015262463' },
  });
  uploaded.length = 0;
  const driftRes = await batchService.regenerateBatchFiles('27漂移批次1');
  assert.deepEqual(
    driftRes.amountDrift && { recorded: driftRes.amountDrift.recorded, current: Math.round(driftRes.amountDrift.current * 100) / 100 },
    { recorded: 999, current: 112.93 },
    'regen 金额与锁定值不一致时返回 amountDrift{recorded,current}'
  );
  const driftSheet = uploaded.find(u => u.fileName === '报销单_27漂移批次1_投递底单.xlsx');
  assert.ok(driftSheet, 'regen 生成投递底单');
  const wbDrift = new ExcelJS.Workbook();
  await wbDrift.xlsx.load(driftSheet.buffer);
  const wsDrift = wbDrift.getWorksheet('投递底单');
  const driftForm = {};
  for (let r = 1; r <= wsDrift.rowCount; r++) {
    const label = wsDrift.getRow(r).getCell(1).value;
    if (label && label !== '发票代码') driftForm[label] = wsDrift.getRow(r).getCell(2).value;
  }
  assert.equal(driftForm['收款人姓名'], '陈杨明', 'regen 底单收款方从批次记录读回（非 .env 默认）');
  assert.equal(driftForm['卡号'], '6216613200015262463', 'regen 底单卡号从批次记录读回');

  // ---------- 不同批次号并发 lock 共享票池：pool 锁互斥，不双计（复查 P1） ----------
  // （无项目过滤=锁整池：修复前两把锁各自快照同一池，两张票同时进两个批次记录
  //   → 双金额双张数；修复后 pool 锁串行，先到者锁走整池，后到者看到空池如实报错）
  const sharedPool = [
    { record_id: 'sh1', fields: { '发票号码': 'SH1', '价税合计': 10, '采集时间': 100 } },
    { record_id: 'sh2', fields: { '发票号码': 'SH2', '价税合计': 20, '采集时间': 200 } },
  ];
  collectStore.listCollect = async () => sharedPool;
  collectStore.updateCollect = async (recordId, fields) => {
    const row = sharedPool.find(r => r.record_id === recordId);
    if (row) row.fields = { ...row.fields, ...fields };
    return { record_id: recordId };
  };
  const [lockARes, lockBRes] = await Promise.allSettled([
    batchService.lockBatch('27并发锁批次1', '', {}),
    batchService.lockBatch('27并发锁批次2', '', {}),
  ]);
  const won = lockARes.status === 'fulfilled' ? lockARes : lockBRes;
  const lost = lockARes.status === 'fulfilled' ? lockBRes : lockARes;
  assert.equal(lost.status, 'rejected', '并发双锁共享池：后到者必须失败');
  assert.match(lost.reason && lost.reason.message, /票池中没有可锁定的发票/, '失败原因=池已被锁空（非静默双计）');
  assert.equal(won.value.count, 2, '赢家整池锁定（2 张只记 1 批，不双计）');
  assert.ok(
    sharedPool.every(r => String(r.fields['批次'] || '') === won.value.batchNo),
    '每张票只进赢家批次（批次标记归一）'
  );
  const wonRow = batchRows.find(b => b.fields['批次号'] === won.value.batchNo);
  assert.equal(wonRow.fields['张数'], 2, '赢家批次记录张数=2');
  assert.equal(wonRow.fields['金额合计'], 30, '赢家批次记录金额合计=30（无重复累加）');

  // ---------- 并发 paid+reject 仅一成功（markBatch 全程批次锁，复查 P1 TOCTOU） ----------
  batchRows.push({ record_id: 'bat_cc', fields: { '批次号': '27并发状态批次', '项目': '未归类', '状态': '已提交', '张数': 1, '金额合计': 5 } });
  const [paidRes, rejRes] = await Promise.allSettled([
    batchService.markBatch('27并发状态批次', '已到账', ''),
    batchService.markBatch('27并发状态批次', '已退回', ''),
  ]);
  const fulfilled = [paidRes, rejRes].filter(x => x.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, '并发 paid+reject 仅一成功');
  const ccRow = batchRows.find(b => b.record_id === 'bat_cc');
  assert.equal(ccRow.fields['状态'], fulfilled[0].value.status, '落表状态=成功方（无一成功两写）');
  await assert.rejects(
    () => batchService.markBatch('27并发状态批次', ccRow.fields['状态'] === '已到账' ? '已退回' : '已到账', ''),
    /终态，不可再流转/,
    '赢家确立后另一方按状态机拒绝'
  );

  // ---------- reject 幂等重入 + 回票失败暴露（复查 P1-3：中断不再永久卡死） ----------
  const rejRow = { record_id: 'bat_rej', fields: { '批次号': '27中断退回批次', '项目': '未归类', '状态': '已退回', '张数': 1, '金额合计': 5 } };
  batchRows.push(rejRow);
  // 场景 1：上次 reject 中断，仍有票挂着批次 → 重入继续回票
  collectStore.listCollect = async () => [{ record_id: 'c_rej', fields: { '发票号码': 'R1', '价税合计': 5, '批次': '27中断退回批次', '采集时间': 9 } }];
  collectStore.updateCollect = async (recordId, fields) => {
    return { record_id: recordId, fields };
  };
  const re1 = await batchService.markBatch('27中断退回批次', '已退回', '');
  assert.equal(re1.returnedToPool, 1, '已退回→已退回幂等重入继续回票');
  // 场景 2：已无挂批票 → 重入视为完成 no-op
  collectStore.listCollect = async () => [];
  const re2 = await batchService.markBatch('27中断退回批次', '已退回', '');
  assert.equal(re2.returnedToPool, 0, '无挂批票后重入为 no-op');
  // 场景 3：单票回写失败 → 收集进 returnFailed + 批次备注，不再整批卡死
  collectStore.listCollect = async () => [{ record_id: 'c_fail', fields: { '发票号码': 'F1', '价税合计': 5, '批次': '27中断退回批次', '采集时间': 9 } }];
  collectStore.updateCollect = async (recordId) => {
    if (recordId === 'c_fail') throw new Error('模拟回写失败');
    return { record_id: recordId };
  };
  const re3 = await batchService.markBatch('27中断退回批次', '已退回', '');
  assert.equal(re3.returnFailed.length, 1, '回票失败进 returnFailed 清单');
  assert.ok(String(rejRow.fields['备注'] || '').includes('回票失败'), '回票失败记入批次备注');
  // 已退回仍不可跳到已到账（幂等重入仅限「已退回→已退回」）
  await assert.rejects(() => batchService.markBatch('27中断退回批次', '已到账', ''), /终态，不可再流转/);

  // ---------- 项目名含 '/'：笔序按「项目」字段精确匹配（复查 P2，防摘要重复） ----------
  const slashProject = '对抗赛/飞镖';
  bitableApi.listAllRecords = async () => [
    { record_id: 'ap1', fields: { '申请编号': { text: 'AP1' }, '项目': { name: slashProject } } },
  ];
  // 审批表「报销单」栏回写打桩（真实 updateRecord 会带本地 .env 凭据打真接口，严禁）
  const approvalWrites = [];
  bitableApi.updateRecord = async (tableId, recordId, fields) => {
    approvalWrites.push({ tableId, recordId, fields });
    return { record_id: recordId };
  };
  const slashCollects = [
    { record_id: 'sp1', fields: { '发票号码': 'SP1', '价税合计': 30, '采集时间': 300, '关联申请编号': 'AP1' } },
    { record_id: 'sp2', fields: { '发票号码': 'SP2', '价税合计': 40, '采集时间': 400, '关联申请编号': 'AP1' } },
  ];
  collectStore.updateCollect = async (recordId, fields) => {
    const row = slashCollects.find(x => x.record_id === recordId);
    if (row) row.fields = { ...row.fields, ...fields };
    return { record_id: recordId };
  };
  // 每把锁单独给一张票（无项目过滤=锁整池，两票同项目则第二把锁会看到空池）
  collectStore.listCollect = async () => [slashCollects[0]];
  const slashA = await batchService.lockBatch('27斜杠批次1', '', {});
  assert.equal(slashA.ordinal, 1, '斜杠项目首批笔序 1');
  assert.equal(slashA.projects.join('/'), slashProject);
  assert.equal(slashA.approvalWritten, 1, '带申请编号的票回写审批表报销单栏');
  assert.deepEqual(approvalWrites[0] && approvalWrites[0].fields, { '报销单': '27斜杠批次1' }, '报销单栏写入批次号');
  collectStore.listCollect = async () => [slashCollects[1]];
  const slashB = await batchService.lockBatch('27斜杠批次2', '', {});
  assert.equal(slashB.ordinal, 2, '斜杠项目第二批笔序 2（旧 split 逻辑恒 1 → 摘要重复）');
  assert.notEqual(slashA.summary, slashB.summary, '两批摘要不重复（台账匹配安全）');

  // ---------- regen 回执带金额漂移警示（chatService 层，复查 P1） ----------
  collectStore.listCollect = async () => driftRows; // 斜杠项目测试覆盖过 listCollect，指回漂移批次采集行
  const driftReply = await chatServiceFresh.executeCommand('/approval-batch', ['regen', '27漂移批次1']);
  assert.match(driftReply, /⚠️ regen 后金额合计 ¥112\.93 与批次锁定值 ¥999\.00 不一致/, 'regen 回执带金额漂移警示');
  assert.ok(
    String(batchRows.find(b => b.record_id === 'bat_drift').fields['备注'] || '').includes('regen 后金额与锁定值不一致'),
    '金额漂移记入批次备注'
  );

  // ---------- 资金指令白名单（复查 P1：APPROVAL_FUND_OPERATOR_IDS 配置后名单外拒绝） ----------
  config.fundOperatorIds = ['ou_hh'];
  const denyLock = await chatServiceFresh.executeCommand('/approval-batch', ['lock', '27白名单批次'], { senderId: 'ou_other', senderName: '外人' });
  assert.match(denyLock, /未获资金指令权限/, '白名单外 lock 被拒');
  const denyPaid = await chatServiceFresh.executeCommand('/approval-batch', ['paid', '27并发状态批次'], { senderId: 'ou_other' });
  assert.match(denyPaid, /未获资金指令权限/, '白名单外 paid 被拒');
  // 放行路径：名单内 open_id 正常锁定（给票池补一张可锁的票）
  collectStore.listCollect = async () => [{ record_id: 'wl1', fields: { '发票号码': 'WL1', '价税合计': 5, '采集时间': 600 } }];
  const allowLock = await chatServiceFresh.executeCommand('/approval-batch', ['lock', '27白名单内批次'], { senderId: 'ou_hh', senderName: '贺韵洁' });
  assert.match(allowLock, /✅ 批次已锁定：27白名单内批次/, '白名单内放行');
  config.fundOperatorIds = []; // 还原：未配置=不限

  // ---------- 接取回执透传 verified（复查 P2：未经通讯录校验要标注） ----------
  batchRows.push({ record_id: 'bat_take', fields: { '批次号': '27接取批次1', '项目': '未归类', '状态': '已锁定', '锁定时间': 500, '张数': 1, '金额合计': 1 } });
  const takeReply = await chatServiceFresh.executeCommand('接取', ['27接取批次1'], { senderId: 'ou_ghost', senderName: '自报人' });
  assert.match(takeReply, /未经通讯录校验/, '接取回执标注未经通讯录校验');
  assert.match(takeReply, /自报人/, '回执仍显示自报名（fail-open 口径不变）');

  // ---------- 交付卡注入消毒（复查 P2：剥 <at> 与链接语法） ----------
  const evilCard = bot.buildDeliveryCard({
    batchNo: '27消毒批次1',
    project: '<at id="ou_evil">evil</at>A/B',
    summary: '前缀[点我领奖](https://evil.example)后缀',
    count: 1, amount: 1, generated: {},
  });
  const evilStr = JSON.stringify(evilCard);
  assert.ok(!evilStr.includes('<at'), '交付卡剥 <at> 标记');
  assert.ok(!evilStr.includes('https://evil.example'), '交付卡剥链接 URL');
  assert.ok(evilStr.includes('点我领奖'), '链接文本保留');
}

(async () => {
  await main();
  console.log('✅ stub-test-delivery 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-delivery 失败:', err);
  process.exit(1);
});
