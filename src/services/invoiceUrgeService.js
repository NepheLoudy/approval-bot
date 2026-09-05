const config = require('../config');
const approvalService = require('./approvalService');
const urgeStateStore = require('./urgeStateStore');
const { requestAPI } = require('../feishu/client');
const { sendTextToUser, buildInvoiceUrgeText, getUsers } = require('../feishu/bot');

// ============================================================
// 催发票私聊（有状态版）
//
// 每次执行两步：
//   [1] 轮询回复：对最近一次私聊过的用户，拉 p2p 会话消息列表
//       （IM API，不经网关事件链路），识别「申请延期 / 无法提交」：
//         - 延期/推迟 → 该批记录 deferDays 天内不再私聊
//         - 无法提交  → 该批记录停止私聊，状态呈报周报给财务
//   [2] 私聊催交：过滤后仍需催的记录按发起人分组私聊，
//         - 延期中(snoozeUntil 未到) / 无法提交 / 已催满 maxTimes 次 → 跳过
//         - 发送后 urgeCount+1，满 maxTimes 次标记 escalated（升级财务）
// 状态持久化在 urgeStateStore（JSON 文件，pm2 重启不丢）。
// ============================================================

let initialized = false;

function ensureInit() {
  if (!initialized) {
    urgeStateStore.init(config.invoiceUrge.stateFile);
    initialized = true;
  }
}

/** 判断消息是否来自真实用户（机器人自身消息的 sender.id 是 app_id/cli_ 开头） */
function isFromUser(message) {
  const sender = message.sender || {};
  if (sender.sender_type) return sender.sender_type === 'user';
  return sender.id_type === 'open_id';
}

function parseReply(text) {
  const t = String(text || '');
  if (/无法提交|不能提交|没法提交|交不了|无法提供|开不了|开不出|没法开/.test(t)) return 'cannot_submit';
  if (/延期|推迟/.test(t)) return 'deferred';
  return null;
}

function fmtDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 轮询所有已建联用户的私聊回复
 * @param {object} [options] { silent } silent=true 时只读解析、不发确认回执（dry-run 用）
 */
async function pollAllReplies(options = {}) {
  ensureInit();
  const stats = { users: 0, deferred: 0, cannotSubmit: 0, ignored: 0 };

  // 遍历有会话的用户（open_id 从 state 里取；sendTextToUser 只收 open_id）
  for (const [openId, user] of Object.entries(urgeStateStore.allUsers())) {
    if (!user.chatId) continue;
    stats.users++;

    let messages;
    try {
      messages = await listChatMessages(user.chatId, user.lastReadTime);
    } catch (err) {
      console.warn(`[催发票] 拉取会话消息失败 ${user.chatId}: ${err.message}`);
      continue;
    }

    let lastRead = user.lastReadTime || 0;
    for (const msg of messages) {
      const createTime = Number(msg.create_time) || 0;
      if (createTime > lastRead) lastRead = createTime;
      if (!isFromUser(msg) || msg.msg_type !== 'text') continue;

      const text = extractMsgText(msg);
      const kind = parseReply(text);
      if (!kind) {
        stats.ignored++;
        continue;
      }

      const recordIds = (user.lastUrgeRecordIds || []).filter((id) => urgeStateStore.getRecord(id));
      if (!recordIds.length) continue;

      if (kind === 'deferred') {
        const snoozeUntil = Date.now() + config.invoiceUrge.deferDays * 24 * 60 * 60 * 1000;
        for (const id of recordIds) {
          urgeStateStore.updateRecord(id, { status: 'deferred', snoozeUntil, statusNote: '发起人申请延期' });
        }
        stats.deferred++;
        if (!options.silent) {
          await sendTextToUser(
            openId,
            `✅ 已收到您的延期申请：名下 ${recordIds.length} 笔超期发票 ${config.invoiceUrge.deferDays} 天内（至 ${fmtDay(snoozeUntil)}）不再私聊提醒，请尽快安排提交。`
          );
        }
      } else {
        for (const id of recordIds) {
          urgeStateStore.updateRecord(id, { status: 'cannot_submit', statusNote: '发起人称无法提交' });
        }
        stats.cannotSubmit++;
        if (!options.silent) {
          await sendTextToUser(
            openId,
            `✅ 已记录：${recordIds.length} 笔发票标记为「无法提交」，将呈报财务跟进，后续不再私聊提醒。`
          );
        }
      }
    }

    if (lastRead > (user.lastReadTime || 0)) {
      urgeStateStore.updateUser(openId, { lastReadTime: lastRead });
    }
  }

  return stats;
}

/** 会话消息列表（sort 按创建时间升序，客户端再按 lastReadTime 过滤） */
async function listChatMessages(chatId, lastReadTime) {
  // start_time 用毫秒下限兜底，避免错过边界消息；客户端仍按 lastReadTime 过滤
  const since = Math.max(0, Math.floor((lastReadTime || 0)));
  const query = new URLSearchParams({
    container_id_type: 'chat',
    container_id: chatId,
    sort_type: 'ByCreateTimeAsc',
    page_size: '50',
  });
  if (since > 0) query.set('start_time', String(since));

  const res = await requestAPI('GET', `/im/v1/messages?${query.toString()}`);
  if (res.code !== 0) {
    throw new Error(`拉取会话消息失败: ${res.msg} (code: ${res.code})`);
  }
  const items = res.data?.items || [];
  return items.filter((m) => (Number(m.create_time) || 0) > since);
}

function extractMsgText(message) {
  try {
    const content = typeof message.body?.content === 'string'
      ? JSON.parse(message.body.content)
      : message.body?.content;
    return (content && content.text) || '';
  } catch (e) {
    return '';
  }
}

