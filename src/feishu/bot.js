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
    signal: AbortSignal.timeout(15000), // 裸 fetch 无超时会卡死静默冲刷/定时任务链
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
    throw new Error(`发送私聊消息失败: ${res.msg} (code: ${res.code})${availabilityHint(res.code)}`);
  }
  return res.data;
}

/**
 * 发送富文本（post）私聊：rows 为二维数组，每行是元素数组
 * 元素：{tag:'text', text} / {tag:'a', text, href}（post 里超链接才可点击渲染）
 */
async function sendPostToUser(openId, title, rows) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: openId,
      msg_type: 'post',
      content: JSON.stringify({ post: { zh_cn: { title, content: rows } } }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送私聊富文本失败: ${res.msg} (code: ${res.code})${availabilityHint(res.code)}`);
  }
  return res.data;
}

// 230013 = 机器人对该用户不可用：飞书「应用可用范围」不含对方，属平台 ACL，API 无法绕过
function availabilityHint(code) {
  return code === 230013
    ? ' —— 对方不在应用可用范围内，需管理员在飞书开发者后台把「可用范围」改为全员（或加入对方）'
    : '';
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
  // 统一消毒（对抗审查 P2-2：队员可控的物资名称/项目名等直拼三张财务卡 markdown，
  // 可伪造 @/链接——truncate 是全部卡片文本的必经口，在这里剥一次全覆盖）
  const s = stripCardInjection(fieldText(text).trim());
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

/** 催发票状态徽标（无法提交 / 已退队 / 延期中 / 已催次数），供周报展示给财务 */
function invoiceStatusBadge(state) {
  if (!state) return '';
  if (state.status === 'cannot_submit') return '**[无法提交]** ';
  if (state.status === 'resigned') return '**[发起人已退队]** ';
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

  // 4. 报销台账（发票采集/批次工作状态，2026-09-25 起；采集服务异常时缺省跳过）
  if (options.ledger) {
    const L = options.ledger;
    const ledgerLines = ['**📚 报销台账（采集/批次工作状态）**', `- 票池待归集：${L.poolCount} 张 ¥${Number(L.poolAmount).toFixed(2)}（/approval-batch 锁定成批）`];
    for (const [status, s] of Object.entries(L.batches || {})) {
      ledgerLines.push(`- ${status}：${s.count} 批 ¥${Number(s.amount).toFixed(2)}`);
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: ledgerLines.join('\n') });
  }

  // 5. 批次推进超期（2026-09-29 曼波定）：锁定后超 staleDays 天未到账，财务照单跟进
  if (Array.isArray(options.overdueBatches) && options.overdueBatches.length) {
    const ob = options.overdueBatches;
    const obLines = [`**⏳ 批次推进超期**（锁定超 ${config.batch.staleDays} 天未到账，共 ${ob.length} 批）`];
    for (const b of ob.slice(0, 8)) {
      const safeNo = stripCardInjection(b.batchNo);
      const safeProj = stripCardInjection(b.project);
      obLines.push(`- ${safeNo}（${safeProj}）：${b.count} 张 ¥${Number(b.amount).toFixed(2)}【${b.status}】锁定于 ${new Date(b.lockedAt).toLocaleDateString('zh-CN')}${b.taker ? ` 接取:${stripCardInjection(b.taker)}` : ''}`);
    }
    if (ob.length > 8) obLines.push(`- …另有 ${ob.length - 8} 批超期（详见报销批次表）`);
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: obLines.join('\n') });
  }

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
 * 今日已催播报卡片（每日私聊催交后独立播报，与周报能力分开）：
 *   1. 今日已私聊催交的未开票明细（单号超链接 + 状态徽标）
 *   2. ⚠️ 需财务关注：多次催交仍无票 / 回复得知无法提交 / 发起人已退队 的记录（重点提醒段）
 *   3. 未私聊数字汇总（延期中/无法提交/已催满/已退队）
 * @param {object} params { urgedRecords, attention, statusCounts, date, urgeStates }
 *   attention: [{ record, reasons: ['无法提交','已催2次',...] }]
 */
function buildTodayUrgedCard({ urgedRecords = [], attention = [], statusCounts = {}, date, urgeStates } = {}) {
  const elements = [];
  const attentionCount = attention.length;

  elements.push({
    tag: 'markdown',
    content:
      `**🔔 今日已催**（${date || new Date().toLocaleDateString('zh-CN')}）\n` +
      `今日已私聊催交 **${urgedRecords.length} 条**未开票记录，申请人回复将自动识别` +
      `（「延期」可带时长，如「延期 7 天」「延期两周」，默认 ${config.invoiceUrge.deferDays} 天内免催 /「无法提交」停催转财务）：`,
  });

  renderSection(elements, {
    title: '🧾 今日已私聊催交',
    records: urgedRecords,
    timeField: '完成时间',
    urgeStates,
  });

  elements.push({ tag: 'hr' });
  if (attentionCount) {
    elements.push({ tag: 'markdown', content: `**⚠️ 需财务关注（${attentionCount} 条）**` });
    const lines = attention.map(({ record, reasons }, i) => {
      const f = record.fields || {};
      return `${i + 1}. **「${reasons.join('、')}」** ${fmtNoMarkdown(f, record.record_id)} | ${firstUserName(f['发起人'])} | ${truncate(f['购买物资名称']) || '未填写'} | ${fmtMoney(f)} | 完成于 ${fmtTime(f['完成时间'])}`;
    });
    elements.push({ tag: 'markdown', content: lines.join('\n') });
  } else {
    elements.push({ tag: 'markdown', content: '**⚠️ 需财务关注**：✅ 暂无' });
  }

  elements.push({ tag: 'hr' });
  const deferred = statusCounts.deferred || 0;
  const cannotSubmit = statusCounts.cannotSubmit || 0;
  const escalated = statusCounts.escalated || 0;
  const resigned = statusCounts.resigned || 0;
  const intervalHold = statusCounts.intervalHold || 0;
  elements.push({
    tag: 'markdown',
    content:
      `⏸ 今日未私聊 ${deferred + cannotSubmit + escalated + resigned + intervalHold} 条：` +
      `延期中 ${deferred} · 无法提交 ${cannotSubmit} · 已催满 ${escalated} · 已退队 ${resigned} · 间隔未到 ${intervalHold}`,
  });

  return {
    config: { wide_screen_mode: true },
    elements,
    header: {
      template: attentionCount ? 'red' : urgedRecords.length ? 'orange' : 'green',
      title: { content: '🔔 今日已催', tag: 'plain_text' },
    },
  };
}

/**
 * 手动催办卡片（/approval-urge 报销单|转账 显式触发）：按需渲染未制单/未转账段，@财务
 * （未开票不进此卡片——该分支的催办能力是私聊发起人，播报走 buildTodayUrgedCard）
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
 * 交付卡注入消毒（2026-09-27 对抗审查 P2）：project/summary 等字段源头是表格数据
 * （队员/财务可写），剥掉 <at> 标记与 markdown 链接语法（保留链接文本），
 * 防伪造 @人 / 钓鱼链接经交付卡注入群消息。
 */
function stripCardInjection(s) {
  return String(s || '')
    .replace(/<at[^>]*>/gi, '')
    .replace(/<\/at>/gi, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * 报销交付卡（锁定批次后审批群播报）：四件附件清单 + 摘要草稿 + 接取指引。
 * 附件本体在多维表格「报销批次」表该行（打印文件/BOM表/物料清单/投递底单 等列）。
 * 2026-09-29 曼波定：卡内直接按序内嵌全部有效发票二维码（imageKey 由 sendDeliveryCard
 * 预先上传换得），财务对屏幕按序号扫码即可完成录入；自动触发场景头部/文案切换。
 */
function buildDeliveryCard({ batchNo, project = '', count = 0, amount = 0, summary = '', warningCount = 0, missingContent = 0, specialCount = 0, auto = false, scanItems = [], abnormalItems = [], generated = {} } = {}) {
  // 表链接带租户子域（复查 P2-13：feishu.cn 裸域打不开，链接须落在租户域名下才能直达表）
  const tableUrl = config.bitable.appToken
    ? `${config.feishu.tenantBaseUrl}/base/${config.bitable.appToken}?table=${config.bitable.batchTableId}`
    : '';
  const mark = (ok, label, desc) => `- ${ok ? '✅' : '⚠️'} **${label}** — ${desc}${ok ? '' : '（生成失败，可 /approval-batch regen 重试）'}`;
  // 外部可影响字段先消毒再拼 markdown（复查 P2-16）
  const safeProject = stripCardInjection(project);
  const safeSummary = stripCardInjection(summary);
  // 批次号含项目段（自动批次号=自动-<项目>-MMDD），进 markdown/标题前消毒（对抗审查 P2-3）
  const safeBatchNo = stripCardInjection(batchNo);

  const lines = [
    auto
      ? `🤖 本批次由制单金额线**自动触发**生成（项目未制单发票满额），请接取后按序完成录入与打印`
      : `**项目** ${safeProject || '—'} ｜ **张数** ${count} ｜ **金额合计** ¥${Number(amount).toFixed(2)}`,
    '',
    `**摘要**（录入学校系统时直接复制）：`,
    `${safeSummary || '（未生成）'}`,
    '',
  ];

  // 按序内嵌全部有效二维码：每行两票，序号+金额+尾号+码，严格按录入顺序。
  // 上限保护（对抗审查：超大批次内嵌图过多会撑爆卡片/上传拖慢交付卡）——
  // 超出部分由「扫码清单」附件兜底（序号连续不跳号）
  const QR_CARD_LIMIT = 24;
  const validQrs = (scanItems || []).filter(q => q.valid && q.imageKey).slice(0, QR_CARD_LIMIT);
  if (validQrs.length) {
    lines.push(`**🎯 发票二维码（${validQrs.length} 张，严格按录入顺序扫码录入）**：`, '');
    for (let i = 0; i < validQrs.length; i += 2) {
      lines.push(validQrs.slice(i, i + 2).map(q => `**#${q.seq}** ${q.amountText} 尾号${q.tail} ![二维码 #140px #140px](${q.imageKey})`).join('　'));
    }
  }
  const invalidCount = (scanItems || []).length - validQrs.length;
  if (invalidCount > 0) lines.push(``, `⚠️ 另有 ${invalidCount} 张票未在本卡展示（二维码不可重建或超出卡片容量），序号连续不跳号，见「扫码清单」附件（红字标注的请扫其纸质原件）`);

  lines.push(
    `**📎 交付文件**（「报销批次」表该行附件下载）：${tableUrl ? `[打开报销批次表](${tableUrl})` : ''}`,
    mark(generated.pdf, '打印文件', '按录入顺序一页两票，照序扫描'),
    mark(generated.scanSheet, '扫码清单', '按序二维码 docx（屏幕/打印皆可扫），照单依次扫码'),
    mark(generated.bom, 'BOM表', '内部核对（物资/型号/金额/发票对照）'),
    mark(generated.materialList, '物料清单', '校格式（序号/项目/金额/用途/采购类型），交学校'),
    mark(generated.deliverySheet, '投递底单', '学校系统填报预填稿，照单录入小翼Plus'),
    mark(generated.printDocx, '打印件 docx', '可编辑版（Word 里可调可删后打印）'),
    mark(generated.specialSheet, '特殊事项附页', `${specialCount} 张（大额/公私属性不分明/有支付记录），单独成页`),
  );
  if (warningCount > 0) {
    lines.push(``, `⚠️ 含 ${warningCount} 张异常票（录入时留意）：`, ...abnormalItemLines(abnormalItems));
  }
  if (missingContent > 0) lines.push(`⚠️ ${missingContent} 张缺「开票内容」（底单已标黄），录入小翼Plus 时现场补填`);

  lines.push(
    ``,
    `👉 **认领：@机器人 回复「接取」**（可带批次号，如「接取 ${safeBatchNo}」）`,
    `✅ 录入完成后：/approval-batch submit ${safeBatchNo}`
  );

  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
    header: {
      template: 'orange',
      title: { content: `${auto ? '🤖 报销单已自动生成' : '📦 报销交付包'} · ${safeBatchNo}`, tag: 'plain_text' },
    },
  };
}

