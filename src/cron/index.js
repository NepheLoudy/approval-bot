const cron = require('node-cron');
const config = require('../config');
const quietHours = require('../utils/quietHours');
const { runWeeklyBroadcast } = require('../services/broadcastService');
const { runReminder } = require('../services/reminderService');
const { runInvoiceUrge, announceTodayUrged } = require('../services/invoiceUrgeService');

// ============================================================
// 定时任务（共三个，播报只走定时，无事件即时播报）：
//   1. 每周财务催办周报  CRON_SCHEDULE                     (0 0 18 * * 1, 周一18:00)
//   2. 每日待审批提醒    DAILY_INVOICE_REMINDER_SCHEDULE   (0 0 9 * * *,  每天09:00, 无审批中记录则跳过)
//   3. 催发票私聊        INVOICE_URGE_SCHEDULE             (0 30 10 * * *, 每天10:30,
//      已通过满14天仍未交发票 → 私聊发起人催交；私聊前轮询 p2p 会话回复
//      （延期→3天不催 / 无法提交→停催 / 同一笔满3次→升级周报），
//      私聊后群播「今日已催」卡（今日明细 + 需财务关注 + 未私聊汇总，与周报分开），无待催则跳过)
//
// 晚间静默：任务触发落在播报静默窗口（默认 02:00–09:00，Asia/Shanghai，
// 见 utils/quietHours）内时不直接执行，登记积压到窗口结束整点重跑整个任务
// （以补发时刻数据重查）；人工接口（runBroadcast/runReminder/
// runInvoiceUrgeOnce）不受限
// ============================================================

const broadcastHistory = [];
const HISTORY_LIMIT = 50;

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelay: 30 * 1000,
  maxDelay: 5 * 60 * 1000,
};

function isFrequencyLimitError(err) {
  if (!err) return false;
  const message = err.message || '';
  return message.includes('11232') || message.includes('frequency limited');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function recordHistory(entry) {
  broadcastHistory.unshift({ time: new Date().toISOString(), ...entry });
  if (broadcastHistory.length > HISTORY_LIMIT) {
    broadcastHistory.length = HISTORY_LIMIT;
  }
}

/** 带频率限制重试的执行器（播报类任务共用） */
async function withRetry(taskName, taskFn) {
  let attempt = 0;
  let lastError = null;

  while (attempt < RETRY_CONFIG.maxAttempts) {
    attempt++;
    try {
      const result = await taskFn();
      recordHistory({ type: taskName, success: true, attempts: attempt, result: summarize(taskName, result) });
      return result;
    } catch (err) {
      lastError = err;
      if (isFrequencyLimitError(err) && attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.min(RETRY_CONFIG.initialDelay * Math.pow(2, attempt - 1), RETRY_CONFIG.maxDelay);
        console.warn(`[${taskName}] 第 ${attempt} 次尝试失败（频率限制），${delay / 1000} 秒后重试...`);
        await sleep(delay);
      } else {
        break;
      }
    }
  }

  recordHistory({ type: taskName, success: false, attempts: attempt, error: lastError?.message || 'Unknown error' });
  throw lastError;
}

function summarize(taskName, result) {
  if (taskName === 'weekly_broadcast') {
    return { counts: result.counts, stats: result.stats };
  }
  if (taskName === 'daily_reminder') {
    return { sent: result.sent, pendingCount: result.pendingCount };
  }
  if (taskName === 'invoice_urge') {
    return { sent: result.sent, overdueCount: result.overdueCount, users: result.users };
  }
  return result;
}

// ---------- 任务定义 ----------

// 晚间静默积压的冲刷执行器：与下方 cron 回调共用同一执行链（含频率限制重试），
// 冲刷时重跑整个任务函数，以补发时刻的最新数据为准
const quietTaskRunners = {
  weekly_broadcast: () => withRetry('weekly_broadcast', () => runWeeklyBroadcast()),
  daily_reminder: () => withRetry('daily_reminder', () => runReminder()),
  invoice_urge: () => withRetry('invoice_urge', () => runInvoiceUrge()).then((r) => announceTodayUrged(r)),
};

let weeklyTask = null;
let reminderTask = null;
let invoiceUrgeTask = null;

/** 启动全部定时任务 */
function startCronJobs() {
  stopCronJobs();

  // 1. 每周财务催办周报
  weeklyTask = cron.schedule(config.cron.schedule, () => {
    console.log('[定时任务] 触发每周财务催办周报');
    // 晚间静默：窗口内登记积压，窗口结束整点重跑整个任务
    quietHours.gateTask('weekly_broadcast', quietHours.shanghaiStamp(), quietTaskRunners.weekly_broadcast, '每周财务催办周报').catch(err => {
      console.error('[定时任务] 周播报失败:', err.message);
    });
  }, { timezone: 'Asia/Shanghai' });

  console.log(`[定时任务] 周播报已启动: ${config.cron.schedule} (Asia/Shanghai) -> 下次 ${getNextExecutionTime(config.cron.schedule)}`);

  // 2. 每日待审批提醒
  if (config.reminder.schedule) {
    reminderTask = cron.schedule(config.reminder.schedule, () => {
      console.log('[定时任务] 触发每日待审批提醒');
      // 晚间静默：窗口内登记积压，窗口结束整点重跑整个任务
      quietHours.gateTask('daily_reminder', quietHours.shanghaiStamp(), quietTaskRunners.daily_reminder, '每日待审批提醒').catch(err => {
        console.error('[定时任务] 每日提醒失败:', err.message);
      });
    }, { timezone: 'Asia/Shanghai' });

    console.log(`[定时任务] 每日提醒已启动: ${config.reminder.schedule} (Asia/Shanghai) -> 下次 ${getNextExecutionTime(config.reminder.schedule)}`);
  } else {
    console.log('[定时任务] 未配置 DAILY_INVOICE_REMINDER_SCHEDULE，每日提醒未启用');
  }

  // 3. 催发票私聊（已通过满 N 天仍未交发票 → 私聊发起人；私聊后群播「今日已催」卡）
  if (config.invoiceUrge.schedule) {
    invoiceUrgeTask = cron.schedule(config.invoiceUrge.schedule, () => {
      console.log('[定时任务] 触发催发票私聊');
      // 晚间静默：窗口内登记积压（私聊+「今日已催」群播同属一个任务流，一并顺延重跑）
      quietHours.gateTask('invoice_urge', quietHours.shanghaiStamp(), quietTaskRunners.invoice_urge, '催发票私聊').catch(err => {
        console.error('[定时任务] 催发票私聊失败:', err.message);
      });
    }, { timezone: 'Asia/Shanghai' });

    console.log(`[定时任务] 催发票私聊已启动: ${config.invoiceUrge.schedule} (Asia/Shanghai, 超期阈值 ${config.invoiceUrge.graceDays} 天) -> 下次 ${getNextExecutionTime(config.invoiceUrge.schedule)}`);
  } else {
    console.log('[定时任务] 未配置 INVOICE_URGE_SCHEDULE，催发票私聊未启用');
  }

  // 晚间静默：注册积压任务的冲刷执行器，并按启动时点调度积压补跑（有积压才调度）
  for (const [name, fn] of Object.entries(quietTaskRunners)) {
    quietHours.registerTask(name, fn);
  }
  quietHours.initQuietHoursFlush();

  return { weeklyTask, reminderTask, invoiceUrgeTask };
}

function stopCronJobs() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
  if (invoiceUrgeTask) { invoiceUrgeTask.stop(); invoiceUrgeTask = null; }
}

