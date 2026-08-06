const config = require('../config');
const approvalService = require('./approvalService');
const { sendTextToChat, sendTextToUser } = require('../feishu/bot');

const COMMANDS = {
  '/approval-help': showHelp,
  '/approval-list': showList,
  '/approval-pending': showPending,
  '/approval-status': showStatus,
};

/**
 * 从消息事件中提取纯文本指令，去掉 @机器人 占位符
 */
function extractText(data) {
  const message = data?.message || {};
  if (message.message_type !== 'text') return '';

  let text = '';
  try {
    const content = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;
    text = content?.text || '';
  } catch (e) {
    return '';
  }

  // 去掉 @_user_1 这类 @机器人 占位符
  return text.replace(/@_user_\d+/g, '').trim();
}

/**
 * 处理收到的聊天消息事件（长连接 / HTTP 回调通用）
 */
async function processChatMessage(data) {
  const message = data?.message;
  if (!message) return;

  const text = extractText(data);
  if (!text) return;

  const [cmd] = text.split(/\s+/);
  const handler = COMMANDS[cmd];
  if (!handler) return;

  const replyText = await handler();

  // 优先回群聊，其次私聊
  if (message.chat_id) {
    await sendTextToChat(message.chat_id, replyText);
  } else {
    const openId = data?.sender?.sender_id?.open_id;
    if (openId) await sendTextToUser(openId, replyText);
  }
}

async function showHelp() {
  return [
    '📋 审批机器人指令:',
    '/approval-help - 显示本帮助',
    '/approval-list - 查看所有审批',
    '/approval-pending - 查看待审批',
    '/approval-status - 查看审批统计',
  ].join('\n');
}

async function showList() {
  const list = await approvalService.getAllApprovals();
  if (!list.length) return '暂无审批记录';

  const lines = list.map((item, i) => {
    const no = item.fields['申请编号'] || '未知';
    const applicant = item.fields['发起人']?.[0]?.name || '未知';
    const status = item.fields['申请状态'] || '未知';
    return `${i + 1}. ${no} | ${applicant} | ${status}`;
  });
  return ['📋 全部审批:', ...lines].join('\n');
}

async function showPending() {
  const list = await approvalService.getPendingApprovals();
  if (!list.length) return '✅ 暂无待审批';

  const lines = list.map((item, i) => {
    const no = item.fields['申请编号'] || '未知';
    const applicant = item.fields['发起人']?.[0]?.name || '未知';
    return `${i + 1}. ${no} | ${applicant}`;
  });
  return ['⏳ 待审批:', ...lines].join('\n');
}

async function showStatus() {
  const list = await approvalService.getAllApprovals();
  const stats = { total: list.length, pending: 0, approved: 0, rejected: 0, other: 0 };

  for (const item of list) {
    const s = item.fields['申请状态'];
    if (s === config.approvalStatus.PENDING) stats.pending++;
    else if (s === config.approvalStatus.APPROVED) stats.approved++;
    else if (s === config.approvalStatus.REJECTED) stats.rejected++;
    else stats.other++;
  }

  return [
    '📊 审批统计:',
    `总计: ${stats.total}`,
    `待审批: ${stats.pending}`,
    `已通过: ${stats.approved}`,
    `已驳回: ${stats.rejected}`,
  ].join('\n');
}

module.exports = {
  processChatMessage,
};
