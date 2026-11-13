// 宣运物资采购类型列=实物图嵌入 stub 测试（2026-11-03 曼波定稿）：
// 宣运物资批次的物料清单「采购类型」列不再是文本批次值，改为每条记录的审批
// 实物图（实例「示意图」image 控件签名 CDN 直链）一一对应嵌入；拿不到图的行
// 如实标注。mock 实例查询/CDN 下载（真网络不出，测试只验数据流与嵌入行为）。
const assert = require('assert');
const ExcelJS = require('exceljs');

process.env.FORM_ALERT_DISABLED = '1';
const config = require('../src/config');
const batchService = require('../src/services/batchService');

// 模块级缓存直接注入（fetchPhysicalPhotos 的产物），不 mock 网络——缓存即接口边界：
// uploadBatchMaterialList 对宣运行读 physicalPhotoCache，非宣运行读批次文本值。
// 注入方式：调用一次 fetchPhysicalPhotos 走真实函数把缓存写满（其内部网络调用 mock 掉）。
const client = require('../src/feishu/client');
const backfillService = require('../src/services/backfillService');

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(500, 0x7F)]); // jpeg 魔数
// PNG 完整 8 字节签名（2026-11-09 交叉复核补强：实现已验完整签名，夹具同步）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(500, 0x7F)]);

let instanceLookups = 0;
backfillService.listInstances = async () => { instanceLookups++; return [{ code: 'inst-1', serialId: 'XY2026001' }]; };
client.getApprovalInstance = async () => ({
  code: 0,
  data: { form: [{ name: '示意图', type: 'image', value: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] }] },
});
// 附件上传 mock（清单生成末尾 uploadMediaToBitable 走真网络，测试不出）
client.uploadMediaToBitable = async (buffer) => `mock-file-token-${buffer.length}`;
// 第一次取 JPEG 200、第二次取 PNG 200、第三次起模拟签名过期（200 但 HTML 壳）——验魔数过滤。
let fetchCalls = 0;
// mock 兼容两类消费者：图片下载读 arrayBuffer/content-type；requestAPI（token 等）读 json
// mock 兼容两类消费者：图片下载读 arrayBuffer/content-type；requestAPI（token 等）读 json
global.fetch = async (url) => {
  if (!/^https:\/\/cdn\.example\//.test(String(url))) {
    return { // requestAPI 消费形态（审批实例详情走 requestAPI，已单独 mock；这里兜 token 路径）
      ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
      json: async () => ({ code: 0, data: {} }), arrayBuffer: async () => Buffer.alloc(0),
    };
  }
  fetchCalls++;
  const isHtml = fetchCalls >= 3;
  const body = isHtml ? Buffer.from('<!doctype html>login') : (fetchCalls === 1 ? JPEG : PNG);
  const ct = isHtml ? 'text/html' : 'image/jpg';
  return {
    ok: true, status: 200, url: String(url),
    headers: { get: (k) => (k === 'content-type' ? ct : null) },
    arrayBuffer: async () => body,
    json: async () => ({ code: 0, data: {} }),
  };
};

