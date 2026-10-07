const cron = require('node-cron');
const config = require('../config');
const quietHours = require('../utils/quietHours');
const { runWeeklyBroadcast } = require('../services/broadcastService');
const { runReminder } = require('../services/reminderService');
const { runInvoiceUrge, announceTodayUrged, pollAllReplies } = require('../services/invoiceUrgeService');
const formAlertService = require('../services/formAlertService');
const batchService = require('../services/batchService');
const bot = require('../feishu/bot');

// ============================================================
// 定时任务（共四个）：
//   1. 每周财务催办周报  CRON_SCHEDULE                     (0 0 18 * * 1, 周一18:00)
//   2. 每日待审批提醒    DAILY_INVOICE_REMINDER_SCHEDULE   (0 0 9 * * *,  每天09:00, 无审批中记录则跳过)
//   3. 催发票私聊        INVOICE_URGE_SCHEDULE             (0 30 10 * * *, 每天10:30,
//      已通过满14天仍未交发票 → 私聊发起人催交；同一笔距上次私聊不满
//      INVOICE_URGE_INTERVAL_DAYS 天（默认 2）不重复催（间隔闸，回复轮询仍每日跑），
//      私聊前轮询 p2p 会话回复（延期→N天不催，可带时长 / 无法提交→停催 /
//      同一笔满 maxTimes 次，默认 5 →升级周报），
//      私聊后群播「今日已催」卡（今日明细 + 需财务关注 + 未私聊汇总，与周报分开），
//      当天无私聊催交且无当日状态变化则不发卡)
//   4. 制单金额线兜底    FORM_ALERT_SCHEDULE               (0 35 10 * * *, 每天10:35,
//      项目「已开发票且未制单」金额满 FORM_ALERT_AMOUNT（默认500）→ 自动锁定批次发详情卡
//      （两阶段：confirm 后才生成交付件+二维码卡）；
//      主触发是发票采集落库后的即时检查（formAlertService.triggerAfterCollect），
//      本任务兜底防存量满额后无新票、永不触发的漏网；同一项目 24h 冷却不重触发）
//   5. 打印情况询问      BATCH_PRINT_ASK_SCHEDULE          (0 15 * * * *, 每小时15分,
//      交付确认超 BATCH_PRINT_ASK_DELAY_HOURS（默认12h）未回复打印完成的批次 → 群发询问卡
//      引导 /approval-batch printed <批次号>；每批只自动问一次；发送过晚间静默闸顺延）
//   6. 回复轮询          INVOICE_REPLY_POLL_SCHEDULE       (0 45 * * * *, 每小时45分,
//      2026-10-04：催办私聊的「延期/无法提交/回票」即时处理+回执，不等每日催办轮；
//      只发对话回执不发催办，交互回路不受晚间静默限；与催办轮互斥见 invoiceUrgeService)
//
// 注：DAILY_INVOICE_REMINDER_SCHEDULE / INVOICE_URGE_SCHEDULE 代码默认留空 = 不启用，
//     上文括号内时刻为现网 .env 配置值（非代码默认）；周播报代码默认周一 18:00
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
  form_alert: () => withRetry('form_alert', () => formAlertService.runDailyCheck()),
  print_ask: () => withRetry('print_ask', () => askPendingPrintConfirm()),
};

/**
 * 打印情况询问（2026-09-29 曼波定两阶段流程收尾）：确认交付超 12h 未回复打印完成的
 * 批次，群发询问卡引导 /approval-batch printed <批次号>；每批只自动问一次（markPrintAsked
 * 防重）；整体过晚间静默闸（凌晨确认的批次顺延到静默结束后询问）。
 */
async function askPendingPrintConfirm() {
  const targets = await batchService.getPrintAskTargets();
  if (!targets.length) return { asked: 0 };
  let asked = 0;
  for (const t of targets) {
    try {
      // 批次号/项目名来自表格（人工可写），先消毒再进卡片 markdown（对抗审查 P2-2 同款）
      const safeNo = bot.stripCardInjection(t.batchNo);
      const safeProject = bot.stripCardInjection(t.project);
      await bot.sendMessage({
        config: { wide_screen_mode: true },
        header: { template: 'yellow', title: { tag: 'plain_text', content: `🖨️ 打印情况确认 · ${safeNo}` } },
        elements: [{
          tag: 'markdown',
          content: [
            `批次 **${safeNo}**（${safeProject}：${t.count} 张 ¥${Number(t.amount).toFixed(2)}）已确认交付并过了 ${config.batch.printAskDelayHours} 小时，打印完成了吗？`,
            ``,
            `✅ 已打印 → 回复 **/approval-batch printed ${safeNo}**（更新打印标记）`,
            `⏳ 还没打 → 忽略本卡尽快处理；交付件在报销批次表附件（扫码清单按序扫码录入）`,
          ].join('\n'),
        }],
      });
      await batchService.markPrintAsked(t.recordId);
      asked++;
      console.log(`[打印询问] 已询问批次 ${t.batchNo}（接取人: ${t.taker || '未接取'}）`);
    } catch (err) {
      // 单批询问失败不写防重标（下轮重问），也不阻断其余批次
      console.error(`[打印询问] 批次 ${t.batchNo} 询问失败（下轮重试）:`, err.message);
    }
  }
  return { asked, total: targets.length };
}

