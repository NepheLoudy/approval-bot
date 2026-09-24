// 桩测试：发票 OCR 转录——规则引擎（anchor 三种 take / occurrence / regex）、
// OCR 调用契约（路径/入参/错误透出）、规则窗口热改与持久化、HTTP 端点鉴权
// 全离线：stub 掉飞书 requestAPI/downloadImage；规则文件写临时文件，跑完即删
// （接入 push.js 部署前测试闸门，行为改动必须过本套件）
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.API_TOKEN = process.env.API_TOKEN || 'test-token-ocr'; // dotenv 不覆盖已设 env，端点鉴权用本值

const config = require('../src/config');
const FIELDS_FILE = path.join(os.tmpdir(), `ocr-fields-test-${process.pid}-${Date.now()}.json`);
config.ocr.fieldsFile = FIELDS_FILE;
config.ocr.enabled = true;

const client = require('../src/feishu/client');
const ocrService = require('../src/services/ocrService');

// ---- 测试桩 ----
const FAKE_IMAGE = Buffer.from('fake-png-bytes-for-ocr-test');
let ocrCalls = [];      // requestAPI 捕获
let downloadCalls = []; // downloadImage 捕获
let fakeOcrResponse = { code: 0, data: { text_list: [] } };

client.requestAPI = async (method, urlPath, body, opts) => {
  ocrCalls.push({ method, urlPath, body, opts });
  return JSON.parse(JSON.stringify(fakeOcrResponse));
};
client.downloadImage = async (messageId, imageKey) => {
  downloadCalls.push({ messageId, imageKey });
  return Buffer.from(FAKE_IMAGE);
};

