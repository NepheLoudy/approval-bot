const config = require('../config');
const approvalService = require('./approvalService');
const { sendTextToChat, replyTextMessage } = require('../feishu/bot');
const { fieldText } = require('../utils/fields');

// ============================================================
// 指令与对话触发（仅面向审批群）
//
// 与正常其他群的对话能力（爆米花机）分离的规则：
//   1. 群聊消息：只有 chat_id === BOT_CHAT_ID 的目标群才处理，
//      且必须 @机器人；其他群一律跳过（不回复、不记录）
//   2. 私聊消息：一律跳过（私聊对话能力属于爆米花机）
//   3. 指令命名空间统一为 /approval-*，与爆米花机的 /print-* 等互不冲突
// ============================================================

const processedMessageIds = new Set();

/**
 * 检测消息是否指向机器人（群聊场景）
 * 共用应用下机器人实际名称可能与 BOT_NAME 不一致，因此多信号判断：
 * mentioned_type=app / SDK self 标记 / 名称匹配 / /approval- 指令前缀
 */
function isMentionedBot(message) {
  if (!message) return false;

  const mentions = message.mentions || [];
  const botName = config.bot.name;

  return mentions.some(m => {
    if (m.id === 'self') return true;
    if (m.mentioned_type === 'app') return true;
    if (m.name === botName) return true;
    return false;
  });
}

/**
 * 提取纯文本内容，去掉 @机器人/@用户 占位符
 */
function extractText(message) {
  if (!message || message.message_type !== 'text') return '';

  let text = '';
  try {
    const content = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;
    text = content?.text || '';
  } catch (e) {
    return '';
  }

  return text
    .replace(/@_user_\d+/g, '')
    .replace(/@_bot_\d+/g, '')
    .replace(/@_everyone\s*/g, '')
    .trim();
}

function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.split(/\s+/);
  return { command: parts[0].toLowerCase(), args: parts.slice(1), raw: text };
}

// ---------- 指令处理 ----------

async function handleHelpCommand() {
  return [
    `📋 ${config.bot.name} - 财务审批指令`,
    '',
    '  /approval-help    显示此帮助',
    '  /approval-list    查看所有申请',
    '  /approval-pending 查看审批中列表',
    '  /approval-status  查看审批统计',
    '',
    `使用方式：群聊中先 @${config.bot.name} 再发送指令`,
    '定时播报：每周一 18:00 财务催办周报（催发票/报销单/转账）',
  ].join('\n');
}

function briefLine(item, index, { withStatus = false } = {}) {
  const f = item.fields || {};
  const no = fieldText(f['申请编号']) || item.record_id;
  const applicant = (f['发起人']?.[0]?.name) || '未知';
  const goods = fieldText(f['购买物资名称'], '未填写').slice(0, 20);
  const amount = fieldText(f['总金额'], '');
  const money = amount ? `${amount}${fieldText(f['总金额-币种'], '')}` : '未填写';
  const status = fieldText(f['申请状态'], '未知');
  const parts = [`${index + 1}. ${no} | ${applicant} | ${goods} | ${money}`];
  if (withStatus) parts.push(status);
  return parts.join(' | ');
}

async function handleListCommand() {
  const list = await approvalService.getAllApprovals();
  if (!list.length) return '暂无申请记录';

  // 审批中在前，其余按发起时间倒序
  const PENDING = config.approvalStatus.PENDING;
  const sorted = [...list].sort((a, b) => {
    const pa = a.fields?.['申请状态'] === PENDING ? 0 : 1;
    const pb = b.fields?.['申请状态'] === PENDING ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (b.fields?.['发起时间'] || 0) - (a.fields?.['发起时间'] || 0);
  });

  const lines = sorted.slice(0, 30).map((item, i) => briefLine(item, i, { withStatus: true }));
  const more = sorted.length > 30 ? `\n…共 ${sorted.length} 条，仅显示前 30 条` : '';
  return ['📋 全部申请（审批中在前）:', ...lines].join('\n') + more;
}

async function handlePendingCommand() {
  const list = await approvalService.getPendingApprovals();
  if (!list.length) return '✅ 暂无审批中的申请';

  const lines = list.map((item, i) => briefLine(item, i));
  return [`⏳ 审批中（${list.length} 条）:`, ...lines].join('\n');
}

