const cron = require('node-cron');
const config = require('../config');
const { runBroadcast } = require('../services/broadcastService');

const broadcastHistory = [];

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

async function runBroadcastWithRetry() {
  let attempt = 0;
  let lastError = null;

  while (attempt < RETRY_CONFIG.maxAttempts) {
    attempt++;
    try {
      const result = await runBroadcast();

      broadcastHistory.unshift({
        time: new Date().toISOString(),
        type: 'approval_broadcast',
        success: true,
        attempts: attempt,
        stats: result.stats,
        pendingCount: result.pendingCount,
      });

      if (broadcastHistory.length > 50) {
        broadcastHistory.length = 50;
      }

      return result;
    } catch (err) {
      lastError = err;
      if (isFrequencyLimitError(err)) {
        const delay = Math.min(RETRY_CONFIG.initialDelay * Math.pow(2, attempt - 1), RETRY_CONFIG.maxDelay);
        console.warn(`[定时播报] 第 ${attempt} 次尝试失败，频率限制，将在 ${delay / 1000} 秒后重试...`);
        await sleep(delay);
      } else {
        console.error('[定时播报] 播报失败:', err);
        break;
      }
    }
  }

  broadcastHistory.unshift({
    time: new Date().toISOString(),
    type: 'approval_broadcast',
    success: false,
    attempts: attempt,
    error: lastError?.message || 'Unknown error',
  });

  if (broadcastHistory.length > 50) {
    broadcastHistory.length = 50;
  }

  throw lastError;
}

let broadcastTask = null;

function startCronJobs() {
  if (broadcastTask) {
    console.log('[定时任务] 定时任务已存在，先停止旧任务');
    broadcastTask.stop();
  }

  broadcastTask = cron.schedule(config.cron.schedule, () => {
    console.log('[定时任务] 触发审批播报');
    runBroadcastWithRetry().catch(err => {
      console.error('[定时任务] 审批播报失败:', err.message);
    });
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log(`[定时任务] 审批播报已启动，调度规则: ${config.cron.schedule} (Asia/Shanghai)`);
  console.log(`[定时任务] 当前时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`[定时任务] 下次执行时间: ${getNextExecutionTime(config.cron.schedule)}`);

  return { broadcastTask };
}

function stopCronJobs() {
  if (broadcastTask) {
    broadcastTask.stop();
    broadcastTask = null;
    console.log('[定时任务] 已停止');
  }
}

function getNextExecutionTime(schedule) {
  try {
    const [second, minute, hour, day, month, weekday] = schedule.split(' ');
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
    running: !!broadcastTask,
    schedule: config.cron.schedule,
    nextExecution: getNextExecutionTime(config.cron.schedule),
  };
}

function getBroadcastHistory() {
  return broadcastHistory;
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runBroadcast: runBroadcastWithRetry,
  getCronStatus,
  getBroadcastHistory,
};