let weeklyTask = null;
let reminderTask = null;
let invoiceUrgeTask = null;
let formAlertTask = null;
let printAskTask = null;
let replyPollTask = null;

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

  // 4. 制单金额线兜底（主触发是采集落库后的即时检查，本任务防存量满额漏网）
  formAlertService.init(config.formAlert.stateFile);
  if (config.formAlert.schedule) {
    formAlertTask = cron.schedule(config.formAlert.schedule, () => {
      console.log('[定时任务] 触发制单金额线兜底检查');
      quietHours.gateTask('form_alert', quietHours.shanghaiStamp(), quietTaskRunners.form_alert, '制单金额线兜底').catch(err => {
        console.error('[定时任务] 制单金额线兜底失败:', err.message);
      });
    }, { timezone: 'Asia/Shanghai' });

    console.log(`[定时任务] 制单金额线兜底已启动: ${config.formAlert.schedule} (Asia/Shanghai, 满额 ¥${config.formAlert.amount} / 冷却 ${config.formAlert.cooldownHours}h) -> 下次 ${getNextExecutionTime(config.formAlert.schedule)}`);
  } else {
    console.log('[定时任务] 未配置 FORM_ALERT_SCHEDULE，制单金额线每日兜底未启用（采集落库后的即时检查仍生效）');
  }

  // 5. 打印情况询问（确认交付 12h 未回复 → 群发询问卡，每批一次，过静默闸）
  printAskTask = cron.schedule(config.batch.printAskSchedule, () => {
    quietHours.gateTask('print_ask', quietHours.shanghaiStamp(), quietTaskRunners.print_ask, '打印情况询问').catch(err => {
      console.error('[定时任务] 打印情况询问失败:', err.message);
    });
  }, { timezone: 'Asia/Shanghai' });
  console.log(`[定时任务] 打印情况询问已启动: ${config.batch.printAskSchedule} (Asia/Shanghai, 确认后 ${config.batch.printAskDelayHours}h 未打印则询问) -> 下次 ${getNextExecutionTime(config.batch.printAskSchedule)}`);

  // 6. 回复轮询（小时级，2026-10-04 陈方硕延期反馈）：催办私聊里的「延期/无法提交」
  //    文字回复与回票图片即时处理+回执，不再等每日 10:30 催办轮（此前回复后最长要等
  //    18h 才有确认，叠加 hub 欢迎语干扰，用户视角=功能坏了）。只发对话回执不发催办，
  //    属交互回路不受晚间静默限（与接单确认同口径）；与催办轮的并发互斥在
  //    invoiceUrgeService.pollAllReplies 内部（后到者跳过，下轮兜住）
  if (config.invoiceUrge.replyPollSchedule) {
    replyPollTask = cron.schedule(config.invoiceUrge.replyPollSchedule, () => {
      pollAllReplies().then((stats) => {
        if (stats.skipped) return; // 撞上催办轮/上一轮未结束，静默让位
        if (stats.users > 0) {
          console.log(`[定时任务] 回复轮询: 监听 ${stats.users} 位用户, 延期 ${stats.deferred} 批, 无法提交 ${stats.cannotSubmit} 批, 未识别 ${stats.ignored} 条`);
        }
      }).catch(err => {
        console.error('[定时任务] 回复轮询失败:', err.message);
      });
    }, { timezone: 'Asia/Shanghai' });
    console.log(`[定时任务] 回复轮询已启动: ${config.invoiceUrge.replyPollSchedule} (Asia/Shanghai, 延期/无法提交/回票即时回执) -> 下次 ${getNextExecutionTime(config.invoiceUrge.replyPollSchedule)}`);
  } else {
    console.log('[定时任务] INVOICE_REPLY_POLL_SCHEDULE 配为空，小时级回复轮询未启用（每日催办轮的轮询仍在）');
  }

  // 晚间静默：注册积压任务的冲刷执行器，并按启动时点调度积压补跑（有积压才调度）
  for (const [name, fn] of Object.entries(quietTaskRunners)) {
    quietHours.registerTask(name, fn);
  }
  quietHours.initQuietHoursFlush();

  return { weeklyTask, reminderTask, invoiceUrgeTask, formAlertTask, printAskTask, replyPollTask };
}