function httpRequest(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = raw;
        try { json = JSON.parse(raw); } catch (err) { /* 非 JSON 响应保留原文 */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // ---------- 单元：validateRules ----------
  assert.equal(ocrService.validateRules([{ key: 'a', label: '甲', type: 'anchor', keywords: ['k'] }]).ok, true);
  assert.equal(ocrService.validateRules([{ key: '非法-key', label: '甲', type: 'anchor', keywords: ['k'] }]).ok, false);
  assert.equal(ocrService.validateRules([
    { key: 'a', label: '甲', type: 'anchor', keywords: ['k'] },
    { key: 'a', label: '乙', type: 'anchor', keywords: ['k'] },
  ]).ok, false, 'key 重复必须拒绝');
  assert.equal(ocrService.validateRules([{ key: 'a', label: '甲', type: 'anchor' }]).ok, false, 'anchor 缺 keywords 必须拒绝');
  assert.equal(ocrService.validateRules([{ key: 'a', label: '甲', type: 'regex', pattern: '([' }]).ok, false, '非法 pattern 必须拒绝');
  assert.equal(ocrService.validateRules([{ key: 'a', label: '甲', type: 'weird' }]).ok, false);
  assert.equal(ocrService.validateRules([{ key: 'a', label: '甲', type: 'anchor', keywords: ['k'], take: 'bad' }]).ok, false);
  assert.equal(ocrService.validateRules('not-array').ok, false);

  // ---------- 单元：extractFields ----------
  // anchor + take same（同段冒号后取值）
  const rulesSame = [{ key: 'invoice_no', label: '发票号码', type: 'anchor', keywords: ['发票号码'], take: 'same' }];
  assert.deepEqual(ocrService.extractFields(['发票号码:24312000000123456789'], rulesSame).fields,
    { invoice_no: '24312000000123456789' });
  // 全角冒号 + 空白清洗
  assert.deepEqual(ocrService.extractFields(['开票日期： 2026年09月01日 '],
    [{ key: 'd', label: '开票日期', type: 'anchor', keywords: ['开票日期'], take: 'same' }]).fields,
    { d: '2026年09月01日' });
  // anchor + same_or_next（本段无值取下一段，跨段形态）
  const segBuyer = ['购买方名称', '北京某某科技有限公司', '统一社会信用代码:91110000TEST12345X'];
  assert.deepEqual(ocrService.extractFields(segBuyer,
    [{ key: 'buyer', label: '购买方名称', type: 'anchor', keywords: ['购买方名称'], take: 'same_or_next' }]).fields,
    { buyer: '北京某某科技有限公司' });
  // anchor + take next（强制下一段）
  assert.deepEqual(ocrService.extractFields(['购买方名称', '北京某某科技有限公司'],
    [{ key: 'buyer', label: '购买方名称', type: 'anchor', keywords: ['购买方名称'], take: 'next' }]).fields,
    { buyer: '北京某某科技有限公司' });
  // anchor + take same 本段无值 → null（不跨段）
  assert.deepEqual(ocrService.extractFields(['大写', '壹佰元整'],
    [{ key: 'x', label: 'X', type: 'anchor', keywords: ['大写'], take: 'same' }]).fields,
    { x: null });
  // occurrence：同名标签第 N 次命中（买方/卖方税号同标签）
  const segTax = ['购买方 销售方', '统一社会信用代码:91110000AAAA', '统一社会信用代码:91110000BBBB'];
  assert.deepEqual(ocrService.extractFields(segTax,
    [{ key: 'tax', label: '税号', type: 'anchor', keywords: ['统一社会信用代码'], take: 'same', occurrence: 1 }]).fields,
    { tax: '91110000AAAA' });
  assert.deepEqual(ocrService.extractFields(segTax,
    [{ key: 'tax', label: '税号', type: 'anchor', keywords: ['统一社会信用代码'], take: 'same', occurrence: 2 }]).fields,
    { tax: '91110000BBBB' });
  // regex：金额捕获组
  const segTotal = ['价税合计(大写) 壹佰贰拾元整', '(小写)¥120.50'];
  assert.deepEqual(ocrService.extractFields(segTotal,
    [{ key: 'amount', label: '价税合计', type: 'regex', pattern: '[¥￥]\\s*([0-9,]+(?:\\.[0-9]+)?)' }]).fields,
    { amount: '120.50' });
  // regex 无捕获组 → 整个匹配
  assert.deepEqual(ocrService.extractFields(['NO.20260901'],
    [{ key: 'no', label: '编号', type: 'regex', pattern: 'NO\\.[0-9]+' }]).fields,
    { no: 'NO.20260901' });
  // 多关键词任一命中 / 全部未命中
  assert.deepEqual(ocrService.extractFields(['invoice number: 99'],
    [{ key: 'n', label: 'N', type: 'anchor', keywords: ['发票号码', 'invoice number'], take: 'same' }]).fields,
    { n: '99' });
  const missResult = ocrService.extractFields(['无关文本'], rulesSame);
  assert.equal(missResult.fields.invoice_no, null);
  assert.deepEqual(missResult.misses, ['invoice_no']);

  // ---------- 单元：recognizeBuffer（OCR 调用契约） ----------
  ocrCalls = [];
  fakeOcrResponse = { code: 0, data: { text_list: ['发票号码:1', '价税合计 ¥9.90'] } };
  const segments = await ocrService.recognizeBuffer(Buffer.from(FAKE_IMAGE));
  assert.equal(ocrCalls.length, 1);
  assert.equal(ocrCalls[0].method, 'POST');
  assert.equal(ocrCalls[0].urlPath, ocrService.OCR_API_PATH,
    '必须走 /open-apis/optical_char_recognition/v1/image/basic_recognize');
  assert.ok(Buffer.from(ocrCalls[0].body.image, 'base64').equals(FAKE_IMAGE), 'image 必须是图片的 base64');
  assert.equal(ocrCalls[0].opts.timeoutMs, config.ocr.timeoutMs);
  assert.deepEqual(segments, ['发票号码:1', '价税合计 ¥9.90']);

  // 飞书非 0 错误码如实透出（权限未开通等）
  fakeOcrResponse = { code: 99991672, msg: 'The app has no permission' };
  await assert.rejects(() => ocrService.recognizeBuffer(FAKE_IMAGE), /99991672.*no permission|no permission.*99991672/s);

  // 空/超限图片前置拒绝（不发 OCR 请求）
  const beforeRejected = ocrCalls.length;
  await assert.rejects(() => ocrService.recognizeBuffer(Buffer.alloc(0)), /图片内容为空/);
  const origMax = config.ocr.maxImageBytes;
  config.ocr.maxImageBytes = 4;
  await assert.rejects(() => ocrService.recognizeBuffer(FAKE_IMAGE), /超过上限/);
  config.ocr.maxImageBytes = origMax;
  assert.equal(ocrCalls.length, beforeRejected, '被拒绝的图片不得发起 OCR 请求');

  // 识别为空
  fakeOcrResponse = { code: 0, data: {} };
  await assert.rejects(() => ocrService.recognizeBuffer(FAKE_IMAGE), /未识别出文字/);

  // ---------- 单元：transcribe（两种入口 + 结果组装） ----------
  fakeOcrResponse = { code: 0, data: { text_list: ['发票号码:24312000000123456789', '价税合计(小写)¥9.90'] } };
  ocrCalls = []; downloadCalls = [];
  const byMessage = await ocrService.transcribe({ messageId: 'om_test_1', imageKey: 'img_v2_test' });
  assert.deepEqual(downloadCalls, [{ messageId: 'om_test_1', imageKey: 'img_v2_test' }]);
  assert.equal(byMessage.meta.source, 'message');
  assert.equal(byMessage.meta.bytes, FAKE_IMAGE.length);
  assert.equal(byMessage.fullText, '发票号码:24312000000123456789\n价税合计(小写)¥9.90');
  assert.equal(byMessage.fields.invoice_no, '24312000000123456789');
  assert.ok(Array.isArray(byMessage.segments) && byMessage.segments.length === 2);

  const byBase64 = await ocrService.transcribe({ imageBase64: FAKE_IMAGE.toString('base64') });
  assert.equal(downloadCalls.length, 1, 'base64 入口不得触发消息图片下载');
  assert.equal(byBase64.meta.source, 'base64');

  await assert.rejects(() => ocrService.transcribe({}), /缺少参数/);
  await assert.rejects(() => ocrService.transcribe({ messageId: 'om_x' }), /缺少参数/);

  // ---------- 单元：字段规则持久化与热改 ----------
  assert.ok(fs.existsSync(FIELDS_FILE), '首次加载应把内置默认规则落盘为种子文件');
  const seeded = JSON.parse(fs.readFileSync(FIELDS_FILE, 'utf8'));
  assert.ok(Array.isArray(seeded) && seeded.length === ocrService.DEFAULT_FIELD_RULES.length);

  const custom = [{ key: 'custom_field', label: '自定义', type: 'anchor', keywords: ['自定义标签'], take: 'next' }];
  const effective = ocrService.setFieldRules(custom);
  assert.equal(effective.length, 1);
  assert.deepEqual(ocrService.getFieldRules(), custom, 'set 后立即生效');
  assert.deepEqual(JSON.parse(fs.readFileSync(FIELDS_FILE, 'utf8')), custom, 'set 后同步落盘');
  assert.deepEqual(ocrService.extractFields(['自定义标签', '某值'], ocrService.getFieldRules()).fields,
    { custom_field: '某值' }, '热改后的规则直接参与提取');

  try { ocrService.setFieldRules([{ key: 'bad key!' }]); assert.fail('非法规则应抛出'); }
  catch (err) { assert.equal(err.statusCode, 400); }
  assert.deepEqual(ocrService.getFieldRules(), custom, '校验失败不得改动生效中的规则');

  const afterReset = ocrService.resetFieldRules();
  assert.equal(afterReset.length, ocrService.DEFAULT_FIELD_RULES.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(FIELDS_FILE, 'utf8')), afterReset);

  // ---------- 端点：/api/ocr/*（真实 HTTP，随机端口） ----------
  const app = require('../src/index');
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const authHeader = { 'X-API-Token': process.env.API_TOKEN };

  try {
    // 鉴权：写端点无 token 必须 403
    assert.equal((await httpRequest(port, 'POST', '/api/ocr/transcribe', { imageBase64: FAKE_IMAGE.toString('base64') })).status, 403);
    assert.equal((await httpRequest(port, 'POST', '/api/ocr/fields', { action: 'reset' })).status, 403);

    // transcribe 完整链路（message 入口）
    fakeOcrResponse = { code: 0, data: { text_list: ['发票号码:88'] } };
    ocrCalls = []; downloadCalls = [];
    const transcribeRes = await httpRequest(port, 'POST', '/api/ocr/transcribe',
      { messageId: 'om_api_1', imageKey: 'img_v2_api' }, authHeader);
    assert.equal(transcribeRes.status, 200);
    assert.equal(transcribeRes.json.success, true);
    assert.equal(transcribeRes.json.fields.invoice_no, '88');
    assert.deepEqual(downloadCalls, [{ messageId: 'om_api_1', imageKey: 'img_v2_api' }]);

    // 服务错误透出（OCR 报错 → 500 + 文案）
    fakeOcrResponse = { code: 230001, msg: 'internal error' };
    const errRes = await httpRequest(port, 'POST', '/api/ocr/transcribe',
      { imageBase64: FAKE_IMAGE.toString('base64') }, authHeader);
    assert.equal(errRes.status, 500);
    assert.match(errRes.json.error, /230001/);

    // 开关关闭 → 503
    config.ocr.enabled = false;
    const offRes = await httpRequest(port, 'POST', '/api/ocr/transcribe',
      { imageBase64: FAKE_IMAGE.toString('base64') }, authHeader);
    assert.equal(offRes.status, 503);
    config.ocr.enabled = true;

    // 字段规则窗口：读 / 非法 set / 合法 set / reset
    assert.equal((await httpRequest(port, 'GET', '/api/ocr/fields')).status, 200);
    assert.equal((await httpRequest(port, 'POST', '/api/ocr/fields', { action: 'bogus' }, authHeader)).status, 400);
    const setRes = await httpRequest(port, 'POST', '/api/ocr/fields',
      { action: 'set', rules: [{ key: 'f1', label: '字段一', type: 'anchor', keywords: ['K'], take: 'same' }] }, authHeader);
    assert.equal(setRes.status, 200);
    assert.equal(setRes.json.fields.length, 1);
    const resetRes = await httpRequest(port, 'POST', '/api/ocr/fields', { action: 'reset' }, authHeader);
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.fields.length, ocrService.DEFAULT_FIELD_RULES.length);

    // policy 定制窗口输出 ocr 段
    const policyRes = await httpRequest(port, 'GET', '/api/approval/policy');
    assert.equal(policyRes.status, 200);
    assert.equal(policyRes.json.ocr.enabled, true);
    assert.ok(Array.isArray(policyRes.json.ocr.fields) && policyRes.json.ocr.fields.length > 0,
      'policy 必须包含 ocr 字段清单');
    assert.equal(policyRes.json.ocr.engine, 'feishu_ocr_basic_recognize');
  } finally {
    server.close();
  }
}

main().then(() => {
  try { fs.unlinkSync(FIELDS_FILE); } catch (err) { /* 临时文件清理失败不影响结论 */ }
  console.log('✅ stub-test-ocr 全部通过');
  process.exit(0);
}).catch((err) => {
  try { fs.unlinkSync(FIELDS_FILE); } catch (e) { /* 同上 */ }
  console.error('❌ stub-test-ocr 失败:', err);
  process.exit(1);
});
