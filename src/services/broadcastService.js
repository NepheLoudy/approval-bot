const config = require('../config');
const approvalService = require('./approvalService');
const { sendBroadcast } = require('../feishu/bot');

/**
 * 每周审批播报
 *
 * 触发：CRON_SCHEDULE（当前配置 0 0 18 * * 1，每周一 18:00）
 * 内容：状态统计（含本周新增）+ 审批中列表（@当前处理人）
 */
async function runWeeklyBroadcast(options = {}) {
  console.log('[周播报] 开始执行播报...');

  const { stats } = await approvalService.getApprovalStats();
  const pendingList = await approvalService.getPendingApprovals();

  console.log(
    `[周播报] 统计: 总计=${stats.total} 审批中=${stats.pending} ` +
    `已通过=${stats.approved} 已拒绝=${stats.rejected} 其他=${stats.other} 本周新增=${stats.weekNew}`
  );

  const result = await sendBroadcast(stats, pendingList, {
    date: new Date().toLocaleDateString('zh-CN'),
    weekNewCount: stats.weekNew,
    webhookUrl: options.webhookUrl || config.bot.webhookUrl,
  });

  console.log('[周播报] 播报完成');

  return {
    stats,
    pendingCount: pendingList.length,
    result,
  };
}

module.exports = {
  runWeeklyBroadcast,
};
