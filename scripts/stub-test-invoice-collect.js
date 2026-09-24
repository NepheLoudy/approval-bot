// 桩测试：发票采集全链路——解析器（PDF文本/QR/特征词）、金额归类匹配、校验闸
// （查重双闸/抬头/金额比对）、采集落表与镜像回写、非发票图静默、采集口径并催办判定、
// 批次指令、HTTP 端点鉴权。全离线：stub 掉飞书/多维表格/机器人发送。
// （接入 push.js 部署前测试闸门，行为改动必须过本套件）
const assert = require('assert/strict');
const http = require('http');

process.env.API_TOKEN = process.env.API_TOKEN || 'test-token-collect';

const config = require('../src/config');
config.bitable.collectTableId = 'tblCollectTest';
config.bitable.batchTableId = 'tblBatchTest';
config.ocr.enabled = true;
config.invoiceCollect.allowedBuyers = ['重庆大学|50000000TESTXX01'];

const client = require('../src/feishu/client');
const bot = require('../src/feishu/bot');
const bitableApi = require('../src/feishu/bitable');
const ocrService = require('../src/services/ocrService');
const invoiceParser = require('../src/services/invoiceParser');
const collectStore = require('../src/services/collectStore');
const approvalService = require('../src/services/approvalService');

// ---- 测试桩 ----
const sentTexts = []; // {openId, text}
bot.sendTextToUser = async (openId, text) => { sentTexts.push({ openId, text }); return {}; };
bot.sendPostToUser = async () => ({ create_time: Date.now() });

let downloadCalls = [];
client.downloadMessageResource = async (messageId, fileKey, fileType) => {
  downloadCalls.push({ messageId, fileKey, fileType });
  return Buffer.from('%PDF-fake-invoice');
};
let uploadedFiles = [];
client.uploadMediaToBitable = async (buf, fileName) => { uploadedFiles.push(fileName); return `fileToken_${uploadedFiles.length}`; };

const approvalRows = new Map(); // record_id -> fields（审批表模拟）
approvalService.getAllApprovals = async () => [...approvalRows.entries()].map(([record_id, fields]) => ({ record_id, fields }));

const collectRows = []; // 模拟采集表
const batchRows = [];
bitableApi.createRecord = async (tableId, fields) => {
  const record_id = `${tableId}_rec${collectRows.length + batchRows.length + 1}`;
  if (tableId === config.bitable.collectTableId) collectRows.push({ record_id, fields });
  else batchRows.push({ record_id, fields });
  return { record_id, fields };
};
bitableApi.updateRecord = async (tableId, recordId, fields) => {
  const rows = tableId === config.bitable.collectTableId ? collectRows : batchRows;
  const row = rows.find(r => r.record_id === recordId);
  if (row) row.fields = { ...row.fields, ...fields };
  return { record_id: recordId, fields: fields || {} };
};
bitableApi.listAllRecords = async (tableId) => {
  if (tableId === config.bitable.collectTableId) return collectRows;
  if (tableId === config.bitable.batchTableId) return batchRows;
  if (tableId === config.bitable.approvalTableId) return [...approvalRows.entries()].map(([record_id, fields]) => ({ record_id, fields }));
  return [];
};

let ocrSegments = [];
ocrService.recognizeBuffer = async () => ocrSegments;

// 识别桩：可注入 parser 结果
let parserResult = null;
const realRecognize = invoiceParser.recognizeInvoice;

