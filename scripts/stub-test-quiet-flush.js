/**
 * 离线桩测试 · 晚间静默冲刷（2026-10-10 自 ticket-bot 同批移植竞态修复回归）：
 *   runFlush 收尾若直接 saveBacklog(remaining) 会以「本轮快照-已结算」覆盖整个
 *   积压文件，把冲刷期间新登记的积压静默丢掉（本项目 6 个 cron 均走 gateTask）。
 * 验证：
 *     ①冲刷期间新落盘的积压不被覆盖丢失，且在本轮循环内继续补跑；
 *     ②失败保留项照常回写（attempts 自增落盘），退避调度不丢条目；
 *     ③同毫秒入队的积压不互吞（身份键=入队时签发的 id）。
 * 全部外部依赖走桩（registerTask 注册内存执行器），积压文件指向临时目录；
 * 用法：node scripts/stub-test-quiet-flush.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKLOG_FILE = path.join(os.tmpdir(), `quiet-backlog-approval-test-${Date.now()}.json`);
process.env.QUIET_BACKLOG_FILE = BACKLOG_FILE; // 必须在 require quietHours 前设置

const quietHours = require(path.join(ROOT, 'src/utils/quietHours.js'));

// ---- 桩：task 冲刷执行器（内存版，不触网）----
const ran = [];
let onRunTask = null; // 钩子：任务补跑时注入「冲刷期间新落盘」的模拟
const FAIL_TASKS = new Set(['t-fail', 't-fail-f', 't-fail-h']);
quietHours.registerTask('t-ok', async () => {
  ran.push('t-ok');
  if (onRunTask) { const fn = onRunTask; onRunTask = null; fn(); }
});
quietHours.registerTask('t-fail', async () => { ran.push('t-fail'); throw new Error('模拟补跑失败'); });
quietHours.registerTask('t-fail-f', async () => { ran.push('t-fail-f'); throw new Error('模拟补跑失败'); });
quietHours.registerTask('t-fail-h', async () => { ran.push('t-fail-h'); throw new Error('模拟补跑失败'); });
quietHours.registerTask('t-other', async () => { ran.push('t-other'); });

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

function writeBacklog(items) {
  fs.writeFileSync(BACKLOG_FILE, JSON.stringify({ items }, null, 2));
}
function readBacklog() {
  try {
    if (!fs.existsSync(BACKLOG_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch { return []; }
}
const taskItem = (name, fireKey) => ({
  type: 'task', name, fireKey, queuedAt: new Date().toISOString(),
});

(async () => {
  console.log('\n== 1. 冲刷期间新落盘的积压不被收尾保存覆盖 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  writeBacklog([taskItem('t-ok', 'slot-a')]);
  // 模拟：任务 A 补跑时，另一个 gateTask 并发落盘了任务 B（直写文件 = gate 的 load+push+save）
  onRunTask = () => writeBacklog([...readBacklog(), taskItem('t-other', 'slot-b')]);
  await quietHours.runFlush();
  check('A、B 两个任务都被补跑（旧实现 B 会被覆盖丢失，只跑 1 个）', ran.includes('t-ok') && ran.includes('t-other'), JSON.stringify(ran));
  check('冲刷结束后积压文件清空（无条目残留或丢失）', readBacklog().length === 0, JSON.stringify(readBacklog().length));

  console.log('\n== 2. 失败保留项照常回写（attempts 自增），不被新落盘条目挤掉 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  const good = taskItem('t-ok', 'slot-d');
  writeBacklog([taskItem('t-fail', 'slot-c'), good]);
  // D 补跑成功时新落盘条目 E（验证失败退避路径下新条目同样不丢）
  onRunTask = () => writeBacklog([...readBacklog(), taskItem('t-other', 'slot-e')]);
  await quietHours.runFlush();
  const backlogAfter = readBacklog();
  check('成功的 D 已结算移除', !backlogAfter.some((it) => it.fireKey === 'slot-d'), JSON.stringify(backlogAfter.map((it) => it.fireKey)));
  check('失败的 C 保留且 attempts=1', backlogAfter.some((it) => it.fireKey === 'slot-c' && it.attempts === 1), JSON.stringify(backlogAfter.map((it) => ({ fireKey: it.fireKey, attempts: it.attempts }))));
  check('冲刷期间落盘的 E 同样保留（未被覆盖）', backlogAfter.some((it) => it.fireKey === 'slot-e'), JSON.stringify(backlogAfter.map((it) => it.fireKey)));

  console.log('\n== 3. 同毫秒入队的两条积压不互吞（身份键=入队时签发的 id） ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  const sameTs = new Date().toISOString(); // 同一毫秒戳：旧 queuedAt 身份键在此碰撞
  const badF = taskItem('t-fail-f', 'slot-f'); badF.queuedAt = sameTs; badF.id = 'id-f';
  const goodG = taskItem('t-ok', 'slot-g'); goodG.queuedAt = sameTs; goodG.id = 'id-g';
  writeBacklog([badF, goodG]);
  await quietHours.runFlush();
  const after3 = readBacklog();
  check('成功的 G 已结算移除', !after3.some((it) => it.fireKey === 'slot-g'), JSON.stringify(after3.map((it) => it.fireKey)));
  check('失败的 F 保留且 attempts=1（不被同毫秒成功条目吞掉）', after3.some((it) => it.fireKey === 'slot-f' && it.attempts === 1), JSON.stringify(after3.map((it) => ({ fireKey: it.fireKey, attempts: it.attempts }))));

  console.log('\n== 4. 无 id 存量条目同毫秒入队：失败保留项仍由 remaining 兜底不被丢 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  const sameTs2 = new Date().toISOString();
  const badH = taskItem('t-fail-h', 'slot-h'); badH.queuedAt = sameTs2; // 无 id（旧版落盘形态）
  const goodI = taskItem('t-ok', 'slot-i'); goodI.queuedAt = sameTs2;
  writeBacklog([badH, goodI]);
  await quietHours.runFlush();
  const after4 = readBacklog();
  check('成功的 I 已结算移除', !after4.some((it) => it.fireKey === 'slot-i'), JSON.stringify(after4.map((it) => it.fireKey)));
  check('失败的 H 保留（remaining 兜底）', after4.some((it) => it.fireKey === 'slot-h' && it.attempts === 1), JSON.stringify(after4.map((it) => ({ fireKey: it.fireKey, attempts: it.attempts }))));

  fs.rmSync(BACKLOG_FILE, { force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });
