const config = require('../config');
const bitableApi = require('../feishu/bitable');
const { buildApprovalAlertCard, buildApprovalResultCard, sendMessage } = require('../feishu/bot');

/**
 * 获取全部审批记录
 */
async function getAllApprovals() {
  return bitableApi.listAllRecords(config.bitable.approvalTableId);
}

/**
 * 获取待审批列表
 */
async function getPendingApprovals() {
  const filter = `CurrentValue.[申请状态] = "${config.approvalStatus.PENDING}"`;
  return bitableApi.listAllRecords(config.bitable.approvalTableId, filter);
}

/**
 * 按 record_id 获取单条审批（不存在返回 null）
 */
async function getApprovalById(id) {
  try {
    return await bitableApi.getRecord(config.bitable.approvalTableId, id);
  } catch (err) {
    console.error('[审批服务] 获取审批详情失败:', err.message);
    return null;
  }
}

/**
 * 处理审批创建事件：向群机器人推送新审批提醒卡片
 * @param {string} recordId 记录 ID
 * @param {object} [fields] 事件携带的字段（HTTP 回调可用，长连接需回查）
 */
async function handleApprovalCreate(recordId, fields) {
  let approval = { record_id: recordId, fields: fields || {} };
  if (!fields) {
    approval = await bitableApi.getRecord(config.bitable.approvalTableId, recordId);
  }

  console.log(`[审批事件] 新建审批: ${approval.fields['申请编号'] || recordId}`);

  const card = buildApprovalAlertCard(approval);
  return sendMessage(card);
}

/**
 * 处理审批更新事件：状态变为已通过/已驳回时推送结果卡片
 * @param {string} recordId 记录 ID
 * @param {object} [fields] 事件携带的字段
 */
async function handleApprovalUpdate(recordId, fields) {
  let approval = { record_id: recordId, fields: fields || {} };
  if (!fields) {
    approval = await bitableApi.getRecord(config.bitable.approvalTableId, recordId);
  }

  const status = approval.fields['申请状态'];
  const comment = approval.fields['审批意见'] || '';

  console.log(`[审批事件] 审批状态更新: ${approval.fields['申请编号'] || recordId} -> ${status}`);

  if (status === config.approvalStatus.APPROVED || status === config.approvalStatus.REJECTED) {
    const card = buildApprovalResultCard(approval, status, comment);
    return sendMessage(card);
  }

  return null;
}

module.exports = {
  getAllApprovals,
  getPendingApprovals,
  getApprovalById,
  handleApprovalCreate,
  handleApprovalUpdate,
};