async function handleStatusCommand() {
  const { stats } = await approvalService.getApprovalStats();
  return [
    '📊 审批统计:',
    `累计申请: ${stats.total}`,
    `审批中: ${stats.pending}`,
    `已通过: ${stats.approved}`,
    `已拒绝: ${stats.rejected}`,
    `其他（撤回/取消/终止/删除）: ${stats.other}`,
    `本周新增: ${stats.weekNew}`,
    `本周通过: ${stats.weekApproved}`,
    `本周拒绝: ${stats.weekRejected}`,
  ].join('\n');
}

const commandHandlers = {
  '/approval-help': handleHelpCommand,
  '/approval-list': handleListCommand,
  '/approval-pending': handlePendingCommand,
  '/approval-status': handleStatusCommand,
};

/**
 * 执行指令并返回回复文本（群聊消息与 HTTP 转发共用）
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string|null>} 未匹配指令返回 null
 */
async function executeCommand(command, args = []) {
  // 审批群内 /help 即为财务帮助
  if (command === '/help') command = '/approval-help';
  const handler = commandHandlers[command];
  if (!handler) return null;
  try {
    return await handler(args);
  } catch (err) {
    console.error(`[对话服务] 指令执行失败 ${command}:`, err);
    return `❌ 指令执行失败：${err.message}`;
  }
}

// ---------- 消息事件入口 ----------

/**
 * 处理收到的聊天消息事件（长连接 / HTTP 回调通用）
 * 群隔离：仅目标群 + @机器人 的消息会被处理
 */
async function processChatMessage(data) {
  const message = data?.message;
  if (!message) return { handled: false, reason: '无消息内容' };

  const chatId = message.chat_id;
  const chatType = message.chat_type || message.chatMode;
  const messageId = message.message_id;

  // 消息去重（长连接与 HTTP 回调可能重复投递）
  if (messageId) {
    if (processedMessageIds.has(messageId)) {
      return { handled: false, reason: '重复消息' };
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 500) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }
  }

  // ---- 群隔离：本项目只服务审批群 ----
  if (chatType === 'p2p') {
    console.log('[对话服务] 跳过私聊消息（私聊对话能力属于正常群对话机器人）:', messageId);
    return { handled: false, reason: '私聊消息不处理' };
  }

  if (!config.bot.chatId || chatId !== config.bot.chatId) {
    console.log(`[对话服务] 跳过非目标群消息: chat_id=${chatId}`);
    return { handled: false, reason: '非目标群' };
  }

  const text = extractText(message);

  // 目标群内：@机器人，或直接发送 /approval-* / /help（命名空间隔离，无歧义）
  if (!isMentionedBot(message) && !text.startsWith('/approval-') && text !== '/help') {
    console.log('[对话服务] 跳过 - 目标群消息未@机器人且非审批指令');
    return { handled: false, reason: '未@机器人' };
  }

  console.log('[对话服务] 审批群收到消息:', text || '(非文本消息)');

  // 非文本消息（图片/文件等）@了机器人 → 给出指令提示
  if (!text) {
    await replySafely(messageId, chatId, `请发送文本指令，如 /approval-help`);
    return { handled: true };
  }

  const cmd = parseCommand(text);
  let replyText;

  if (cmd) {
    replyText = await executeCommand(cmd.command, cmd.args);
    if (!replyText) {
      replyText = `❌ 未知指令：${cmd.command}\n发送 /approval-help 查看可用指令`;
    }
  } else {
    // @了机器人但不是指令：简短引导（仅目标群，不影响其他群对话能力）
    replyText = `你好！我是${config.bot.name}，发送 /approval-help 查看审批查询指令。`;
  }

  await replySafely(messageId, chatId, replyText);

  return { handled: true, isCommand: !!cmd, command: cmd?.command || null, chatId };
}

async function replySafely(messageId, chatId, text) {
  try {
    await replyTextMessage(messageId, text);
  } catch (err) {
    console.error('[对话服务] 回复消息失败，降级为直接发送:', err.message);
    try {
      await sendTextToChat(chatId, text);
    } catch (err2) {
      console.error('[对话服务] 群聊发送也失败:', err2.message);
    }
  }
}

module.exports = {
  processChatMessage,
  executeCommand,
  isMentionedBot,
  parseCommand,
};
