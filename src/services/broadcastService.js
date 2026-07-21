const config = require('../config');
const bitableApi = require('../feishu/bitable');
const { sendBroadcast } = require('../feishu/bot');

/**
 * 获取审批统计信息
 */
async function getApprovalStats() {
  const all = await bitableApi.listAllRecords(config.bitable.approvalTableId);

  const stats = {
    total: all.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    other: 0,
  };

  for (const item of all) {
    const status = item.fields['申请状态'];
    if (status === config.approvalStatus.PENDING) {
      stats.pending++;
    } else if (status === config.approvalStatus.APPROVED) {
      stats.approved++;
    } else if (status === config.approvalStatus.REJECTED) {
      stats.rejected++;
    } else {
      stats.other++;
    }
  }

  return { stats, all };
}

/**
 * 获取待审批列表
 */
async function getPendingList() {
  const filter = `CurrentValue.[申请状态] = "${config.approvalStatus.PENDING}"`;
  return bitableApi.listAllRecords(config.bitable.approvalTableId, filter);
}

/**
 * 执行一次播报
 */
async function runBroadcast(options = {}) {
  console.log('[审批播报] 开始执行播报...');

  const { stats } = await getApprovalStats();
  const pendingList = await getPendingList();

  console.log(`[审批播报] 统计: 总计=${stats.total} 待审批=${stats.pending} 已通过=${stats.approved} 已驳回=${stats.rejected}`);

  const result = await sendBroadcast(stats, pendingList, {
    date: new Date().toLocaleDateString('zh-CN'),
    webhookUrl: options.webhookUrl || config.bot.webhookUrl,
  });

  console.log('[审批播报] 播报完成');

  return {
    stats,
    pendingCount: pendingList.length,
    result,
  };
}

module.exports = {
  getApprovalStats,
  getPendingList,
  runBroadcast,
};