/** 异常票明细行（详情卡/交付卡共用，2026-09-29 曼波反馈：异常要带审批号超链接直跳审批页） */
function abnormalItemLines(abnormalItems, cap = 8) {
  if (!Array.isArray(abnormalItems) || !abnormalItems.length) return [];
  const lines = abnormalItems.slice(0, cap).map(a => {
    const safeNo = stripCardInjection(a.applyNo);
    // 协议白名单（对抗审查：applyLink 来自表格可写字段，非 https 一律不带链接只给文本）
    const linkOk = /^https:\/\//i.test(String(a.applyLink || ''));
    const link = linkOk ? ` → [${safeNo || '查看审批'}](${a.applyLink})` : (safeNo ? ` → ${safeNo}（无链接）` : ' → 未关联申请');
    const remark = a.remark ? `（${stripCardInjection(a.remark)}）` : '';
    return `- #${a.seq} ${a.amountText} 尾号${a.tail}「${stripCardInjection(a.verifyStatus)}」${remark}${link}`;
  });
  if (abnormalItems.length > cap) lines.push(`- …另有 ${abnormalItems.length - cap} 张异常票（见发票采集表「校验状态」列）`);
  return lines;
}

/**
 * 自动锁定详情卡（两阶段流程第一阶段，2026-09-29 曼波定）：金额线满额自动锁定后
 * 先只发批次详情等财务确认——确认（/approval-batch confirm）后才生成交付件并发二维码卡。
 * 无二维码、无附件清单（都还没生成）；要退有 reject 出口。
 */
