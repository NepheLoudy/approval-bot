const config = require('../config');
const approvalService = require('./approvalService');
const { buildReminderCard, sendMessage } = require('../feishu/bot');

/**
 * 每日待审批提醒（发票提醒）
 *
 * 触发：DAILY_INVOICE_REMINDER_SCHEDULE（默认 0 0 9 * * *，每天 09:00）
 * 分支：
 *   - 存在「审批中」记录 → 推送提醒卡片，
 *     @ 当前处理人（为空时回落到配置的审批人 open_id）
 *   - 无「审批中」记录 → 不发送（避免无意义刷屏）
 */
async function runReminder(options = {}) {
  const pendingList = await approvalService.getPendingApprovals();

  if (!pendingList.length) {
    console.log('[每日提醒] 无审批中记录，跳过提醒');
    return { sent: false, pendingCount: 0 };
  }

  console.log(`[每日提醒] 发现 ${pendingList.length} 条审批中记录，推送提醒`);

  const card = buildReminderCard(pendingList, config.reminder.mentionIds);
  await sendMessage(card, options.webhookUrl);

  return { sent: true, pendingCount: pendingList.length };
}

module.exports = {
  runReminder,
};
