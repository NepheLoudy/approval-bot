// 纯补充口径满线人修复 stub（2026-11-16 郭禹澄 1116 实案）：
// 旧版 computeGroupAmounts 把 poolCount=0 的组整组剔除 → 纯补充口径满线人连「锁定前补采」
// 都轮不到，每日扫描 checked=0 静默返回（郭禹澄 ¥1229/42笔 九天无人知晓）。
// 修复后：满线组进 hits → 补采先收票 → 收回票则锁定；收不到票显式跳过（noPoolSkipped）。
process.env.FORM_ALERT_DISABLED = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const batchService = require('../src/services/batchService');
const formAlert = require('../src/services/formAlertService');
const bot = require('../src/feishu/bot');

const item = (applicant, amount) => ({
  project: '团队建设', applicant, totalAmount: amount, verifyStatus: '通过', amountInvalid: false,
});

(async () => {
  let mockPool = [];
  batchService.getPoolWithRecords = async () => mockPool;
  let mockSupplement = new Map();
  batchService.getUnbatchedInvoicedByPerson = async () => mockSupplement;

  const collectStore = require('../src/services/collectStore');
  collectStore.findBatchByName = async () => null;
  bot.sendMessage = async () => 'msg-id';

  let lockCalls = [];
  batchService.lockBatch = async (batchNo, project, options) => {
    lockCalls.push({ batchNo, project, options });
    return {
      batchNo, projects: [project || options.person], count: mockPool.length, amount: mockPool.reduce((s, i) => s + i.totalAmount, 0),
      summary: 'S', warningCount: 0, missingContent: 0, abnormalItems: [],
    };
  };

  let backfillCalls = [];
  const backfillService = require('../src/services/backfillService');
  backfillService.backfillCollect = async (opts) => {
    backfillCalls.push(opts);
    return { collected: 0, scanned: 0, totalInstances: 0 };
  };

  const st = path.join(os.tmpdir(), `fa-supp-${process.pid}-${Date.now()}.json`);
  formAlert.init(st);

  // == 1. 纯补充口径满线人进 hits（旧版在此被整组剔除）==
  mockPool = [];
  mockSupplement = new Map([['郭禹澄', { count: 42, amount: 1229.39 }]]);
  const dry = await formAlert.checkAndBroadcast({ dryRun: true });
  const dryGuo = dry.locked.find(l => l.project === '郭禹澄');
  assert.ok(dryGuo, '纯补充口径满线人应出现在 dryRun 预览（旧版整组剔除=静默）');
  assert.strictEqual(dryGuo.poolCount, 0, 'dryRun 预览如实标注票池 0 张');
  assert.strictEqual(dry.checked, 1, 'checked 含补充口径-only 组（不再一刀切剔除）');

  // == 2. 实跑：锁定前补采被触发（onlyPersons 定向），补采收不到票 → 显式跳过不锁 ==
  await formAlert.checkAndBroadcast({ trigger: 'stub' });
  assert.strictEqual(backfillCalls.length, 1, '锁定前补采应被触发（纯补充口径人 unCollected>0）');
  assert.deepEqual(backfillCalls[0].onlyPersons, ['郭禹澄'], '补采按人名定向');
  assert.strictEqual(lockCalls.length, 0, '票池仍无票 → 不得调 lockBatch（防失败循环）');
  assert.ok(fs.existsSync(st) === false, '未锁定不写冷却状态（下轮重试）');

  // == 3. 补采收回票 → 重算 → 锁定成功 ==
  mockPool = [item('郭禹澄', 600), item('郭禹澄', 629.39)]; // 模拟补采把票收进采集池
  mockSupplement = new Map(); // 票入采集表后补充口径消失（已采集排除）
  const r = await formAlert.checkAndBroadcast({ trigger: 'stub' });
  assert.strictEqual(lockCalls.length, 1, '补采救回票池后应锁定');
  assert.strictEqual(lockCalls[0].options.person, '郭禹澄', '按发起人过滤锁定');
  assert.ok(r.locked.some(l => l.project === '郭禹澄'), '结果含郭禹澄锁定记录');
  assert.ok(fs.existsSync(st), '锁定成功写冷却状态');
  assert.ok(!r.noPoolSkipped.length, '无 noPoolSkipped');

  // == 4. 他人纯补充口径不满线 → 不进 hits 不触发补采（行为不变性）==
  const st2 = path.join(os.tmpdir(), `fa-supp2-${process.pid}-${Date.now()}.json`);
  formAlert.init(st2);
  mockPool = [];
  mockSupplement = new Map([['小李', { count: 1, amount: 300 }]]);
  lockCalls = []; backfillCalls = [];
  const r2 = await formAlert.checkAndBroadcast({ trigger: 'stub' });
  assert.strictEqual(backfillCalls.length, 0, '不满线不触发补采');
  assert.strictEqual(lockCalls.length, 0, '不满线不锁定');

  for (const f of [st, st2]) { try { fs.unlinkSync(f); } catch { /* 无所谓 */ } }
  console.log('✅ stub-test-form-alert-supplement-only 全部通过（纯补充口径满线：进预览/触发补采/收票后锁定/收不到显式跳过/不满线不动作）');
})().catch((err) => {
  console.error('❌ stub-test-form-alert-supplement-only 失败:', err.message);
  process.exit(1);
});