function stopCronJobs() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
  if (invoiceUrgeTask) { invoiceUrgeTask.stop(); invoiceUrgeTask = null; }
  if (formAlertTask) { formAlertTask.stop(); formAlertTask = null; }
  if (printAskTask) { printAskTask.stop(); printAskTask = null; }
  if (replyPollTask) { replyPollTask.stop(); replyPollTask = null; }
}

/**
 * 计算下次执行时间（展示用，Asia/Shanghai 由调度器保证，这里按服务器本地时区渲染）。
 * 支持 node-cron 的 6 段（秒 分 时 日 月 周）与 5 段（分 时 日 月 周）写法，
 * 时/日/月/周域支持 * 与逗号列表；带步进/范围的表达式返回「未知」。
 * @param {string} schedule cron 表达式
 * @param {Date} [now] 计算基准时刻（测试注入用，默认当前时间）
 */
function getNextExecutionTime(schedule, now = new Date()) {
  try {
    const parts = String(schedule).trim().split(/\s+/);
    if (parts.length < 5) return '未知';
    const [sec, min, hr, dom, mon, dow] = parts.length >= 6 ? parts : ['0', ...parts];

    const matchField = (field, value) => {
      if (field === undefined || field === '*' || field === '?') return true;
      if (!/^[\d,]+$/.test(field)) return null;
      return field.split(',').some((v) => parseInt(v, 10) === value);
    };
    // 分/秒域仅支持单值数字（含列表/通配则显性未知）；通配只在小时位展开为每小时。
    // （此前 parseInt('*') 静默落 0 点，每小时任务被显示成「明天 00:15/00:45」。）
    if (!/^\d+$/.test(sec) || !/^\d+$/.test(min)) return '未知（暂不支持的表达式）';
    const minutes = Number(min);
    const seconds = Number(sec);
    const hours = (hr === '*' || hr === '?')
      ? Array.from({ length: 24 }, (_, i) => i)
      : String(hr).split(',').map(v => parseInt(v, 10)).filter(Number.isFinite).sort((a, b) => a - b);
    if (hours.length === 0) return '未知';

    for (let addDays = 0; addDays <= 366; addDays++) {
      for (const h of hours) {
        const candidate = new Date(
          now.getFullYear(), now.getMonth(), now.getDate() + addDays,
          h, minutes, seconds, 0
        );
        if (candidate <= now) continue;
        const domHit = matchField(dom, candidate.getDate());
        const monHit = matchField(mon, candidate.getMonth() + 1);
        const dowHit = matchField(dow, candidate.getDay()); // 0=周日，与 node-cron 一致
        if (domHit === null || monHit === null || dowHit === null) return '未知（暂不支持的表达式）';
        if (domHit && monHit && dowHit) return candidate.toLocaleString('zh-CN');
      }
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
      formAlert: !!formAlertTask,
      printAsk: !!printAskTask,
      replyPoll: !!replyPollTask,
    },
    schedules: {
      weeklyBroadcast: config.cron.schedule,
      dailyReminder: config.reminder.schedule || '(未启用)',
      invoiceUrge: config.invoiceUrge.schedule || '(未启用)',
      formAlert: config.formAlert.schedule || '(未启用，采集后即时检查仍生效)',
      printAsk: config.batch.printAskSchedule,
      replyPoll: config.invoiceUrge.replyPollSchedule || '(未启用)',
    },
    nextExecution: {
      weeklyBroadcast: weeklyTask ? getNextExecutionTime(config.cron.schedule) : null,
      dailyReminder: reminderTask ? getNextExecutionTime(config.reminder.schedule) : null,
      invoiceUrge: invoiceUrgeTask ? getNextExecutionTime(config.invoiceUrge.schedule) : null,
      formAlert: formAlertTask ? getNextExecutionTime(config.formAlert.schedule) : null,
      printAsk: printAskTask ? getNextExecutionTime(config.batch.printAskSchedule) : null,
      replyPoll: replyPollTask ? getNextExecutionTime(config.invoiceUrge.replyPollSchedule) : null,
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

/** 手动触发一次制单金额线检查（测试/管理接口用；dryRun=true 只查不发） */
async function runFormAlertOnce(options = {}) {
  return withRetry('form_alert', () => formAlertService.runDailyCheck(options));
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runBroadcast,
  runReminder,
  runInvoiceUrgeOnce,
  runFormAlertOnce,
  getCronStatus,
  getBroadcastHistory,
  getNextExecutionTime,
};
