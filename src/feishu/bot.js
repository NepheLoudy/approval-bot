const config = require('../config');
const { requestAPI } = require('./client');
const { fieldText } = require('../utils/fields');

// ============================================================
// 消息发送层
// - 定时播报（周播报催办清单 / 每日待审批提醒）走群自定义机器人 Webhook
//   （不做事件即时播报：审批提交/审批结果都不推）
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 总金额 + 币种 */
function fmtMoney(fields) {
  const amount = fieldText(fields['总金额'], '');
  if (!amount) return '未填写';
  const currency = fieldText(fields['总金额-币种'], '');
  return `${amount}${currency ? ' ' + currency : ''}`;
}

function truncate(text, max = 40) {
  const s = fieldText(text).trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------- 周播报卡片：财务催办清单 ----------

/** 申请编号 → markdown 超链接（Url 字段的 link 即审批实例链接，财务可点击直达审批详情页） */
function fmtNoMarkdown(fields, recordId) {
  const raw = fields['申请编号'];
  const no = fieldText(raw) || recordId;
  const link = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.link : '';
  return link ? `[${no}](${link})` : no;
}

/** 催发票状态徽标（无法提交 / 延期中 / 已催次数），供周报展示给财务 */
function invoiceStatusBadge(state) {
  if (!state) return '';
  if (state.status === 'cannot_submit') return '**[无法提交]** ';
  if (state.status === 'deferred' && (state.snoozeUntil || 0) > Date.now()) {
    return `**[已延期至 ${fmtDayShort(state.snoozeUntil)}]** `;
  }
  if ((state.urgeCount || 0) > 0) {
    return state.status === 'escalated'
      ? `**[已催满${state.urgeCount}次]** `
      : `[已催${state.urgeCount}次] `;
  }
  return '';
}

function fmtDayShort(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/** 催办条目通用行（单号带审批链接；urgeStates 提供时未交票行带状态徽标） */
function followUpLine(record, index, timeField, urgeStates) {
  const f = record.fields || {};
  const badge = urgeStates ? invoiceStatusBadge(urgeStates[record.record_id]) : '';
  const timeLabel = timeField === '完成时间' ? '完成' : '发起';
  return `${index + 1}. ${badge}${fmtNoMarkdown(f, record.record_id)} | ${firstUserName(f['发起人'])} | ${truncate(f['购买物资名称']) || '未填写'} | ${fmtMoney(f)} | ${timeLabel}：${fmtTime(f[timeField] || f['发起时间'])}`;
}

/** 分段渲染（超过上限折叠，避免卡片超限） */
function renderSection(elements, { title, records, timeField, cap = 15, note, urgeStates }) {
  elements.push({ tag: 'hr' });
  if (!records || records.length === 0) {
    elements.push({ tag: 'markdown', content: `${title}：✅ 无` });
    return;
  }
  elements.push({
    tag: 'markdown',
    content: `${title}（**${records.length} 条**）${note || ''}`,
  });
  const lines = records.slice(0, cap).map((r, i) => followUpLine(r, i, timeField, urgeStates));
  if (records.length > cap) {
    lines.push(`…其余 ${records.length - cap} 条请在多维表格中查看`);
  }
  elements.push({ tag: 'markdown', content: lines.join('\n') });
}

/**
 * 周播报卡片：财务催办清单
 * 结构：@财务 → 三段催办（催发票/催报销单/催转账）→ 底部本周统计（仅本周结果+按项目分布）
 * @param {object} followUp { missingInvoice, missingForm, missingTransfer }
 * @param {object} stats 含 weekNew/weekApproved/weekRejected
 * @param {object} [options.projects] { new, approved, rejected } 各为 [{project, count}]（按项目粗分类）
 * @param {object} [options.urgeStates] { record_id: 催发票私聊状态 }（未交票行状态徽标）
 */
function buildWeeklyFinanceCard(followUp, stats, options = {}) {
  const { date } = options;
  const elements = [];

  // 抬头：@财务负责人
  const mentionIds = (options.mentionIds || []).filter(Boolean);
  const mentionLine = mentionIds.length > 0
    ? mentionIds.map(id => buildAtTag(id)).join(' ') + '\n'
    : '';
  elements.push({
    tag: 'markdown',
    content: `**🧾 财务催办周报**\n${date || new Date().toLocaleDateString('zh-CN')}\n${mentionLine}以下为「已通过」申请的后续财务环节待办：`,
  });

  // 1. 未交发票 → 催发票（单号带审批链接 + 私聊状态徽标：无法提交/已延期/已催N次）
  renderSection(elements, {
    title: '🧾 未交发票（需催发票）',
    records: followUp.missingInvoice,
    timeField: '发起时间',
    urgeStates: options.urgeStates,
  });

  // 2. 已有发票但未制单 → 做报销单
  renderSection(elements, {
    title: '📄 未制单（需做报销单）',
    records: followUp.missingForm,
    timeField: '发起时间',
    note: '（已有发票，报销单未填写）',
  });

  // 3. 已有发票和报销单但未转账（完成超3个月）→ 提醒转账
  renderSection(elements, {
    title: '💸 未转账（需跟进转账）',
    records: followUp.missingTransfer,
    timeField: '完成时间',
    note: '（完成时间已超 3 个月）',
  });

  // 底部：本周统计（仅本周结果，不放全量数据）+ 按项目粗分类
  elements.push({ tag: 'hr' });
  const statLines = [
    `**📊 本周统计（近7天）**`,
    `- 本周新增申请：${stats.weekNew ?? 0} 条`,
    `- 本周通过：${stats.weekApproved ?? 0} 条`,
    `- 本周拒绝：${stats.weekRejected ?? 0} 条`,
  ];
  const projectLine = (label, groups) => {
    if (!groups || !groups.length) return null;
    return `- ${label}项目分布：${groups.map(g => `${g.project} ${g.count} 条`).join('、')}`;
  };
  const distribution = [
    projectLine('新增', options.projects?.new),
    projectLine('通过', options.projects?.approved),
    projectLine('拒绝', options.projects?.rejected),
  ].filter(Boolean);
  if (distribution.length) {
    statLines.push(distribution.join('\n'));
  }
  elements.push({ tag: 'markdown', content: statLines.join('\n') });

  const hasPendingWork = followUp.missingInvoice.length + followUp.missingForm.length + followUp.missingTransfer.length > 0;

  return {
    config: { wide_screen_mode: true },
    elements,
    header: {
      template: hasPendingWork ? 'orange' : 'green',
      title: { content: '🧾 财务催办周报', tag: 'plain_text' },
    },
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
    return `${i + 1}. **${fieldText(f['申请编号']) || item.record_id}** | ${firstUserName(f['发起人'])} | ${truncate(f['购买物资名称']) || '未填写'} | ${fmtMoney(f)} | ${fmtTime(f['发起时间'])}`;
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
 * 发票催交播报卡片（/approval-urge 触发私聊后展示）：说清楚刚才私聊催了哪些未开票记录
 * 单号带审批链接、行带私聊状态徽标；未私聊部分（延期/无法提交/已催满）只做数字汇总。
 * （未制单/未转账的列表播报属于周报职能，不进本卡。）
 * @param {object} params { urgedRecords, statusCounts, date, urgeStates }
 */
function buildInvoiceUrgeReportCard({ urgedRecords = [], statusCounts = {}, date, urgeStates } = {}) {
  const elements = [];

  elements.push({
    tag: 'markdown',
    content:
      `**🔔 发票催交播报**（${date || new Date().toLocaleDateString('zh-CN')}）\n` +
      `本次已私聊催交 **${urgedRecords.length} 条**未开票记录，申请人回复将自动识别` +
      `（「延期」3 天内免催 /「无法提交」停催转财务）：`,
  });

  renderSection(elements, {
    title: '🧾 未开票（本次已私聊催交）',
    records: urgedRecords,
    timeField: '完成时间',
    urgeStates,
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content:
      `⏸ 未私聊 ${statusCounts.deferred + statusCounts.cannotSubmit + statusCounts.escalated} 条：` +
      `延期中 ${statusCounts.deferred || 0} · 无法提交 ${statusCounts.cannotSubmit || 0} · 已催满 ${statusCounts.escalated || 0}（等待财务跟进）`,
  });

  return {
    config: { wide_screen_mode: true },
    elements,
    header: {
      template: urgedRecords.length ? 'orange' : 'green',
      title: { content: '🔔 发票催交播报', tag: 'plain_text' },
    },
  };
}

/**
 * 手动催办卡片（/approval-urge 报销单|转账 显式触发）：按需渲染未制单/未转账段，@财务
 * （未开票不进此卡片——该分支的催办能力是私聊发起人，播报走 buildInvoiceUrgeReportCard）
 * @param {object} params { missingForm, missingTransfer, mentionIds }
 */
function buildUrgeCard({ missingForm = [], missingTransfer = [], mentionIds = [] } = {}) {
  const elements = [];
  const mentionLine = (mentionIds || []).filter(Boolean).map(buildAtTag).join(' ');
  elements.push({
    tag: 'markdown',
    content: `**🔔 财务催办**（手动触发 ${new Date().toLocaleDateString('zh-CN')}）\n${mentionLine}${mentionLine ? '\n' : ''}以下为「已通过」申请的待催办环节：`,
  });

  renderSection(elements, {
    title: '📄 未制单（需做报销单）',
    records: missingForm,
    timeField: '发起时间',
    note: '（已有发票，报销单未填写）',
  });

  renderSection(elements, {
    title: '💸 未转账（需跟进转账）',
    records: missingTransfer,
    timeField: '完成时间',
    note: '（完成时间已超 3 个月）',
  });

  const hasPendingWork = missingForm.length + missingTransfer.length > 0;

  return {
    config: { wide_screen_mode: true },
    elements,
    header: {
      template: hasPendingWork ? 'orange' : 'green',
      title: { content: '🔔 财务催办', tag: 'plain_text' },
    },
  };
}

/**
 * 催发票私聊文案（发给申请发起人，一人一条可含多笔）
 * 「申请编号」是 Url 字段，其 link 即审批实例链接（打开审批详情页，非表格链接）；
 * 无链接时退化为纯文字条目。
 * @param {Array<{record_id, fields}>} records 该发起人名下超期未交发票的记录
 */
function buildInvoiceUrgeText(records) {
  const lines = records.map((record, i) => {
    const f = record.fields || {};
    const no = fieldText(f['申请编号']) || record.record_id;
    const noObj = f['申请编号'];
    const link = noObj && typeof noObj === 'object' && !Array.isArray(noObj) ? noObj.link : '';
    const goods = truncate(f['购买物资名称'], 30) || '未填写物资名称';
    const item = `${i + 1}. ${no} | ${goods} | ${fmtMoney(f)} | 完成于 ${fmtTime(f['完成时间'])}`;
    return link ? `${item}\n   审批入口：${link}` : item;
  });

  return [
    `🧾 发票催交提醒`,
    '',
    `您有 ${records.length} 笔已通过的申请，完成已满 ${config.invoiceUrge.graceDays} 天仍未提交发票：`,
    '',
    ...lines,
    '',
    '请点击上方「审批入口」打开对应申请的审批详情页（审批界面，非表格），尽快补交发票；已线下递交的请忽略本提醒。',
  ].join('\n');
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

module.exports = {
  sendMessage,
  sendTextMessage,
  sendTextToChat,
  sendTextToUser,
  replyTextMessage,
  sendCardToChat,
  buildWeeklyFinanceCard,
  buildReminderCard,
  buildUrgeCard,
  buildInvoiceUrgeReportCard,
  buildInvoiceUrgeText,
  // 字段格式化工具（供其他服务复用）
  fmtTime,
  fmtMoney,
  getUsers,
  firstUserId,
  firstUserName,
  truncate,
};