(async () => {
  // == 1. fetchPhysicalPhotos：签名直链即时下载 + HTML 壳过滤 ==
  const photos1 = await batchService.fetchPhysicalPhotos('XY2026001');
  assert.strictEqual(photos1.length, 2, '魔数合法的两张图应被收（HTML 壳第 3 张被过滤）');
  assert.strictEqual(photos1[0][0], 0xFF, '第 1 张应为 jpeg');
  assert.strictEqual(photos1[1][0], 0x89, '第 2 张应为 png（魔数判定扩展名）');
  // 缓存：第二次取不再打网络
  const netCallsAfterFirst = fetchCalls;
  await batchService.fetchPhysicalPhotos('XY2026001');
  assert.strictEqual(fetchCalls, netCallsAfterFirst, '同申请第二次应走缓存不再下载');
  // 无实例的申请：空数组（缺图标注路径）
  const photos2 = await batchService.fetchPhysicalPhotos('XY-UNKNOWN');
  assert.strictEqual(photos2.length, 0, '查不到实例的申请应返回空数组（不阻断清单）');
  assert.strictEqual(instanceLookups, 2, '实例查询应恰好两次（每个 applyNo 一次，带缓存）');

  // == 2. 物料清单嵌入：宣运行采购类型列嵌图、非宣运行维持文本、缺图行标注 ==
  // uploadBatchMaterialList 末尾返回 uploadMediaToBitable 的 file_token；验证嵌入行为
  // 需要拿生成中的 workbook——mock 掉 uploadMediaToBitable 之外的路径不可行，改为
  // 拦截 wb.xlsx.writeBuffer 的产物：这里用 mock client.uploadMediaToBitable 捕获 buffer
  let captured = null;
  client.uploadMediaToBitable = async (buffer) => { captured = buffer; return 'mock-file-token'; };
  const items = [
    { project: '宣运物资', applyNo: 'XY2026001', usage: '运动会横幅', invoiceContent: '横幅', material: '横幅', totalAmount: 100 },
    { project: '宣运物资', applyNo: 'XY-UNKNOWN', usage: '宣传折页', invoiceContent: '折页', material: '折页', totalAmount: 50 },
    { project: '步兵机器人', applyNo: 'B2026001', invoiceContent: '电机', material: '电机', totalAmount: 200 },
  ];
  await batchService.uploadBatchMaterialList('测试批次-宣运物资', items, { purchaseType: '宣传物料' });
  assert.ok(captured && captured.length > 1000, 'xlsx 应正常生成并捕获上传 buffer');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(captured);
  const ws = wb.getWorksheet('Sheet1');
  assert.ok(ws, 'Sheet1 应存在');
  // 表头不变（校格式模板兼容）
  assert.strictEqual(ws.getCell('E2').value, '采购类型', '表头列名维持「采购类型」（模板兼容）');
  // 非宣运行（第 5 行）：采购类型列仍是批次文本值
  assert.strictEqual(ws.getCell('E5').value, '宣传物料', '非宣运物资行采购类型列维持批次文本值');
  // 宣运行 1（第 3 行）：有图 → 单元格空、嵌 2 张图、行高按图数补
  const row1 = ws.getRow(3);
  assert.ok(row1.getCell(5).value === null || row1.getCell(5).value === undefined, '宣运行有图时采购类型单元格应为空（图浮层）');
  assert.ok((row1.height || 0) >= 2 * 84, '多图行行高应按图数补高');
  const imgsOnSheet = ws.getImages();
  assert.strictEqual(imgsOnSheet.length, 2, '宣运行应嵌入 2 张实物图（一一对应）');
  assert.ok(imgsOnSheet.every(img => img.range.tl.col >= 4 && img.range.tl.col < 5), '图片应锚在 E 列（采购类型列）');
  // 宣运行 2（第 4 行）：无图 → 「缺实物图」标注 + 标黄
  const row2 = ws.getRow(4);
  assert.strictEqual(row2.getCell(5).value, '缺实物图', '拿不到实物图的宣运行应如实标注「缺实物图」');
  assert.ok(row2.getCell(5).fill && row2.getCell(5).fill.fgColor, '缺图行应标黄提示现场核对');

  // == 7. 批次级实例预扫：10 张不同宣运票只扫一次全窗（2026-11-09 交叉复核 P2） ==
  // 此前每条不同申请独立扫 200 天窗（≈7+ 次 API/条），预扫塌缩成每批 1 次
  const multiItems = Array.from({ length: 10 }, (_, k) => ({
    project: '宣运物资', applyNo: 'XYB' + k, usage: '批量' + k, invoiceContent: '物资' + k, material: '物资' + k, totalAmount: 10 + k,
  }));
  backfillService.listInstances = async () => {
    instanceLookups++;
    return Array.from({ length: 20 }, (_, k) => ({ code: 'inst-b' + k, serialId: 'XYB' + k }));
  };
  client.getApprovalInstance = async () => ({
    code: 0,
    data: { form: [{ name: '示意图', type: 'image', value: ['https://cdn.example/c.jpg'] }] },
  });
  let multiFetch = 0;
  global.fetch = async (url) => {
    if (!/^https:\/\/cdn\.example\//.test(String(url))) {
      return {
        ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
        json: async () => ({ code: 0, data: {} }), arrayBuffer: async () => Buffer.alloc(0),
      };
    }
    multiFetch++;
    return {
      ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'image/jpg' : null) },
      arrayBuffer: async () => JPEG, json: async () => ({ code: 0, data: {} }),
    };
  };
  const lookupsBefore = instanceLookups;
  let multiCaptured = null;
  client.uploadMediaToBitable = async (buffer) => { multiCaptured = buffer; return 'mock-token-multi'; };
  await batchService.uploadBatchMaterialList('测试批次-宣运物资-批量', multiItems, { purchaseType: '宣传物料' });
  assert.strictEqual(instanceLookups - lookupsBefore, 1, '10 张不同宣运票只做一次全窗实例预扫（API 放大塌缩）');
  assert.strictEqual(multiFetch, 10, '10 张票各即时下载 1 张实物图（预扫后逐条拉图不受影响）');
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(multiCaptured);
  assert.strictEqual(wb2.getWorksheet('Sheet1').getImages().length, 10, '10 张票各嵌 1 张实物图（一一对应保持）');

  console.log('✅ stub-test-xuanyun-purchase-type 全部通过（实物图嵌入/缺图标注/非宣运行兼容/缓存与魔数过滤）');
})().catch((err) => {
  console.error('❌ stub-test-xuanyun-purchase-type 失败:', err.message);
  process.exit(1);
});
