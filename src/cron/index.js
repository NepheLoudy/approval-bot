const cron = require('node-cron');
const config = require('../config');
const { runWeeklyBroadcast } = require('../services/broadcastService');
const { runReminder } = require('../services/reminderService');

// ============================================================
// 定时任务（共两个，播报只走定时，无事件即时播报）：
//   1. 每周财务催办周报  CRON_SCHEDULE                     (0 0 18 * * 1, 周一18:00)
//   2. 每日待审批提醒    DAILY_INVOICE_REMINDER_SCHEDULE   (0 0 9 * * *,  每天09:00, 无审批中记录则跳过)
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
  return result;
}

// ---------- 任务定义 ----------

let weeklyTask = null;
let reminderTask = null;

/** 启动全部定时任务 */
function startCronJobs() {
  stopCronJobs();

  // 1. 每周财务催办周报
  weeklyTask = cron.schedule(config.cron.schedule, () => {
    console.log('[定时任务] 触发每周财务催办周报');
    withRetry('weekly_broadcast', () => runWeeklyBroadcast()).catch(err => {
      console.error('[定时任务] 周播报失败:', err.message);
    });
  }, { timezone: 'Asia/Shanghai' });

  console.log(`[定时任务] 周播报已启动: ${config.cron.schedule} (Asia/Shanghai) -> 下次 ${getNextExecutionTime(config.cron.schedule)}`);

  // 2. 每日待审批提醒
  if (config.reminder.schedule) {
    reminderTask = cron.schedule(config.reminder.schedule, () => {
      console.log('[定时任务] 触发每日待审批提醒');
      withRetry('daily_reminder', () => runReminder()).catch(err => {
        console.error('[定时任务] 每日提醒失败:', err.message);
      });
    }, { timezone: 'Asia/Shanghai' });

    console.log(`[定时任务] 每日提醒已启动: ${config.reminder.schedule} (Asia/Shanghai) -> 下次 ${getNextExecutionTime(config.reminder.schedule)}`);
  } else {
    console.log('[定时任务] 未配置 DAILY_INVOICE_REMINDER_SCHEDULE，每日提醒未启用');
  }

  return { weeklyTask, reminderTask };
}

function stopCronJobs() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
}

function getNextExecutionTime(schedule) {
  try {
    const [second, minute, hour] = schedule.split(' ');
    const now = new Date();
    const next = new Date(now);

    next.setSeconds(parseInt(second) || 0);
    next.setMinutes(parseInt(minute) || 0);
    next.setHours(parseInt(hour) || 0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.toLocaleString('zh-CN');
  } catch (e) {
    return '未知';
  }
}

function getCronStatus() {
  return {
    running: {
      weeklyBroadcast: !!weeklyTask,
      dailyReminder: !!reminderTask,
    },
    schedules: {
      weeklyBroadcast: config.cron.schedule,
      dailyReminder: config.reminder.schedule || '(未启用)',
    },
    nextExecution: {
      weeklyBroadcast: weeklyTask ? getNextExecutionTime(config.cron.schedule) : null,
      dailyReminder: reminderTask ? getNextExecutionTime(config.reminder.schedule) : null,
    },
  };
}

function getBroadcastHistory() {
  return broadcastHistory;
}

/** 手动触发一次周播报（测试/管理接口用；dryRun=true 只构建不发送） */
async function runBroadcast(options = {}) {
  return withRetry('weekly_broadcast', () => runWeeklyBroadcast(options));
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runBroadcast,
  runReminder,
  getCronStatus,
  getBroadcastHistory,
};
