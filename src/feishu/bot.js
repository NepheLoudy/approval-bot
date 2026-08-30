const config = require('../config');
const { requestAPI } = require('./client');

// ============================================================
// 消息发送层
// - 自动播报（新申请/结果/提醒/周播报）走群自定义机器人 Webhook
// - 指令回复走应用 IM API（回复消息 / 发送到指定群或私聊）
// 卡片字段全部对应审批多维表格「表单」表的真实字段
// ============================================================

async function sendToWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.warn('[机器人] 未配置 Webhook URL，跳过消息发送');
    return null;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(`Webhook 发送失败: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * 通过群自定义机器人 Webhook 发送卡片
 * @param {object} cardContent 卡片 JSON
 * @param {string} [webhookUrl] 可覆盖默认 webhook
 */
async function sendMessage(cardContent, webhookUrl) {
  return sendToWebhook(webhookUrl || config.bot.webhookUrl, {
    msg_type: 'interactive',
    card: cardContent,
  });
}

async function sendTextMessage(text, webhookUrl) {
  return sendToWebhook(webhookUrl || config.bot.webhookUrl, {
    msg_type: 'text',
    content: { text },
  });
}

// ---------- IM API（应用身份） ----------

async function sendTextToChat(chatId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送群消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

async function sendTextToUser(openId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送私聊消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

async function replyTextMessage(messageId, text) {
  const res = await requestAPI(
    'POST',
    `/im/v1/messages/${messageId}/reply`,
    {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`回复消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

// ---------- 字段格式化（审批表真实字段） ----------

function buildAtTag(openId) {
  if (!openId) return '';
  return `<at id="${openId}"></at>`;
}

/** 人员字段（User 数组）→ [{ id, name }] */
function getUsers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(Boolean)
    .map(u => ({ id: u.id || '', name: u.name || u.text || '未知' }));
}

/** 取第一个人员的 open_id（用于 @） */
function firstUserId(value) {
  return getUsers(value)[0]?.id || '';
}

/** 取第一个人员姓名 */
function firstUserName(value) {
  return getUsers(value)[0]?.name || '未知';
}

/** DateTime 字段（毫秒时间戳）→ 可读时间 */
function fmtTime(value) {
  if (!value) return '未知';
  const ms = typeof value === 'number' ? value : parseInt(value, 10);
  if (Number.isNaN(ms)) return String(value);
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 总金额 + 币种 */
function fmtMoney(fields) {
  const amount = fields['总金额'];
  if (amount === null || amount === undefined || amount === '') return '未填写';
  const currency = fields['总金额-币种'] || '';
  return `${amount}${currency ? ' ' + currency : ''}`;
}

function truncate(text, max = 60) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 附件/图片字段 → 摘要 */
function fmtAttachment(value) {
  if (!value) return '未上传';
  if (Array.isArray(value)) return value.length > 0 ? `${value.length} 个附件` : '未上传';
  return String(value);
}

// ---------- 卡片构建 ----------

/**
 * 新审批申请卡片（记录创建时推送）
 */
function buildNewApprovalCard(approval) {
  const fields = approval.fields || {};
  const applicantId = firstUserId(fields['发起人']);
  const applicantName = firstUserName(fields['发起人']);
  const department = fields['发起人部门'] || '未知部门';

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { content: '📋 新的采购/发票申请', tag: 'plain_text' },
    },
    elements: [
      {
        tag: 'markdown',
        content: `${buildAtTag(applicantId)} **${applicantName}**（${department}）提交了新申请`,
      },
      { tag: 'hr' },
      { tag: 'markdown', content: `**申请编号**：${fields['申请编号'] || approval.record_id || '未知'}` },
      { tag: 'markdown', content: `**物资名称**：${truncate(fields['购买物资名称']) || '未填写'}` },
      { tag: 'markdown', content: `**总金额**：${fmtMoney(fields)}` },
      { tag: 'markdown', content: `**项目**：${fields['项目'] || '未填写'}` },
      { tag: 'markdown', content: `**付款方式**：${fields['付款人'] || '未填写'}` },
      { tag: 'markdown', content: `**发起时间**：${fmtTime(fields['发起时间'])}` },
      { tag: 'hr' },
      { tag: 'markdown', content: `**审批节点**：${fields['审批节点'] || '待审批人处理'}` },
    ],
  };
}

/**
 * 审批结果卡片（状态变为 已通过/已拒绝 时推送）
 */