function buildAutoLockNoticeCard({ batchNo, project = '', count = 0, amount = 0, summary = '', warningCount = 0, missingContent = 0, unCollected = 0, abnormalItems = [] } = {}) {
  const safeProject = stripCardInjection(project);
  const safeSummary = stripCardInjection(summary);
  const safeBatchNo = stripCardInjection(batchNo); // 自动批次号含项目段，消毒后再进卡（P2-3）
  const tableUrl = config.bitable.appToken
    ? `${config.feishu.tenantBaseUrl}/base/${config.bitable.appToken}?table=${config.bitable.batchTableId}`
    : '';
  const lines = [
    `**项目** ${safeProject || '—'} ｜ **张数** ${count} ｜ **金额合计** ¥${Number(amount).toFixed(2)}`,
    '',
    `**摘要**（录入学校系统时直接复制）：`,
    `${safeSummary || '（未生成）'}`,
    '',
    `📋 该项目「已开发票且未制单」金额已达红线，报销单号已生成、发票已自动归批打标。`,
    `**请核对以上明细**：`,
    `✅ 无误 → 回复 **/approval-batch confirm ${safeBatchNo}**（确认后立即生成 发票排版文件/物料清单/扫码清单，并下发二维码开始录入）`,
    `❌ 有误 → **/approval-batch reject ${safeBatchNo}**（整批退回票池，重新核对后触发下一批）`,
    tableUrl ? `📄 批次明细：[报销批次表](${tableUrl})` : '',
  ].filter(Boolean);
  if (warningCount > 0) {
    lines.push(``, `⚠️ 含 ${warningCount} 张异常票（校验状态非通过/金额无效），确认前逐张核对：`, ...abnormalItemLines(abnormalItems));
    if (abnormalItems.length && abnormalItems.length < warningCount) lines.push(`（明细仅 ${abnormalItems.length} 条，与计数不符时以采集表为准）`);
  }
  if (missingContent > 0) lines.push(`⚠️ ${missingContent} 张缺「开票内容」，录入时需现场补填`);
  // 发票/补交发票两列等效口径（2026-09-29 曼波定）：审批提交时直接附票的记录不在采集表，
  // 金额已计入本批触发，但无票面图片进不了打印批——如实提示，回溯采集后自动并入后续批次
  if (unCollected > 0) lines.push(`⚠️ 该项目另有 ${unCollected} 笔申请的发票在审批表「发票」列（审批时直接提交，未走采集、无票面图片），未计入本批；如需并入请先发票回溯采集，下一批自动打包`);

  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
    header: {
      template: 'orange',
      title: { content: `🖨️ 报销单已生成，待确认 · ${safeBatchNo}`, tag: 'plain_text' },
    },
  };
}

