const config = require('../config');
const bitableApi = require('../feishu/bitable');

// ============================================================
// 审批数据服务
//
// 播报策略：不做事件即时播报（审批提交/审批结果都不推），
// 播报只有定时任务（周播报催办清单 + 每日待审批提醒），
// 因此这里只负责数据查询与催办分支计算。
// ============================================================

// 完成后 N 个月仍未转账才开始提醒
const TRANSFER_GRACE_MONTHS = 3;

/** 拉取全部审批记录 */
async function fetchAllApprovals() {
  return bitableApi.listAllRecords(config.bitable.approvalTableId);
}

/** 审批流程是否为当前活跃流程（未配置则不过滤） */
function isActiveProcess(fields) {
  if (!config.approvalProcesses.length) return true;
  return config.approvalProcesses.includes(fields['审批流程']);
}

function hasAttachment(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 完成时间是否已超过 N 个月（无完成时间返回 false，不提醒） */
function isOlderThanMonths(timestamp, months) {
  if (!timestamp) return false;
  const ms = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
  if (Number.isNaN(ms)) return false;
  const deadline = new Date(ms);
  deadline.setMonth(deadline.getMonth() + months);
  return deadline.getTime() <= Date.now();
}

async function getAllApprovals() {
  return fetchAllApprovals();
}

/** 审批中列表（客户端过滤） */
async function getPendingApprovals() {
  const all = await fetchAllApprovals();
  return all.filter(r => r.fields?.['申请状态'] === config.approvalStatus.PENDING);
}

async function getApprovalById(id) {
  try {
    return await bitableApi.getRecord(config.bitable.approvalTableId, id);
  } catch (err) {
    console.error('[审批服务] 获取审批详情失败:', err.message);
    return null;
  }
}

/** 审批统计：全量分类 + 本周滚动7天结果 */
async function getApprovalStats() {
  const all = await fetchAllApprovals();

  const stats = {
    total: all.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    other: 0,
    // 本周（滚动7天）
    weekNew: 0,
    weekApproved: 0,
    weekRejected: 0,
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const APPROVED = config.approvalStatus.APPROVED;
  const REJECTED = config.approvalStatus.REJECTED;

  for (const item of all) {
    const f = item.fields || {};
    const status = f['申请状态'];
    if (status === config.approvalStatus.PENDING) stats.pending++;
    else if (status === APPROVED) stats.approved++;
    else if (status === REJECTED) stats.rejected++;
    else stats.other++;

    if (typeof f['发起时间'] === 'number' && f['发起时间'] >= weekAgo) stats.weekNew++;
    if (status === APPROVED && typeof f['完成时间'] === 'number' && f['完成时间'] >= weekAgo) stats.weekApproved++;
    if (status === REJECTED && typeof f['完成时间'] === 'number' && f['完成时间'] >= weekAgo) stats.weekRejected++;
  }

  return { stats, all };
}

/**
 * 财务催办三分支（仅针对「已通过」的活跃流程记录）：
 *   1. 未交发票：发票栏为空            → 催发票
 *   2. 未制单：  已有发票但报销单为空   → 做报销单
 *               （报销单=无需报销 视为已制单/无需处理）
 *   3. 未转账：  已有发票和报销单但「是否转账」为空，
 *               且完成时间已超过 3 个月 → 提醒转账
 */
async function getFinanceFollowUp() {
  const all = await fetchAllApprovals();
  const APPROVED = config.approvalStatus.APPROVED;

  const missingInvoice = [];  // 未交发票
  const missingForm = [];     // 未制单（缺报销单）
  const missingTransfer = []; // 未转账（完成超3个月）

  for (const record of all) {
    const f = record.fields || {};
    if (f['申请状态'] !== APPROVED) continue;
    if (!isActiveProcess(f)) continue;

    const hasInvoice = hasAttachment(f['发票']);
    // 报销单为单选：null=未制单；「无需报销」=无需制单，视为已完成该环节
    const form = f['报销单'];
    const hasForm = form !== null && form !== undefined && form !== '';

    if (!hasInvoice) {
      missingInvoice.push(record);
      continue; // 没发票时不会走到制单/转账环节
    }

    if (!hasForm) {
      missingForm.push(record);
      continue;
    }

    // 已有发票和报销单，检查转账（完成时间3个月后才开始提醒）
    if (!f['是否转账'] && isOlderThanMonths(f['完成时间'], TRANSFER_GRACE_MONTHS)) {
      missingTransfer.push(record);
    }
  }

  // 各段按完成/发起时间倒序，最老的在前（越久未处理越靠前）
  const byTime = (a, b) => (a.fields['完成时间'] || a.fields['发起时间'] || 0) - (b.fields['完成时间'] || b.fields['发起时间'] || 0);
  missingInvoice.sort(byTime);
  missingForm.sort(byTime);
  missingTransfer.sort(byTime);

  return { missingInvoice, missingForm, missingTransfer };
}

module.exports = {
  getAllApprovals,
  getPendingApprovals,
  getApprovalById,
  getApprovalStats,
  getFinanceFollowUp,
};
