const config = require('../config');
const approvalService = require('./approvalService');
const { buildWeeklyFinanceCard, sendMessage } = require('../feishu/bot');

/**
 * 每周财务催办周报
 *
 * 触发：CRON_SCHEDULE（当前配置 0 0 18 * * 1，每周一 18:00）
 * 内容（仅针对「已通过」的活跃流程记录，不做审批提交/结果即时播报）：
 *   1. 未交发票（发票栏为空）            → 提醒财务催发票
 *   2. 未制单（已有发票但报销单为空）    → 提醒财务做报销单
 *   3. 未转账（发票+报销单齐全但「是否转账」为空，
 *      且完成时间已超 3 个月）           → 提醒财务跟进转账
 * 底部附本周统计（仅本周结果，不放全量数据）
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] true 时只构建卡片不发送（用于预览）
 */
async function runWeeklyBroadcast(options = {}) {
  console.log('[周播报] 开始执行财务催办周报...');

  const followUp = await approvalService.getFinanceFollowUp();
  const { stats } = await approvalService.getApprovalStats();

  console.log(
    `[周播报] 催办: 未交发票=${followUp.missingInvoice.length} 未制单=${followUp.missingForm.length} 未转账=${followUp.missingTransfer.length} | ` +
    `本周: 新增=${stats.weekNew} 通过=${stats.weekApproved} 拒绝=${stats.weekRejected}`
  );

  const card = buildWeeklyFinanceCard(followUp, stats, {
    date: new Date().toLocaleDateString('zh-CN'),
    mentionIds: config.reminder.mentionIds,
  });

  if (options.dryRun) {
    console.log('[周播报] dry-run 模式，不发送');
    return {
      dryRun: true,
      counts: {
        missingInvoice: followUp.missingInvoice.length,
        missingForm: followUp.missingForm.length,
        missingTransfer: followUp.missingTransfer.length,
      },
      stats,
      card,
    };
  }

  const result = await sendMessage(card, options.webhookUrl);
  console.log('[周播报] 播报完成');

  return {
    counts: {
      missingInvoice: followUp.missingInvoice.length,
      missingForm: followUp.missingForm.length,
      missingTransfer: followUp.missingTransfer.length,
    },
    stats,
    result,
  };
}

module.exports = {
  runWeeklyBroadcast,
};