/**
 * 计算下次执行时间（展示用，Asia/Shanghai 由调度器保证，这里按服务器本地时区渲染）。
 * 支持 node-cron 的 6 段（秒 分 时 日 月 周）与 5 段（分 时 日 月 周）写法，
 * 日/月/周域支持 * 与逗号列表；带步进/范围的表达式返回「未知」。
 */
function getNextExecutionTime(schedule) {
  try {
    const parts = String(schedule).trim().split(/\s+/);
    if (parts.length < 5) return '未知';
    const [sec, min, hr, dom, mon, dow] = parts.length >= 6 ? parts : ['0', ...parts];

    const matchField = (field, value) => {
      if (field === undefined || field === '*' || field === '?') return true;
      if (!/^[\d,]+$/.test(field)) return null;
      return field.split(',').some((v) => parseInt(v, 10) === value);
    };

    const now = new Date();
    for (let addDays = 0; addDays <= 366; addDays++) {
      const candidate = new Date(
        now.getFullYear(), now.getMonth(), now.getDate() + addDays,
        parseInt(hr, 10) || 0, parseInt(min, 10) || 0, parseInt(sec, 10) || 0, 0
      );
      if (candidate <= now) continue;
      const domHit = matchField(dom, candidate.getDate());
      const monHit = matchField(mon, candidate.getMonth() + 1);
      const dowHit = matchField(dow, candidate.getDay()); // 0=周日，与 node-cron 一致
      if (domHit === null || monHit === null || dowHit === null) return '未知（暂不支持的表达式）';
      if (domHit && monHit && dowHit) return candidate.toLocaleString('zh-CN');
    }
    return '未知';
  } catch (e) {
    return '未知';
  }
}

function getCronStatus() {
  return {
    running: {
      weeklyBroadcast: !!weeklyTask,
      dailyReminder: !!reminderTask,
      invoiceUrge: !!invoiceUrgeTask,
    },
    schedules: {
      weeklyBroadcast: config.cron.schedule,
      dailyReminder: config.reminder.schedule || '(未启用)',
      invoiceUrge: config.invoiceUrge.schedule || '(未启用)',
    },
    nextExecution: {
      weeklyBroadcast: weeklyTask ? getNextExecutionTime(config.cron.schedule) : null,
      dailyReminder: reminderTask ? getNextExecutionTime(config.reminder.schedule) : null,
      invoiceUrge: invoiceUrgeTask ? getNextExecutionTime(config.invoiceUrge.schedule) : null,
    },
    quietHours: quietHours.getStatus(),
  };
}

function getBroadcastHistory() {
  return broadcastHistory;
}

/** 手动触发一次周播报（测试/管理接口用；dryRun=true 只构建不发送） */
async function runBroadcast(options = {}) {
  return withRetry('weekly_broadcast', () => runWeeklyBroadcast(options));
}

/** 手动触发一次催发票私聊（测试/管理接口用；dryRun=true 只构建文案不发送） */
async function runInvoiceUrgeOnce(options = {}) {
  return withRetry('invoice_urge', () => runInvoiceUrge(options));
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runBroadcast,
  runReminder,
  runInvoiceUrgeOnce,
  getCronStatus,
  getBroadcastHistory,
};
