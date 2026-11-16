/**
 * 制单金额线自动锁定（2026-09-29 曼波定，两阶段流程；2026-10-27 分组维度从项目改发起人；
 * 2026-11-03 新增宣运物资组别独立警戒线）。
 *
 * 模式（曼波拍板）：财务同学不再主动干活，听机器人发布报销单——
 * 发起人维度「已开发票且未制单」（=票池，已剔除「是否打印=是」的人工线票）金额合计
 * 满 config.formAlert.amount（默认 500）→ **自动锁定批次**：生成报销单号（自动-<人名>-<MMDD>）、
 * 回写审批表「报销单」栏与「是否打印=是」标记、群里发**详情卡等待确认**（第一阶段，本服务）；
 * 财务回复 /approval-batch confirm 后才生成交付件（发票排版文件/物料清单/扫码清单）并下发
 * 二维码卡开始工作（第二阶段，chatService.confirmDelivery）；确认后再过 12h（避开夜间）
 * 机器人询问打印情况，财务回复 printed 完成打印标记更新（cron printAsk 流程）。
 *
 * 宣运物资例外（2026-11-03 曼波定）：审批新组别「宣运物资」的记录不按人名 500 线——
 * 全组（跨发起人）共用一条独立警戒线 config.formAlert.xuanYunAmount（线值待财务定），
 * 满线锁一整批「自动-宣运物资-<MMDD>」（lockBatch 按项目过滤），冷却同 24h。
 *
 * 触发点：
 *   - 事件驱动：发票采集落库成功后即时检查（invoiceCollectService 钩子，setImmediate 不阻塞回执）；
 *   - 每日兜底：FORM_ALERT_SCHEDULE 定时扫一遍（防存量满额后无新票落库、永不触发的漏网）。
 *
 * 防护：
 *   - 冷却：同一分组（人名/宣运物资组）config.formAlert.cooldownHours（默认 24h）内不重复
 *     触发——冷却仅在**锁定成功后**落盘（state.projects）；锁定失败（批次号冲突/表异常）
 *     不写冷却，下一轮采集/兜底自动重试（running 互斥防并发风暴，不会热循环）；
 *   - 互斥：批次池全局锁由 batchService.lockBatch 内部保证，多次触发并发也只锁一次成功；
 *   - 静默闸：夜间采集落库的触发过 quietHours 积压，窗口结束补跑（以补跑时最新票池为准）。
 *
 * 状态持久化为 JSON 文件（同 urge-state 口径：pm2 重启不丢，生产路径配到项目目录之外）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const bot = require('../feishu/bot');
const quietHours = require('../utils/quietHours');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'form-alert-state.json');

let stateFile = DEFAULT_FILE;
let state = { projects: {} };

// 运行互斥：采集落库钩子与每日兜底并发跑时串行化，防同一项目双锁
let running = Promise.resolve();

function init(file) {
  if (file) stateFile = file;
  state = load();
  return module.exports;
}

function load() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { projects: parsed.projects || {} };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 损坏文件改名备份（同 urgeStateStore 对抗审查 P3 口径；此处仅冷却丢失，低危）
      try { fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`); } catch { /* 无所谓 */ }
      console.warn(`[制单金额线] 状态文件损坏已备份并重建（冷却丢失，失败项目可能重试）: ${err.message}`);
    }
    return { projects: {} };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    // 原子写（同 urgeStateStore 复查 P2-9 口径）：先写临时文件再 rename，防半截 JSON
    const tmpFile = `${stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, stateFile);
  } catch (err) {
    console.error(`[制单金额线] 状态写入失败: ${err.message}`);
  }
}

/** 自动批次号：自动-<项目>-<MMDD>，同日同项目冲突追加 -2/-3（批次号唯一约束）。
 *  项目=人名（个人线）或组别名「宣运物资」（2026-11-03 独立线） */
async function nextAutoBatchNo(project) {
  const collectStore = require('./collectStore');
  const mmdd = require('../utils/time').shanghaiMmdd(); // 上海时区（对抗审查 P2-3）
  for (let n = 1; n < 50; n++) {
    const candidate = `自动-${project}-${mmdd}${n > 1 ? `-${n}` : ''}`;
    if (!(await collectStore.findBatchByName(candidate))) return candidate;
  }
  throw new Error('自动批次号分配失败（同日同名批次过多）');
}

/**
 * 检查票池各项目未制单金额，满阈值且出冷却的项目自动锁定生成报销单。
 * @param {object} [options] { trigger 来源标记（collect|cron|manual，仅日志）, dryRun 只查不锁 }
 * @returns {Promise<{checked: number, threshold: number, locked: Array, failed: Array, skipped: number}>}
 */
function checkAndBroadcast(options = {}) {
  const run = prev => prev.then(() => doCheck(options));
  const p = run(running);
  running = p.catch(() => {});
  return p;
}

async function doCheck({ trigger = 'manual', dryRun = false } = {}) {
  // 延迟 require：batchService 重依赖（pdf-lib/exceljs/sharp），采集链路不常驻加载
  const batchService = require('./batchService');
  const { XUANYUN_GROUP } = require('./approvalService');
  const baseThreshold = config.formAlert.amount;
  const xyThreshold = config.formAlert.xuanYunAmount;
  const cooldownMs = config.formAlert.cooldownHours * 60 * 60 * 1000;

  // 分组阈值：宣运物资组走独立警戒线（2026-11-03），人名线维持通用阈值
  const thresholdFor = (group) => (group === XUANYUN_GROUP ? xyThreshold : baseThreshold);

  /** 发起人维度金额汇总（票池 + 票池外补充合并）——补采后重算复用。
   *  2026-10-27 曼波定：分组维度从项目改人名（个人已开票未制单满 500 锁一批归档）；
   *  已生成的项目批次保持不变。state.projects 的键随之从项目名变人名（同一 JSON 结构）。
   *  2026-11-03 起键再添组别名「宣运物资」（跨发起人并组走独立线）。 */
  const computeGroupAmounts = async () => {
    // 「已开发票且未制单」= 票池（采集表，票面精确金额）+ 票池外补充（审批表「发票」列
    // 直接附票未走采集的记录，申请金额近似）——两列等效口径，2026-09-29 曼波定
    // 双计审查裁定（2026-11-05 全量审查 P1-2）：两口径互斥已由 applyNo 链路保证——
    // 采集表为真源（条目带「关联申请编号」），补充口径 getUnbatchedInvoicedByPerson
    // 按 getCollectedApplyNoSet 排除已采集记录（batchService），同一张票不会两边都计。
    // 已知边缘：采集条目「关联申请编号」为空（OCR 缺失）时无法与审批记录链接，
    // 会产生一次双计——靠采集回执人工核对兜底，暂不做发票号级模糊匹配。
    const pool = await batchService.getPoolWithRecords();
    const byPerson = new Map();
    for (const p of pool) {
      // 宣运物资组（2026-11-03）：跨发起人并成一组走独立警戒线，不占个人 500 线额度
      const group = p.project === XUANYUN_GROUP
        ? XUANYUN_GROUP
        : (String(p.applicant || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '');
      if (!group) continue; // 无发起人的票不自动锁批（无主批次）
      const cur = byPerson.get(group) || { group, count: 0, amount: 0, warningCount: 0, unCollected: 0, poolCount: 0 };
      cur.count++;
      cur.amount = Math.round((cur.amount + p.totalAmount) * 100) / 100;
      if (p.verifyStatus !== '通过' || p.amountInvalid) cur.warningCount++;
      cur.poolCount++;
      byPerson.set(group, cur);
    }
    const supplement = await batchService.getUnbatchedInvoicedByPerson();
    for (const [group, agg] of supplement) {
      const cur = byPerson.get(group) || { group, count: 0, amount: 0, warningCount: 0, unCollected: 0, poolCount: 0 };
      cur.count += agg.count;
      cur.amount = Math.round((cur.amount + agg.amount) * 100) / 100;
      cur.unCollected += agg.count; // 该组未采集笔数（详情卡提示 + 锁定前补采判定）
      byPerson.set(group, cur);
    }
    // 2026-11-16 修复（郭禹澄 1116 实案）：不再在此处剔除 poolCount=0 的组——
    // 纯补充口径满线人（票在审批表直接附票、从未走采集，采集票又全被归批后
    // poolCount 归 0）被剔除后连「锁定前补采」都轮不到，每天扫描 checked=0 静默
    // 返回、九天无人知晓。防 lockBatch「票池无票」失败循环的本意（对抗审查 P3-1）
    // 改在锁定段实现：补采后仍无票池票的组显式跳过并打日志。
    return [...byPerson.values()]
      .map(s => ({ ...s, amount: Math.round(s.amount * 100) / 100 }));
  };

  let all = await computeGroupAmounts();
  let hits = all.filter(s => s.amount >= thresholdFor(s.group));

  // 「锁定前补采」（2026-10-17 曼波定「一个单子做完」）：待锁人若仍有已交未采集的票
  // （unCollected>0），先定点回溯把票收进采集池再锁——防「判定满额时票未进池 → 批次只锁
  // 到一部分、其余进下批」的拆单（重装 1017 实案）。补采失败/收不全不拦锁：按现票池锁定，
  // 未入库票由详情卡如实提示。noFormAlert 防 checkAndBroadcast→补采→触发 递归；dryRun 只查不采
  let preCollected = 0;
  if (!dryRun) {
    const now0 = Date.now();
    const dueNow = hits.filter(s => {
      const st = state.projects[s.group];
      return !st || now0 - (st.ts || 0) >= cooldownMs;
    });
    const needCollect = dueNow.filter(s => (s.unCollected || 0) > 0);
    // 补采分流（2026-11-03）：人名组按 onlyPersons 定向；宣运物资组按 onlyProjects 定向
    // （组别名不是人名，persons 集合匹配不到审批表发起人）
    const needPersons = needCollect.filter(s => s.group !== XUANYUN_GROUP).map(s => s.group);
    const needProjects = needCollect.some(s => s.group === XUANYUN_GROUP) ? [XUANYUN_GROUP] : [];
    if (needPersons.length || needProjects.length) {
      try {
        const backfillService = require('./backfillService');
        const bf = await backfillService.backfillCollect({
          limit: 100, sinceDays: 200, noFormAlert: true,
          ...(needPersons.length ? { onlyPersons: needPersons } : {}),
          ...(needProjects.length ? { onlyProjects: needProjects } : {}),
        });
        preCollected = bf.collected || 0;
        console.log(`[制单金额线] 锁定前补采（${needCollect.map(s => s.group).join('/')}）：收 ${bf.collected} 张 / 处理 ${bf.scanned} 条候选（枚举 ${bf.totalInstances || 0} 实例）`);
        if (preCollected > 0) {
          all = await computeGroupAmounts();
          hits = all.filter(s => s.amount >= thresholdFor(s.group));
        }
      } catch (err) {
        console.warn('[制单金额线] 锁定前补采失败（按现票池锁定，未采集票并入后续批次）:', err.message);
      }
    }
  }

  const now = Date.now();
  const due = hits.filter(s => {
    const st = state.projects[s.group];
    return !st || now - (st.ts || 0) >= cooldownMs;
  });

  const result = {
    checked: all.length,
    threshold: baseThreshold,
    xuanYunThreshold: xyThreshold, // 宣运物资组独立线（2026-11-03）
    preCollected, // 锁定前补采入库票数（0=无需/失败）
    locked: [],
    failed: [],
    skipped: hits.length - due.length, // 命中阈值但在冷却期内的分组数
    noPoolSkipped: [], // 补采后仍票池无票而跳过的组（2026-11-16，显式暴露不再静默）
  };
  if (!due.length) return result;

  for (const s of due) {
    if (dryRun) {
      // poolCount=0 的组如实标注（预览可见「补采后仍无票池票」的形态，2026-11-16）
      result.locked.push({ project: s.group, count: s.count, amount: s.amount, poolCount: s.poolCount, dryRun: true });
      continue;
    }
    // 防失败循环（对抗审查 P3-1 本意移到锁定段，2026-11-16）：补采后仍票池无票的组
    // （票无法回溯/审批无附件/无 APPROVAL_CODE）显式跳过并打 warn——不再像旧版那样
    // 在 computeGroupAmounts 一刀切剔除导致纯补充口径满线人永远静默（郭禹澄 1116 实案）
    if (!(s.poolCount > 0)) {
      console.warn(`[制单金额线] ${s.group} 满线 ¥${s.amount.toFixed(2)}（补充口径 ${s.unCollected} 笔）但票池无票（锁定前补采未收入），跳过锁定（下轮重试）`);
      result.noPoolSkipped.push({ group: s.group, amount: s.amount, unCollected: s.unCollected });
      continue;
    }
    try {
      const isXyGroup = s.group === XUANYUN_GROUP;
      const batchNo = await nextAutoBatchNo(s.group);
      // 两阶段流程（2026-09-29 曼波定）：锁定只生成报销单号+打标+发详情卡（deferDelivery
      // 不生成交付件），财务群里 confirm 后才由 chatService.confirmDelivery 生成交付件+发二维码卡。
      // 2026-10-27 起分组维度=人名：批次号 自动-<人名>-<MMDD>，按发起人过滤票池锁定；
      // 2026-11-03 宣运物资组例外：按项目过滤锁定一整批 自动-宣运物资-<MMDD>
      const r = await batchService.lockBatch(
        batchNo,
        isXyGroup ? XUANYUN_GROUP : '',
        { person: isXyGroup ? undefined : s.group, operator: '机器人自动锁定', deferDelivery: true },
      );
      // 详情卡（无二维码，带 confirm/reject 指引）。发送失败不回滚锁定（批次已建、票已出池），
      // 财务仍可从报销批次表看到该批并用 confirm 指令继续
      try {
        const sent = await bot.sendMessage(bot.buildAutoLockNoticeCard({
          batchNo: r.batchNo,
          project: isXyGroup ? s.group : `${s.group}（${r.projects.join('/')}）`,
          count: r.count, amount: r.amount,
          summary: r.summary, warningCount: r.warningCount, missingContent: r.missingContent,
          unCollected: s.unCollected || 0,
          abnormalItems: r.abnormalItems || [],
        }));
        // 熔断/无 webhook 静默 null（2026-11-03 审查 P3）：与 print_ask/confirm_remind
        // 口径对齐——批次已锁卡没发出要有痕，财务侧靠次日 confirm-remind 兜底
        if (!sent) console.warn(`[制单金额线] 自动批次 ${r.batchNo} 详情卡被播报熔断拒发（批次已锁定，可 confirm 继续）`);
      } catch (err) {
        console.error(`[制单金额线] 自动批次 ${r.batchNo} 详情卡发送失败（批次已锁定，可 confirm 继续）:`, err.message);
      }
      state.projects[s.group] = { batchNo: r.batchNo, amount: s.amount, count: s.count, ts: now };
      result.locked.push({ project: s.group, batchNo: r.batchNo, count: r.count, amount: r.amount });
      console.log(`[制单金额线] 自动锁定（${trigger}）：${s.group} 满额 ¥${s.amount.toFixed(2)} → 批次 ${r.batchNo}（${r.count} 张，待确认）；冷却内跳过 ${result.skipped} 项`);
    } catch (err) {
      console.error(`[制单金额线] 自动锁定失败（${s.group}，冷却后自动重试）:`, err.message);
      result.failed.push({ project: s.group, error: err.message });
    }
  }
  if (result.locked.some(l => !l.dryRun)) save();
  return result;
}

/**
 * 采集落库后的即时触发入口（invoiceCollectService 钩子调用）：
 * 过晚间静默闸（深夜交票不动群，窗口结束随积压冲刷补跑——冲刷时重算最新票池，不怕数据过期）。
 * 测试环境（FORM_ALERT_DISABLED=1）直接跳过，防 stub 测试写真实积压/状态文件。
 */
function triggerAfterCollect() {
  if (process.env.FORM_ALERT_DISABLED === '1') return;
  quietHours.gateTask('form_alert_live', quietHours.shanghaiStamp(), () => checkAndBroadcast({ trigger: 'collect' }), '制单金额线自动锁定')
    .catch(err => console.error('[制单金额线] 采集后即时触发失败:', err.message));
}

/** 每日兜底扫描（cron 调用） */
function runDailyCheck(options = {}) {
  return checkAndBroadcast({ trigger: 'cron', ...options });
}

module.exports = {
  init,
  checkAndBroadcast,
  triggerAfterCollect,
  runDailyCheck,
  nextAutoBatchNo,
};

// 模块加载即按配置初始化状态文件（cron 的显式 init 幂等）：保证 FORM_ALERT_SCHEDULE
// 留空、仅采集落库钩子生效时，状态文件也落在配置路径而非默认路径
init(config.formAlert.stateFile);
