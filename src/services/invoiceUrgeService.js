const approvalService = require('./approvalService');
const { sendTextToUser, buildInvoiceUrgeText, getUsers } = require('../feishu/bot');

/**
 * 催发票私聊
 *
 * 触发：INVOICE_URGE_SCHEDULE（默认建议每天 10:30）
 * 条件：「已通过」且完成时间满 INVOICE_URGE_GRACE_DAYS 天（默认 14 天）仍未交发票
 * 动作：按发起人分组，一人一条私聊（应用 IM API），列明细并附「申请编号」
 *       自带的审批实例链接，引导其到审批详情页补交发票（审批界面，非表格链接）。
 * 发起人缺失（人员字段为空）的记录跳过并告警，不阻断其他人。
 */
async function runInvoiceUrge(options = {}) {
  const overdue = await approvalService.getOverdueInvoices();

  if (!overdue.length) {
    console.log('[催发票] 无超期未交发票记录，跳过');
    return { sent: false, overdueCount: 0, users: 0 };
  }

  // 按发起人分组：open_id -> { name, records[] }
  const byUser = new Map();
  let skipped = 0;
  for (const record of overdue) {
    const user = getUsers(record.fields?.['发起人'])[0];
    if (!user || !user.id) {
      skipped++;
      console.warn(`[催发票] 记录无发起人，跳过: ${record.record_id}`);
      continue;
    }
    if (!byUser.has(user.id)) {
      byUser.set(user.id, { name: user.name, records: [] });
    }
    byUser.get(user.id).records.push(record);
  }

  console.log(`[催发票] 超期 ${overdue.length} 条，涉及 ${byUser.size} 位发起人${skipped ? `（${skipped} 条无发起人已跳过）` : ''}`);

  // dry-run：只构建私聊文案不发送（预览用）
  if (options.dryRun) {
    const previews = [];
    for (const [openId, { name, records }] of byUser) {
      previews.push({ openId, name, text: buildInvoiceUrgeText(records) });
    }
    return { dryRun: true, overdueCount: overdue.length, users: previews.length, previews };
  }

  let sent = 0;
  const failures = [];
  for (const [openId, { name, records }] of byUser) {
    try {
      await sendTextToUser(openId, buildInvoiceUrgeText(records));
      sent++;
      console.log(`[催发票] 已私聊 ${name}(${openId})，名下 ${records.length} 笔超期`);
    } catch (err) {
      failures.push({ openId, name, error: err.message });
      console.error(`[催发票] 私聊 ${name}(${openId}) 失败:`, err.message);
    }
  }

  return {
    sent: sent > 0,
    overdueCount: overdue.length,
    users: byUser.size,
    sentCount: sent,
    failures,
  };
}

module.exports = {
  runInvoiceUrge,
};