/**
 * 交付卡发送（人工 lock 与金额线自动锁定共用，2026-09-29）：
 * scanItems 里的有效票二维码逐张上传 IM 换 image_key 后内嵌卡片（严格按录入序）。
 * 单码上传失败降级（卡内不放、扫码清单附件兜底）；整体失败向上抛（调用方决定降级文案）。
 */
async function sendDeliveryCard(cardData) {
  const qrImages = [];
  for (const q of cardData.scanItems || []) {
    if (!q.valid || !q.png) continue;
    try {
      const imageKey = await client.uploadImageToIM(q.png);
      qrImages.push({ ...q, imageKey });
    } catch (err) {
      console.warn(`[交付卡] 二维码 #${q.seq} 上传失败（${err.message}），该码降级为扫码清单附件扫码`);
    }
  }
  // 走 exports 引用而非模块内直引（对抗审查补漏：直引绕过测试对 exports.sendMessage
  // 的桩，交付卡会真发到生产 webhook——tryQrChannel 同款陷阱）
  return module.exports.sendMessage(buildDeliveryCard({ ...cardData, scanItems: qrImages }));
}

/**
 * 催发票私聊富文本（发给申请发起人，一人一条可含多笔）
 * 「申请编号」是 Url 字段，其 link 即审批实例链接（打开审批详情页，非表格链接）；
 * post 富文本里超链接可点击，展示文本简化为「项目名 + 金额」。
 * @param {Array<{record_id, fields}>} records 该发起人名下超期未交发票的记录
 * @returns {{title: string, rows: Array<Array<object>>}} post 消息结构
 */
