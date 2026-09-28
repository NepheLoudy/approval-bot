/**
 * 制单金额线播报（2026-09-29 曼波定）。
 *
 * 背景：财务同学也在自行制报销单，机器人自动制单能力需要与财务手工线去重——
 * 审批表「是否打印=是」的票（财务人工标记 或 机器人 lock 批次后自动回写）不进票池，
 * 票池口径即「已开发票且未制单」的真源。
 *
 * 触发条件：项目维度「已开发票且未制单」的发票金额合计满 config.formAlert.amount（默认 500）
 * → 审批群播报提醒锁定批次（做报销单三件套）。
 *
 * 触发点：
 *   - 事件驱动：发票采集落库成功后即时检查（invoiceCollectService 钩子，setImmediate 不阻塞回执）；
 *   - 每日兜底：FORM_ALERT_SCHEDULE 定时扫一遍（防存量满额后无新票落库、永不触发的漏网）。
 *
 * 防刷屏：同一项目冷却 config.formAlert.cooldownHours（默认 24h）内不重复播报——
 * 冷却而非「集合不变」判重：批次 reject 回票池后金额组可能复原成上次播报过的集合，
 * 按集合判重会静默吞掉该重播的提醒；冷却窗口后兜底扫描会再补一次。
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

// 运行互斥：采集落库钩子与每日兜底并发跑时串行化，防同一项目双播
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
      console.warn(`[制单播报] 状态读取失败（使用空状态继续）: ${err.message}`);
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
    console.error(`[制单播报] 状态写入失败: ${err.message}`);
  }
}

function buildAlertCard(due) {
  const lines = due.map(s =>
    `- ${s.project}：${s.count} 张 ¥${s.amount.toFixed(2)}${s.warningCount ? `（含 ${s.warningCount} 张待人工/金额不符 ⚠️）` : ''}`
  );
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '🖨️ 制单金额线提醒' },
    },
    elements: [
      {
        tag: 'markdown',
        content: `以下项目「已开发票且未制单」金额已满 ¥${config.formAlert.amount}（制单线），可以锁定批次做报销单：\n${lines.join('\n')}\n\n先看拟批建议：/approval-batch\n锁定：/approval-batch lock <批次号> [项目]（批次号沿用财务命名；财务已自行制单打印的票请把审批表「是否打印」标「是」，机器人不再重复制单）`,
      },
    ],
  };
}

/**
 * 检查票池各项目未制单金额，满阈值且出冷却的项目群播报提醒。
 * @param {object} [options] { trigger 来源标记（collect|cron|manual，仅日志）, dryRun 只查不发 }
 * @returns {Promise<{checked: number, threshold: number, alerted: Array, skipped: number}>}
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
    alerted: due.map(s => ({ project: s.project, count: s.count, amount: s.amount })),
    skipped: hits.length - due.length, // 命中阈值但在冷却期内的项目数
  };
  if (!due.length || dryRun) return result;

  try {
    await bot.sendMessage(buildAlertCard(due));
    for (const s of due) {
      state.projects[s.project] = { amount: s.amount, count: s.count, ts: now };
    }
    save();
    console.log(`[制单播报] 已播报（${trigger}）：${due.map(s => `${s.project} ¥${s.amount.toFixed(2)}`).join('、')}；冷却内跳过 ${result.skipped} 项`);
  } catch (err) {
    // 播报失败不写状态（下次触发重试），不向上抛（采集钩子/定时任务都不该被播报失败打断）
    console.error(`[制单播报] 群播失败（${trigger}，下次触发重试）:`, err.message);
  }
  return result;
}

/**
 * 采集落库后的即时检查入口（invoiceCollectService 钩子调用）：
 * 过晚间静默闸（深夜交票不吵群，窗口结束随积压冲刷补跑——冲刷时重算最新金额，不怕数据过期）。
 */
function triggerAfterCollect() {
  quietHours.gateTask('form_alert_live', quietHours.shanghaiStamp(), () => checkAndBroadcast({ trigger: 'collect' }), '制单金额线即时播报')
    .catch(err => console.error('[制单播报] 采集后即时检查失败:', err.message));
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
};

// 模块加载即按配置初始化状态文件（cron 的显式 init 幂等）：保证 FORM_ALERT_SCHEDULE
// 留空、仅采集落库钩子生效时，状态文件也落在配置路径而非默认路径
init(config.formAlert.stateFile);
