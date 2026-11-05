// 宣运物资组别警戒线 + 物料清单用途列 stub 测试（2026-11-03 财务功能迭代批）
//
// 覆盖：
//   1. 组别识别（resolveProject/isXuanYunGroup）+ 教师垫付两代列名（是否是教师垫付？/是否为教师垫付）
//   2. 金额线分组：宣运物资跨发起人并组走独立线，不占个人 500 线额度；人名线不受影响
//   3. 独立阈值可配（FORM_ALERT_XUANYUN_AMOUNT=1000 时组线抬高，人名线不动）
//   4. 锁定路由：宣运物资按项目过滤锁整批（自动-宣运物资-MMDD），人名组仍按 person 过滤
//   5. 物料清单用途列：宣运物资票 = 审批「说明购买理由和用途」原文一一对应，其余组维持项目分类
//   6. 开票日期 NaN 安全（issueDateToMs 非法日期返回 null，不写 NaN 列打穿三元组查重）
process.env.FORM_ALERT_DISABLED = '1'; // 逃生阀：防任何意外触发真实积压/采集
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const approvalService = require('../src/services/approvalService');
const XY = approvalService.XUANYUN_GROUP;

(async () => {
  // == 1. 组别识别与教师垫付列名 ==
  assert.strictEqual(approvalService.resolveProject({ '项目': '宣运物资' }), '宣运物资', '项目=宣运物资 应解析为组别名');
  assert.strictEqual(approvalService.isXuanYunGroup({ '项目': '宣运物资' }), true);
  assert.strictEqual(approvalService.isXuanYunGroup({ '项目': '步兵机器人' }), false);
  // 2026-11-03 实查：表列真名「是否是教师垫付？」（v89 写成「是否为教师垫付」恒 undefined）
  assert.strictEqual(approvalService.resolveProject({ '发起人': [{ name: '卢裕阳' }], '是否是教师垫付？': '是' }), '卢裕阳', '实查列名（是否是教师垫付？）应解析人名项目');
  assert.strictEqual(approvalService.resolveProject({ '发起人': [{ name: '张三' }], '是否为教师垫付': '是' }), '张三', '旧列名口径保持兼容');
  assert.strictEqual(approvalService.resolveProject({ '发起人': [{ name: '李四' }] }), '未归类');

  // == 2. 金额线分组（dryRun，mock 票池）==
  const batchService = require('../src/services/batchService');
  const config = require('../src/config');
  const formAlert = require('../src/services/formAlertService');
  const item = (project, applicant, amount) => ({
    project, applicant, totalAmount: amount, verifyStatus: '通过', amountInvalid: false,
  });
  let mockPool = [];
  batchService.getPoolWithRecords = async () => mockPool;
  batchService.getUnbatchedInvoicedByPerson = async () => new Map();

  const tmp1 = path.join(os.tmpdir(), `xy-state-1-${process.pid}-${Date.now()}.json`);
  formAlert.init(tmp1);
  assert.strictEqual(config.formAlert.amount, 500, '人名线默认 500');
  assert.strictEqual(config.formAlert.xuanYunAmount, 500, '组线默认 500（线值待财务定）');

  mockPool = [
    item(XY, '卢裕阳', 300), item(XY, '陈奕天', 250), // 跨两人合计 550 ≥ 组线 → 锁组
    item('步兵机器人', '卢裕阳', 100),                // 卢裕阳个人 100 < 500 → 不锁
    item('团队建设', '王五', 600),                    // 个人线照常工作
  ];
  let r = await formAlert.checkAndBroadcast({ dryRun: true });
  let locked = r.locked.map(l => l.project);
  assert.ok(locked.includes(XY), '宣运物资组合计 550 应命中独立线（dryRun）');
  assert.ok(locked.includes('王五'), '个人 600 应命中人名线');
  assert.ok(!locked.includes('卢裕阳'), '宣运物资票不得计入发起人个人 500 线');

  // == 3. 独立阈值可配（重载 config + formAlertService）==
  process.env.FORM_ALERT_XUANYUN_AMOUNT = '1000';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/formAlertService')];
  const config2 = require('../src/config');
  const formAlert2 = require('../src/services/formAlertService');
  const tmp2 = path.join(os.tmpdir(), `xy-state-2-${process.pid}-${Date.now()}.json`);
  formAlert2.init(tmp2);
  assert.strictEqual(config2.formAlert.xuanYunAmount, 1000, 'FORM_ALERT_XUANYUN_AMOUNT 应生效');
  assert.strictEqual(config2.formAlert.amount, 500, '人名线不受组线配置影响');
  r = await formAlert2.checkAndBroadcast({ dryRun: true });
  locked = r.locked.map(l => l.project);
  assert.ok(!locked.includes(XY), '组 550 < 1000 独立线，不应命中');
  assert.ok(locked.includes('王五'), '人名线 500 不随组线配置抬升');
  delete process.env.FORM_ALERT_XUANYUN_AMOUNT;

  // == 4. 锁定路由（非 dryRun，mock lockBatch/sendMessage；恢复默认线需再重载一轮 config）==
  delete process.env.FORM_ALERT_XUANYUN_AMOUNT;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/formAlertService')];
  const formAlert3 = require('../src/services/formAlertService');
  const tmp3 = path.join(os.tmpdir(), `xy-state-3-${process.pid}-${Date.now()}.json`);
  formAlert3.init(tmp3);
  const bot = require('../src/feishu/bot');
  const collectStore = require('../src/services/collectStore');
  collectStore.findBatchByName = async () => null;
  let cardArg = null;
  bot.sendMessage = async (card) => { cardArg = card; return 'msg-id'; };
  let lockCalls = [];
  batchService.lockBatch = async (batchNo, project, options) => {
    lockCalls.push({ batchNo, project, options });
    return {
      batchNo, projects: [project || options.person || '?'], count: 2, amount: 550,
      summary: 'S', warningCount: 0, missingContent: 0, abnormalItems: [],
    };
  };
  mockPool = [item(XY, '卢裕阳', 300), item(XY, '陈奕天', 250)];
  cardArg = null;
  r = await formAlert3.checkAndBroadcast({ trigger: 'stub' });
  assert.strictEqual(lockCalls.length, 1, '宣运物资组应锁一批');
  assert.strictEqual(lockCalls[0].project, XY, '组批次应按项目过滤锁定（整组一批）');
  assert.strictEqual(lockCalls[0].options.person, undefined, '组批次不得按发起人过滤');
  assert.strictEqual(lockCalls[0].options.deferDelivery, true, '自动批次维持两阶段流程');
  assert.ok(cardArg && JSON.stringify(cardArg).includes(XY), '详情卡应带上宣运物资组名');
  assert.ok(fs.existsSync(tmp3), '锁定成功后状态应落盘（组冷却）');

  mockPool = [item('团队建设', '赵六', 600)];
  lockCalls = [];
  r = await formAlert3.checkAndBroadcast({ trigger: 'stub' });
  assert.strictEqual(lockCalls.length, 1);
  assert.strictEqual(lockCalls[0].project, '', '人名组不按项目过滤');
  assert.strictEqual(lockCalls[0].options.person, '赵六', '人名组仍按发起人过滤锁定');

  // == 5. 物料清单用途列（宣运物资=审批用途原文一一对应）==
  const client = require('../src/feishu/client');
  let capBuf = null;
  client.uploadMediaToBitable = async (buf) => { capBuf = buf; return 'file-token'; };
  await batchService.uploadBatchMaterialList('测试批次-宣运物资', [
    { project: XY, usage: '运动会横幅制作', invoiceContent: '横幅', material: '横幅', totalAmount: 80, invoiceNo: '11111111111111111' },
    { project: XY, usage: '', invoiceContent: '海报', material: '海报', totalAmount: 50, invoiceNo: '22222222222222222' },
    { project: '步兵机器人', usage: '步兵发射', invoiceContent: '摩擦轮', material: '摩擦轮', totalAmount: 60, invoiceNo: '33333333333333333' },
  ], { purpose: '对抗赛', purchaseType: '机器人零件' });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(capBuf);
  const ws = wb.getWorksheet('Sheet1');
  assert.strictEqual(ws.getCell('D3').value, '运动会横幅制作', '宣运物资票用途列=审批「说明购买理由和用途」原文');
  assert.strictEqual(ws.getCell('D4').value, XY, '宣运物资票用途栏为空 → 回落项目分类');
  assert.strictEqual(ws.getCell('D5').value, '步兵机器人', '非宣运物资票维持项目分类口径（2026-10-12）');
  // 采购类型列（2026-11-03 二次定稿）：宣运行=实物图嵌入（单元格空、浮层图，本用例无
  // 关联申请 → 「无关联申请」标注）；非宣运行维持批次文本值。嵌图细节见
  // stub-test-xuanyun-purchase-type.js（mock 实例+CDN 全链路）
  assert.strictEqual(ws.getCell('E3').value, '无关联申请', '宣运行采购类型列改嵌实物图（无关联申请时如实标注）');
  assert.strictEqual(ws.getCell('E5').value, '机器人零件', '非宣运行采购类型维持批次文本值');

  // == 6. 开票日期 NaN 安全 ==
  const { issueDateToMs } = require('../src/utils/time');
  assert.strictEqual(issueDateToMs('2026-02-30'), null, '2 月 30 日应返回 null');
  assert.strictEqual(issueDateToMs('2026-13-01'), null, '13 月应返回 null');
  assert.strictEqual(typeof issueDateToMs('2026-11-03'), 'number', '合法日期应返回毫秒');

  // 清理临时状态文件
  for (const f of [tmp1, tmp2, tmp3]) { try { fs.unlinkSync(f); } catch { /* 无所谓 */ } }
  console.log('✅ stub-test-xuanyun-group 全部通过（组别识别/独立线/锁定路由/物料清单用途列/日期 NaN 安全）');
})().catch((err) => {
  console.error('❌ stub-test-xuanyun-group 失败:', err.message);
  process.exit(1);
});
