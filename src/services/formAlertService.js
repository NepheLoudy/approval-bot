/**
 * 制单金额线自动锁定（2026-09-29 曼波定，两阶段流程）。
 *
 * 模式（曼波拍板）：财务同学不再主动干活，听机器人发布报销单——
 * 项目维度「已开发票且未制单」（=票池，已剔除「是否打印=是」的人工线票）金额合计
 * 满 config.formAlert.amount（默认 500）→ **自动锁定批次**：生成报销单号（自动-<项目>-<MMDD>）、
 * 回写审批表「报销单」栏与「是否打印=是」标记、群里发**详情卡等待确认**（第一阶段，本服务）；
 * 财务回复 /approval-batch confirm 后才生成交付件（发票排版文件/物料清单/扫码清单）并下发
 * 二维码卡开始工作（第二阶段，chatService.confirmDelivery）；确认后再过 12h（避开夜间）
 * 机器人询问打印情况，财务回复 printed 完成打印标记更新（cron printAsk 流程）。
 *
 * 触发点：
 *   - 事件驱动：发票采集落库成功后即时检查（invoiceCollectService 钩子，setImmediate 不阻塞回执）；
 *   - 每日兜底：FORM_ALERT_SCHEDULE 定时扫一遍（防存量满额后无新票落库、永不触发的漏网）。
 *
 * 防护：
 *   - 冷却：同一项目 config.formAlert.cooldownHours（默认 24h）内不重复触发——锁定失败
 *     （批次号冲突/表异常）时防循环重试；锁定成功后票出池自然不再命中；
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
      console.warn(`[制单金额线] 状态读取失败（使用空状态继续）: ${err.message}`);
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

/** 自动批次号：自动-<项目>-<MMDD>，同日同项目冲突追加 -2/-3（批次号唯一约束） */
async function nextAutoBatchNo(project) {
  const collectStore = require('./collectStore');
  const d = new Date();
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
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
  const threshold = config.formAlert.amount;
  const cooldownMs = config.formAlert.cooldownHours * 60 * 60 * 1000;

  const { suggestions } = await batchService.previewBatch();
  const hits = suggestions.filter(s => s.amount >= threshold);
  const now = Date.now();
  const due = hits.filter(s => {
    const st = state.projects[s.project];
    return !st || now - (st.ts || 0) >= cooldownMs;
  });

  const result = {
    checked: suggestions.length,
    threshold,
    locked: [],
    failed: [],
    skipped: hits.length - due.length, // 命中阈值但在冷却期内的项目数
  };
  if (!due.length) return result;

  for (const s of due) {
    if (dryRun) {
      result.locked.push({ project: s.project, count: s.count, amount: s.amount, dryRun: true });
      continue;
    }
    try {
      const batchNo = await nextAutoBatchNo(s.project);
      // 两阶段流程（2026-09-29 曼波定）：锁定只生成报销单号+打标+发详情卡（deferDelivery
      // 不生成交付件），财务群里 confirm 后才由 chatService.confirmDelivery 生成交付件+发二维码卡
      const r = await batchService.lockBatch(batchNo, s.project, { operator: '机器人自动锁定', deferDelivery: true });
      // 详情卡（无二维码，带 confirm/reject 指引）。发送失败不回滚锁定（批次已建、票已出池），
      // 财务仍可从报销批次表看到该批并用 confirm 指令继续
      try {
        await bot.sendMessage(bot.buildAutoLockNoticeCard({
          batchNo: r.batchNo, project: r.projects.join('/'), count: r.count, amount: r.amount,
          summary: r.summary, warningCount: r.warningCount, missingContent: r.missingContent,
        }));
      } catch (err) {
        console.error(`[制单金额线] 自动批次 ${r.batchNo} 详情卡发送失败（批次已锁定，可 confirm 继续）:`, err.message);
      }
      state.projects[s.project] = { batchNo: r.batchNo, amount: s.amount, count: s.count, ts: now };
      result.locked.push({ project: s.project, batchNo: r.batchNo, count: r.count, amount: r.amount });
      console.log(`[制单金额线] 自动锁定（${trigger}）：${s.project} 满额 ¥${s.amount.toFixed(2)} → 批次 ${r.batchNo}（${r.count} 张，待确认）；冷却内跳过 ${result.skipped} 项`);
    } catch (err) {
      console.error(`[制单金额线] 自动锁定失败（${s.project}，冷却后自动重试）:`, err.message);
      result.failed.push({ project: s.project, error: err.message });
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