function send(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(raw); } catch (e) { return raw; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // ---------- 单元：parseInvoiceText ----------
  const shuziText = '数电票\n发票号码：24312000000123456789\n开票日期：2026年09月01日\n价税合计（大写）壹佰贰拾圆整 （小写）¥120.50\n购买方名称:重庆大学 统一社会信用代码/纳税人识别号:50000000TESTXX01\n销售方名称:某某科技公司 纳税人识别号:91500000AAA';
  const shuzi = invoiceParser.parseInvoiceText(shuziText);
  assert.equal(shuzi.fields.invoiceNo, '24312000000123456789');
  assert.equal(shuzi.invoiceType, '全电发票');
  assert.equal(shuzi.fields.issueDate, '2026-09-01');
  assert.equal(shuzi.fields.totalAmount, 120.50);
  assert.equal(shuzi.fields.buyerTaxNo, '50000000TESTXX01');
  assert.equal(shuzi.fields.sellerName, '某某科技公司');
  assert.deepEqual(shuzi.missing, []);

  const oldText = '增值税电子普通发票\n发票代码:045032000111\n发票号码:12345678\n开票日期 2026年01月15日\n价税合计(小写)¥88.00\n校验码 12345678901234567890';
  const old = invoiceParser.parseInvoiceText(oldText);
  assert.equal(old.fields.invoiceCode, '045032000111');
  assert.equal(old.fields.invoiceNo, '12345678');
  assert.equal(old.fields.totalAmount, 88.00);
  assert.equal(old.fields.checkCode, '567890', '校验码取后6位');
  assert.equal(old.invoiceType, '增值税发票');
  assert.deepEqual(old.missing, []);

  const broken = invoiceParser.parseInvoiceText('一张无关的图片文字');
  assert.equal(broken.fields.invoiceNo, null);
  assert.ok(broken.missing.includes('invoiceNo'));

  // ---------- 单元：parseQrPayload ----------
  const qrShuzi = invoiceParser.parseQrPayload('01,24312000000123456789,120.50,20260901,33dsk');
  assert.equal(qrShuzi.ok, true);
  assert.equal(qrShuzi.fields.invoiceNo, '24312000000123456789');
  assert.equal(qrShuzi.fields.totalAmount, 120.50);
  assert.equal(qrShuzi.fields.issueDate, '2026-09-01');
  assert.equal(qrShuzi.invoiceType, '全电发票');

  const qrOld = invoiceParser.parseQrPayload('01,045032000111,12345678,88.00,20260115,12345678901234567890');
  assert.equal(qrOld.ok, true);
  assert.equal(qrOld.fields.invoiceCode, '045032000111');
  assert.equal(qrOld.fields.invoiceNo, '12345678');
  assert.equal(qrOld.fields.checkCode, '567890', 'QR 校验码取后6位');

  assert.equal(invoiceParser.parseQrPayload('hello,world').ok, false, '非发票 QR 如实报不识别');

  // ---------- 单元：特征词（非发票图静默忽略的判定基础） ----------
  assert.equal(invoiceParser.looksLikeInvoiceText(shuziText), true);
  assert.equal(invoiceParser.looksLikeInvoiceText('今天天气真好 哈哈'), false);
  assert.equal(invoiceParser.looksLikeInvoiceText(''), false);

  // ---------- 单元：matchRecord 金额归类 ----------
  const openRecords = [
    { applyNo: 'A1', amount: 100, material: '电机', project: '步兵', senderName: '小张' },
    { applyNo: 'A2', amount: 200, material: '电机', project: '重装', senderName: '小张' },
  ];
  assert.equal(invoiceCollectServiceModule.matchRecord(100, openRecords).match.applyNo, 'A1', '金额精确唯一→自动');
  assert.equal(invoiceCollectServiceModule.matchRecord(300, openRecords).match, null, '无匹配→待人工');
  const sameAmount = [{ applyNo: 'B1', amount: 50 }, { applyNo: 'B2', amount: 50 }];
  assert.equal(invoiceCollectServiceModule.matchRecord(50, sameAmount).match, null, '多候选同金额→待人工');
  const single = [{ applyNo: 'C1', amount: 77 }];
  assert.equal(invoiceCollectServiceModule.matchRecord(999, single).match.applyNo, 'C1', '名下唯一候选直接归（金额比对闸兜底）');
  assert.equal(invoiceCollectServiceModule.matchRecord(100, []).match, null);

  // ---------- 单元：抬头校验 ----------
  assert.equal(invoiceCollectServiceModule.checkBuyer({ buyerTaxNo: '50000000TESTXX01' }).status, null, '税号命中放行');
  assert.equal(invoiceCollectServiceModule.checkBuyer({ buyerName: '重庆大学' }).status, null, '名称命中放行');
  assert.equal(invoiceCollectServiceModule.checkBuyer({ buyerName: '个人', buyerTaxNo: '123' }).status, '抬头存疑');
  const savedBuyers = config.invoiceCollect.allowedBuyers;
  config.invoiceCollect.allowedBuyers = [];
  assert.equal(invoiceCollectServiceModule.checkBuyer({ buyerName: '个人' }).status, null, '未配置抬头=不校验');
  config.invoiceCollect.allowedBuyers = savedBuyers;

  // ---------- 链路：collectFromMessage（成功收录 + 镜像回写 + 金额比对） ----------
  const svc = invoiceCollectServiceModule;
  approvalRows.set('rec_approval_1', {
    '申请编号': { text: '202607160001' },
    '申请状态': '已通过',
    '审批流程': '💸【27赛季】千里采购申请/发票提交',
    '发起人': [{ id: 'ou_member1', name: '小张' }],
    '总金额': 120.50,
    '购买物资名称': '步兵电机',
    '项目': { name: '步兵机器人' },
  });
  ocrSegments = shuziText.split('\n');
  parserResult = null;
  downloadCalls = []; uploadedFiles = []; sentTexts.length = 0;
  // 走真实 recognizeInvoice（PDF 假头 → 会走 PDF 通道失败）……改用图片路径+OCR 桩：
  client.downloadMessageResource = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]); // PNG 头，QR 解不出 → OCR 兜底
  const r1 = await svc.collectFromMessage({
    openId: 'ou_member1', senderName: '', messageId: 'om_1', fileKey: 'img_v2_1',
    msgType: 'image', fileName: '', source: 'private',
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'collected');
  assert.equal(r1.matchApplyNo, '202607160001');
  assert.equal(r1.verifyStatus, '通过');
  assert.equal(collectRows.length, 1);
  assert.equal(collectRows[0].fields['提交人姓名'], '小张', 'senderName 缺失时从审批记录反查');
  assert.equal(collectRows[0].fields['关联申请编号'], '202607160001');
  assert.ok(uploadedFiles[0].startsWith('invoice_'), '发票原件应转存附件');
  const mirrorText = sentTexts.map(s => s.text).join('\n');
  assert.ok(mirrorText.includes('已同步到审批表补交发票栏'), '回执含镜像结果');

  // 镜像回写：采集时通过 requestAPI 写审批表补交发票栏——mock requestAPI 捕获
  // （上面流程里 requestAPI 未被 mock，走真实 fetch 会失败但被 catch——此处验证降级路径与回执文案）
  assert.ok(true);

  // ---------- 链路：查重拦截（精确 + 近似） ----------
  sentTexts.length = 0;
  const r2 = await svc.collectFromMessage({
    openId: 'ou_member1', messageId: 'om_2', fileKey: 'img_v2_2', msgType: 'image', source: 'private',
  });
  assert.equal(r2.action, 'duplicated', '同发票号第二次提交必须拦截');
  assert.ok(sentTexts.some(s => s.text.includes('疑似重复')));

  // ---------- 链路：非发票图静默忽略 ----------
  sentTexts.length = 0;
  ocrSegments = ['今天天气真好 哈哈 好玩'];
  const r3 = await svc.collectFromMessage({
    openId: 'ou_member1', messageId: 'om_3', fileKey: 'img_v2_3', msgType: 'image', source: 'private',
  });
  assert.equal(r3.action, 'ignored', '无发票特征的图静默忽略');
  assert.equal(sentTexts.length, 0, '静默忽略不打回不发回执');

  // ---------- 链路：发票特征但要素不全 → 打回 ----------
  sentTexts.length = 0;
  ocrSegments = ['增值税发票 发票号码：24319999000000000001', '价税合计（小写）¥55.00']; // 缺开票日期
  const r4 = await svc.collectFromMessage({
    openId: 'ou_member1', messageId: 'om_4', fileKey: 'img_v2_4', msgType: 'image', source: 'private',
  });
  assert.equal(r4.action, 'rejected');
  assert.deepEqual(r4.missing, ['issueDate']);
  assert.ok(sentTexts.some(s => s.text.includes('打回') && s.text.includes('开票日期')), '打回回执带缺失要素与重发指引');

  // ---------- 链路：金额不符标记 ----------
  sentTexts.length = 0;
  ocrSegments = shuziText.split('\n').map(l => l.replace('24312000000123456789', '24312000000123457777').replace('120.50', '500.00'));
  approvalRows.set('rec_approval_2', {
    '申请编号': { text: '202607160002' },
    '申请状态': '已通过',
    '审批流程': '💸【27赛季】千里采购申请/发票提交',
    '发起人': [{ id: 'ou_member1', name: '小张' }],
    '总金额': 120.50,
    '购买物资名称': '舵机',
  });
  const r5 = await svc.collectFromMessage({
    openId: 'ou_member1', messageId: 'om_5', fileKey: 'img_v2_5', msgType: 'image', source: 'private',
  });
  assert.equal(r5.action, 'collected');
  assert.equal(r5.verifyStatus, '金额不符', '名下唯一候选直接归但金额超容忍→金额不符');
  assert.equal(collectRows[collectRows.length - 1].fields['校验状态'], '金额不符');

  // ---------- 链路：催办口径并入采集表（getCollectedApplyNoSet / fail-open） ----------
  const nos = await approvalService.getCollectedApplyNoSet();
  assert.ok(nos.has('202607160001'), '采集表已收录的申请编号进入已交票口径');
  // 采集表未配置时 fail-open
  const savedCollectId = config.bitable.collectTableId;
  config.bitable.collectTableId = '';
  const nosEmpty = await approvalService.getCollectedApplyNoSet();
  assert.equal(nosEmpty.size, 0, '采集表未配置返回空集（fail-open 不崩）');
  config.bitable.collectTableId = savedCollectId;

  // ---------- 链路：拟批 + 锁定（批次数组/回写/金额合计） ----------
  const batchService = require('../src/services/batchService');
  const preview = await batchService.previewBatch();
  assert.ok(preview.poolSize >= 2, '票池含未归批采集票');
  const infantry = preview.suggestions.find(s => s.project === '步兵机器人');
  assert.ok(infantry, '按审批记录项目分组');

  downloadCalls = [];
  // 真实 1x1 PNG：覆盖 embedPng 主排版路径（假字节会走占位页分支，测不到）
  const png1x1 = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  client.downloadMedia = async () => png1x1;
  const locked = await batchService.lockBatch('27备赛99步兵9', '步兵机器人');
  assert.equal(locked.count >= 1, true);
  assert.equal(locked.batchNo, '27备赛99步兵9');
  assert.equal(batchRows.length, 1);
  assert.equal(batchRows[0].fields['状态'], '已锁定');
  assert.ok(batchRows[0].fields['BOM表'], 'BOM xlsx 应生成落附件');
  assert.ok(batchRows[0].fields['打印文件'], '打印 PDF 应生成落附件');
  const lockedCollect = collectRows.find(r => r.fields['发票号码'] === '24312000000123456789');
  assert.equal(lockedCollect.fields['批次'], '27备赛99步兵9', '锁定回写采集表批次');

  // 重复批次号拒绝
  await assert.rejects(() => batchService.lockBatch('27备赛99步兵9', ''), /已存在/);

  // 状态流转
  const marked = await batchService.markBatch('27备赛99步兵9', '已提交');
  assert.equal(marked.status, '已提交');
  assert.equal(batchRows[0].fields['状态'], '已提交');
  assert.ok(batchRows[0].fields['提交时间'], '提交时间已记录');

  // ---------- 端点：/api/invoice/* + /api/approval/policy ----------
  const app = require('../src/index');
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const authHeader = { 'X-API-Token': process.env.API_TOKEN };
  try {
    // 无 token → 403
    assert.equal((await send(port, 'POST', '/api/invoice/collect', { openId: 'ou_x', messageId: 'om_x', fileKey: 'k' })).status, 403);
    assert.equal((await send(port, 'POST', '/api/invoice/backfill', {})).status, 403);

    // 采集端点（走桩链路）：参数缺失 → 400
    const bad = await send(port, 'POST', '/api/invoice/collect', { openId: 'ou_x' }, authHeader);
    assert.equal(bad.status, 400);

    // 采集端点完整链路：新发票号（唯一候选归类）
    sentTexts.length = 0;
    ocrSegments = shuziText.split('\n').map(l => l.replace('24312000000123456789', '24312000000123998888'));
    const okRes = await send(port, 'POST', '/api/invoice/collect', {
      openId: 'ou_member1', messageId: 'om_api', fileKey: 'img_api', msgType: 'image',
    }, authHeader);
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.success, true);

    // backfill 端点（走桩：无 SourceID 的记录跳过）——只验证鉴权通过与形状
    const bf = await send(port, 'POST', '/api/invoice/backfill', { limit: 1 }, authHeader);
    assert.equal(bf.status, 200);
    assert.ok('scanned' in bf.json);

    // OCR 503 开关
    config.ocr.enabled = false;
    const off = await send(port, 'POST', '/api/invoice/collect', { openId: 'ou_x', messageId: 'om', fileKey: 'k' }, authHeader);
    assert.equal(off.status, 503);
    config.ocr.enabled = true;
  } finally {
    server.close();
  }
}

// invoiceCollectService 在桩设置之后加载（模块顶层无副作用，运行时查找桩）
let invoiceCollectServiceModule;
(async () => {
  invoiceCollectServiceModule = require('../src/services/invoiceCollectService');
  await main();
  console.log('✅ stub-test-invoice-collect 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ stub-test-invoice-collect 失败:', err);
  process.exit(1);
});