function buildApprovalResultCard(approval, status) {
  const fields = approval.fields || {};
  const applicantId = firstUserId(fields['发起人']);
  const applicantName = firstUserName(fields['发起人']);
  const isApproved = status === config.approvalStatus.APPROVED;

  return {
    config: { wide_screen_mode: true },
    header: {
      template: isApproved ? 'green' : 'red',
      title: {
        content: isApproved ? '✅ 审批通过' : '❌ 审批被拒绝',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `${buildAtTag(applicantId)} **${applicantName}** 的申请已处理完成`,
      },
      { tag: 'hr' },
      { tag: 'markdown', content: `**申请编号**：${fields['申请编号'] || approval.record_id || '未知'}` },
      { tag: 'markdown', content: `**物资名称**：${truncate(fields['购买物资名称']) || '未填写'}` },
      { tag: 'markdown', content: `**总金额**：${fmtMoney(fields)}` },
      { tag: 'markdown', content: `**完成时间**：${fmtTime(fields['完成时间'] || fields['发起时间'])}` },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: isApproved
          ? '💸 请按流程完成报销/转账等后续事项'
          : '📄 详情请在多维表格或审批中心查看',
      },
    ],
  };
}

/**
 * 每日待审批提醒卡片（审批中记录 + @当前处理人）
 * @param {Array} pendingList 审批中记录
 * @param {string[]} fallbackMentionIds 当前处理人为空时的回落 @ 目标
 */
function buildReminderCard(pendingList, fallbackMentionIds = []) {
  const handlerIds = new Set();
  for (const item of pendingList) {
    for (const u of getUsers(item.fields?.['当前处理人'])) {
      if (u.id) handlerIds.add(u.id);
    }
  }
  if (handlerIds.size === 0) {
    for (const id of fallbackMentionIds) handlerIds.add(id);
  }

  const mentionLine = handlerIds.size > 0
    ? [...handlerIds].map(id => buildAtTag(id)).join(' ')
    : '';

  const lines = pendingList.map((item, i) => {
    const f = item.fields || {};
    return `${i + 1}. **${f['申请编号'] || item.record_id}** | ${firstUserName(f['发起人'])} | ${truncate(f['购买物资名称']) || '未填写'} | ${fmtMoney(f)} | ${fmtTime(f['发起时间'])}`;
  });

  const elements = [
    {
      tag: 'markdown',
      content: `**⏳ 每日待审批提醒**（${new Date().toLocaleDateString('zh-CN')}）`,
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `当前共有 **${pendingList.length} 条**申请处于「审批中」，请及时处理：`,
    },
  ];

  if (mentionLine) {
    elements.push({ tag: 'markdown', content: mentionLine });
  }
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: lines.join('\n') });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { content: '⏰ 待审批提醒', tag: 'plain_text' },
    },
    elements,
  };
}

/**
 * 每周播报卡片：审批统计 + 待审批列表
 */
function buildBroadcastCard(stats, pendingList, options = {}) {
  const { date, weekNewCount } = options;
  const elements = [
    {
      tag: 'markdown',
      content: `**📊 审批周播报**\n${date || new Date().toLocaleDateString('zh-CN')}`,
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: [
        `**📈 审批统计**`,
        `- 累计申请：${stats.total} 条`,
        `- 审批中：${stats.pending} 条`,
        `- 已通过：${stats.approved} 条`,
        `- 已拒绝：${stats.rejected} 条`,
        `- 其他（撤回/取消/终止/删除）：${stats.other} 条`,
        weekNewCount !== undefined ? `- 本周新增：${weekNewCount} 条` : '',
      ].filter(Boolean).join('\n'),
    },
  ];

  if (pendingList && pendingList.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**⏳ 待审批列表（${pendingList.length} 条）**`,
    });
    const lines = pendingList.map((item, i) => {
      const f = item.fields || {};
      const handler = firstUserName(f['当前处理人']);
      const at = buildAtTag(firstUserId(f['当前处理人']));
      return `${i + 1}. **${f['申请编号'] || item.record_id}** - ${at} ${firstUserName(f['发起人'])} | ${truncate(f['购买物资名称']) || '未填写'} | ${fmtMoney(f)}\n   发起时间：${fmtTime(f['发起时间'])}${handler !== '未知' ? ` | 处理人：${handler}` : ''}`;
    });
    elements.push({ tag: 'markdown', content: lines.join('\n') });
  } else if (stats.pending === 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: '✅ 暂无审批中的申请' });
  }

  return {
    config: { wide_screen_mode: true },
    elements,
    header: {
      template: stats.pending > 0 ? 'orange' : 'green',
      title: { content: '📋 审批播报', tag: 'plain_text' },
    },
  };
}

async function sendCardToChat(chatId, cardContent) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送群卡片消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

/**
 * 发送周播报（兼容旧接口签名）
 */
async function sendBroadcast(stats, pendingList, options = {}) {
  const card = buildBroadcastCard(stats, pendingList, options);
  return sendMessage(card, options.webhookUrl);
}

module.exports = {
  sendMessage,
  sendTextMessage,
  sendTextToChat,
  sendTextToUser,
  replyTextMessage,
  sendCardToChat,
  sendBroadcast,
  buildNewApprovalCard,
  buildApprovalResultCard,
  buildReminderCard,
  buildBroadcastCard,
  // 字段格式化工具（供其他服务复用）
  fmtTime,
  fmtMoney,
  getUsers,
  firstUserId,
  firstUserName,
  truncate,
};