function buildInvoiceUrgePost(records) {
  const rows = [];

  rows.push([{ tag: 'text', text: `您有 ${records.length} 笔已通过的申请，完成已满 ${config.invoiceUrge.graceDays} 天仍未提交发票：` }]);

  records.forEach((record, i) => {
    const f = record.fields || {};
    // 链接展示文本：项目名 + 金额（无项目回落物资名称，再回落申请编号）
    const project = fieldText(f['项目'], '') || truncate(f['购买物资名称'], 20) || fieldText(f['申请编号']) || record.record_id;
    const display = `${project} ${fmtMoney(f)}`;
    const tail = ` | ${fieldText(f['申请编号']) || record.record_id} | 完成于 ${fmtTime(f['完成时间'])}`;
    const noObj = f['申请编号'];
    const link = noObj && typeof noObj === 'object' && !Array.isArray(noObj) ? noObj.link : '';

    if (link) {
      rows.push([
        { tag: 'text', text: `${i + 1}. ` },
        { tag: 'a', text: display, href: link },
        { tag: 'text', text: tail },
      ]);
    } else {
      rows.push([{ tag: 'text', text: `${i + 1}. ${display}（无审批链接）${tail}` }]);
    }
  });

  rows.push([{ tag: 'text', text: '' }]);
  rows.push([{ tag: 'text', text: '请点击上方「项目名+金额」打开对应申请的审批详情页（审批界面，非表格），尽快补交发票；已线下递交或已补录的请忽略，补交后提醒会自动停止。' }]);
  // 回复指引：轮询监听识别「延期/无法提交」（parseReply），告知通道才能收到回复
  rows.push([{ tag: 'text', text: `如需更多时间，直接回复本消息「延期」（可带时长，如「延期 7 天」「延期两周」，默认顺延 ${config.invoiceUrge.deferDays} 天）；确实无法提供发票，回复「无法提交」，将转财务跟进并不再重复提醒。` }]);

  return { title: '🧾 发票催交提醒', rows };
}

/** post 结构 → 纯文本预览（dry-run 展示用；链接渲染为 [文本](短地址)） */
function previewInvoiceUrgePost(post) {
  return [post.title, ...post.rows.map(row => row.map(el =>
    el.tag === 'a' ? `[${el.text}](${String(el.href).slice(0, 48)}…)` : el.text
  ).join(''))].join('\n');
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
  sendPostToUser,
  replyTextMessage,
  sendCardToChat,
  buildWeeklyFinanceCard,
  buildReminderCard,
  buildUrgeCard,
  buildTodayUrgedCard,
  buildDeliveryCard,
  sendDeliveryCard,
  buildAutoLockNoticeCard,
  stripCardInjection, // 交付卡注入消毒（桩测试断言用）
  buildInvoiceUrgePost,
  previewInvoiceUrgePost,
  // 字段格式化工具（供其他服务复用）
  fmtTime,
  fmtMoney,
  getUsers,
  firstUserId,
  firstUserName,
  truncate,
};