/**
 * [2] 催发票私聊主流程：先轮询回复，再对仍需催的记录私聊
 */
async function runInvoiceUrge(options = {}) {
  ensureInit();

  // [1] 先处理回复（延期/无法提交会影响本次过滤）；dry-run 只读不发回执
  const replyStats = await pollAllReplies({ silent: !!options.dryRun });
  if (replyStats.users > 0) {
    console.log(`[催发票] 回复轮询: 监听 ${replyStats.users} 位用户, 延期 ${replyStats.deferred} 批, 无法提交 ${replyStats.cannotSubmit} 批, 未识别 ${replyStats.ignored} 条`);
  }

  const overdue = await approvalService.getOverdueInvoices();
  const now = Date.now();
  const maxTimes = config.invoiceUrge.maxTimes;

  // 状态过滤：延期中 / 无法提交 / 已催满 N 次 的记录跳过
  const urgeList = [];
  const statusCounts = { deferred: 0, cannotSubmit: 0, escalated: 0 };
  for (const record of overdue) {
    const st = urgeStateStore.getRecord(record.record_id);
    if (st) {
      if (st.status === 'cannot_submit') { statusCounts.cannotSubmit++; continue; }
      if (st.status === 'deferred' && (st.snoozeUntil || 0) > now) { statusCounts.deferred++; continue; }
      if ((st.urgeCount || 0) >= maxTimes) { statusCounts.escalated++; continue; }
    }
    urgeList.push(record);
  }

  if (!urgeList.length) {
    urgeStateStore.prune(overdue.map((r) => r.record_id));
    console.log(`[催发票] 无需私聊（超期 ${overdue.length} 条: 延期中 ${statusCounts.deferred} / 无法提交 ${statusCounts.cannotSubmit} / 已催满 ${statusCounts.escalated} / 其余 ${overdue.length - statusCounts.deferred - statusCounts.cannotSubmit - statusCounts.escalated} 条不在私聊范围），跳过`);
    return { sent: false, overdueCount: overdue.length, users: 0, replyStats, statusCounts };
  }

  // 按发起人分组：open_id -> { name, records[] }
  const byUser = new Map();
  let skippedNoUser = 0;
  for (const record of urgeList) {
    const user = getUsers(record.fields?.['发起人'])[0];
    if (!user || !user.id) {
      skippedNoUser++;
      console.warn(`[催发票] 记录无发起人，跳过: ${record.record_id}`);
      continue;
    }
    if (!byUser.has(user.id)) {
      byUser.set(user.id, { name: user.name, records: [] });
    }
    byUser.get(user.id).records.push(record);
  }

  console.log(`[催发票] 超期 ${overdue.length} 条，本次私聊 ${urgeList.length} 条，涉及 ${byUser.size} 位发起人` +
    `（延期中 ${statusCounts.deferred} / 无法提交 ${statusCounts.cannotSubmit} / 已催满 ${statusCounts.escalated}${skippedNoUser ? ` / 无发起人跳过 ${skippedNoUser}` : ''}）`);

  // dry-run：只构建私聊文案与状态预览，不发送、不改状态
  if (options.dryRun) {
    const previews = [];
    for (const [openId, { name, records }] of byUser) {
      previews.push({ openId, name, text: buildInvoiceUrgeText(records), urgeCount: urgeStateStore.getRecord(records[0].record_id)?.urgeCount || 0 });
    }
    return { dryRun: true, overdueCount: overdue.length, users: previews.length, urgeCount: urgeList.length, urgedRecords: urgeList, statusCounts, replyStats, previews };
  }

  let sent = 0;
  const failures = [];
  const urgedRecords = []; // 本次实际私聊成功的记录（播报卡用）
  for (const [openId, { name, records }] of byUser) {
    try {
      const res = await sendTextToUser(openId, buildInvoiceUrgeText(records));
      sent++;
      urgedRecords.push(...records);

      // 记录会话与批次，供回复轮询使用；发送响应自带 chat_id / create_time（毫秒）
      const recordIds = records.map((r) => r.record_id);
      const prevUser = urgeStateStore.getUser(openId) || {};
      urgeStateStore.updateUser(openId, {
        chatId: res?.chat_id || prevUser.chatId || '',
        lastUrgeRecordIds: recordIds,
        lastReadTime: Math.max(Number(res?.create_time) || 0, prevUser.lastReadTime || 0),
      });

      // 计数与升级
      for (const id of recordIds) {
        const st = urgeStateStore.updateRecord(id, { urgeCount: (urgeStateStore.getRecord(id)?.urgeCount || 0) + 1, lastUrgeAt: Date.now() });
        if (st.urgeCount >= maxTimes && st.status !== 'escalated') {
          urgeStateStore.updateRecord(id, { status: 'escalated', statusNote: `已私聊催交 ${st.urgeCount} 次` });
        }
      }
      console.log(`[催发票] 已私聊 ${name}(${openId})，名下 ${records.length} 笔超期`);
    } catch (err) {
      failures.push({ openId, name, error: err.message });
      console.error(`[催发票] 私聊 ${name}(${openId}) 失败:`, err.message);
    }
  }

  // 清理已不在超期名单里的状态（已交票等）
  urgeStateStore.prune(overdue.map((r) => r.record_id));

  return {
    sent: sent > 0,
    overdueCount: overdue.length,
    urgeCount: urgeList.length,
    users: byUser.size,
    sentCount: sent,
    urgedRecords,
    statusCounts,
    replyStats,
    failures,
  };
}

module.exports = {
  runInvoiceUrge,
  parseReply,
};
