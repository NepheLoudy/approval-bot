const config = require('../config');
const { requestAPI } = require('./client');

async function sendMessage(cardContent) {
  const webhookUrl = config.bot.webhookUrl;

  if (!webhookUrl) {
    console.warn('未配置机器人 Webhook URL，跳过消息发送');
    return null;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: cardContent,
    }),
  });

  const data = await res.json();

  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(`发送消息失败: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendTextMessage(text) {
  const webhookUrl = config.bot.webhookUrl;

  if (!webhookUrl) {
    console.warn('未配置机器人 Webhook URL，跳过消息发送');
    return null;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msg_type: 'text',
      content: {
        text: text,
      },
    }),
  });

  const data = await res.json();

  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(`发送消息失败: ${JSON.stringify(data)}`);
  }

  return data;
}

function buildAtTag(userId) {
  if (!userId) return '';
  return `<at id="${userId}"></at>`;
}

function buildApprovalAlertCard(approval) {
  const applicantName = approval.fields['发起人']?.[0]?.name || '未知用户';
  const applicantId = approval.fields['发起人']?.[0]?.id || '';
  const startTime = approval.fields['发起时间'];
  const approvalNo = approval.fields['申请编号'] || '未知编号';

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: [
      {
        tag: 'markdown',
        content: `**📋 新的审批申请**`,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `${buildAtTag(applicantId)} **发起人**: ${applicantName}`,
      },
      {
        tag: 'markdown',
        content: `**申请编号**: ${approvalNo}`,
      },
      {
        tag: 'markdown',
        content: `**发起时间**: ${startTime || '未指定'}`,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**审批者**: 请在多维表格中查看详情并处理审批`,
      },
    ].filter(Boolean),
    header: {
      template: 'blue',
      title: {
        content: '📝 审批申请通知',
        tag: 'plain_text',
      },
    },
  };
}

function buildApprovalResultCard(approval, result, comment) {
  const applicantName = approval.fields['发起人']?.[0]?.name || '未知用户';
  const applicantId = approval.fields['发起人']?.[0]?.id || '';
  const approvalNo = approval.fields['申请编号'] || '未知编号';

  const isApproved = result === config.approvalStatus.APPROVED;

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: [
      {
        tag: 'markdown',
        content: isApproved ? `**✅ 审批通过**` : `**❌ 审批驳回**`,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `${buildAtTag(applicantId)} **发起人**: ${applicantName}`,
      },
      {
        tag: 'markdown',
        content: `**申请编号**: ${approvalNo}`,
      },
      {
        tag: 'markdown',
        content: `**审批意见**: ${comment || '无'}`,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: isApproved
          ? '📝 您的申请已通过审批'
          : '📝 您的申请被驳回，请修改后重新提交',
      },
    ],
    header: {
      template: isApproved ? 'green' : 'red',
      title: {
        content: '📝 审批结果通知',
        tag: 'plain_text',
      },
    },
  };
}

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

function buildBroadcastCard(stats, pendingList, options = {}) {
  const { date } = options;
  const elements = [];

  elements.push({
    tag: 'markdown',
    content: `**📢 审批每日播报**\n${date || new Date().toLocaleDateString('zh-CN')}`,
  });

  elements.push({ tag: 'hr' });

  elements.push({
    tag: 'markdown',
    content: `**📊 审批统计**\n- 总计: ${stats.total} 条\n- 待审批: ${stats.pending} 条\n- 已通过: ${stats.approved} 条\n- 已驳回: ${stats.rejected} 条`,
  });

  if (pendingList && pendingList.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**⏳ 待审批列表（${pendingList.length}条）**`,
    });

    const lines = pendingList.map((item, index) => {
      const no = item.fields['申请编号'] || '未知';
      const applicant = item.fields['发起人']?.[0]?.name || '未知';
      const time = item.fields['发起时间'] || '未知';
      const applicantId = item.fields['发起人']?.[0]?.id || '';
      const at = buildAtTag(applicantId);
      return `${index + 1}. ${no} - ${at} ${applicant}\n   发起时间: ${time}`;
    });

    elements.push({
      tag: 'markdown',
      content: lines.join('\n'),
    });
  } else if (stats.pending === 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: '✅ 暂无待审批的申请，继续保持！',
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements,
    header: {
      template: stats.pending > 0 ? 'orange' : 'green',
      title: {
        content: '📋 审批播报',
        tag: 'plain_text',
      },
    },
  };
}

async function sendBroadcast(stats, pendingList, options = {}) {
  const { webhookUrl } = options;
  const card = buildBroadcastCard(stats, pendingList, options);
  return sendMessage(card, webhookUrl);
}

module.exports = {
  sendMessage,
  sendTextMessage,
  buildApprovalAlertCard,
  buildApprovalResultCard,
  buildBroadcastCard,
  sendBroadcast,
  sendTextToChat,
  sendTextToUser,
  sendCardToChat,
};
