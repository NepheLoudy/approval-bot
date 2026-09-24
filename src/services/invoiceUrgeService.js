const config = require('../config');
const approvalService = require('./approvalService');
const urgeStateStore = require('./urgeStateStore');
const invoiceCollectService = require('./invoiceCollectService');
const contacts = require('../feishu/contacts');
const bot = require('../feishu/bot');
const client = require('../feishu/client');
const { buildInvoiceUrgePost, previewInvoiceUrgePost, buildTodayUrgedCard, getUsers } = require('../feishu/bot');

// ============================================================
// 催发票私聊（有状态版）
//
// 每次执行三步：
//   [1] 轮询回复：对最近一次私聊过的用户，拉 p2p 会话消息列表
//       （IM API，不经网关事件链路），识别「申请延期 / 无法提交」：
//         - 延期/推迟 → 该批记录 deferDays 天内不再私聊
//         - 无法提交  → 该批记录停止私聊，状态呈报周报给财务
//   [2] 通讯录兜底：私聊前拉全租户通讯录（feishu/contacts）校验发起人有效性，
//         - 发起人已离职/停用 → 标记 resigned 停止私聊，呈报财务（避免必然失败的发送）；
//           发起人重新入队 → 自动恢复催办
//         - 校验失败 fail-open：本轮不校验，按原名单继续
//   [3] 私聊催交：过滤后仍需催的记录按发起人分组私聊，
//         - 延期中(snoozeUntil 未到) / 无法提交 / 已退队 / 已催满 maxTimes 次 / 距上次私聊
//           不满 intervalDays 天（间隔闸）→ 跳过
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
  if (/无法提交|不能提交|没法提交|交不了|无法提供|办不了|开不了|开不出|没法开/.test(t)) return 'cannot_submit';
  if (/延期|推迟|还没|未开|没开|过几天|晚点|稍后|改天|下周/.test(t)) return 'deferred';
  return null;
}

const CN_DIGIT = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字段 → 数值：支持十进制组合（十=10、十五=15、二十=20、二十五=25）；阿拉伯数字直读；不认识返回 NaN */
function cnNumToInt(raw) {
  const s = String(raw || '').trim();
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  const tenIdx = s.indexOf('十');
  if (tenIdx >= 0) {
    const tens = tenIdx > 0 ? CN_DIGIT[s[tenIdx - 1]] : 1;
    const ones = tenIdx + 1 < s.length ? CN_DIGIT[s[tenIdx + 1]] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
  return NaN;
}

const clampDeferDays = (n) => Math.min(Math.max(n, 1), 60); // 钳制 1~60 天，防「延期999天」

/**
 * 从回复中解析延期时长（天）；无可解析时长返回 0（回落 deferDays 默认值）。支持：
 *   - 阿拉伯/中文数字（含十进制组合）：「延期3天」「十五天」「二十天」「二十五天」
 *   - 周/星期（含「零」天余数）：「延期一周」「两周零三天」= 17
 *   - 「日」同「天」：「延期7日」= 7；「半周」= 3 天；「下周…」= 7 天
 */
function parseDeferDays(text) {
  const t = String(text || '');
  const NUM = '([0-9]+|[零一二两三四五六七八九十]+)';
  // 1) 周(+零N天) 组合：「两周」「两周零三天」「1周零2天」
  const week = t.match(new RegExp(`${NUM}\\s*(?:周|星期)\\s*(?:零\\s*${NUM}\\s*(?:天|日))?`));
  if (week) {
    const w = cnNumToInt(week[1]);
    const extra = week[2] ? cnNumToInt(week[2]) : 0;
    const days = (Number.isNaN(w) ? 0 : w * 7) + (Number.isNaN(extra) ? 0 : extra);
    if (days > 0) return clampDeferDays(days);
  }
  // 2) 半周 → 3 天
  if (/半\s*(?:周|星期)/.test(t)) return clampDeferDays(3);
  // 3) 天/日：「延期3天」「延期7日」「十五天」
  const day = t.match(new RegExp(`${NUM}\\s*(?:天|日)`));
  if (day) {
    const n = cnNumToInt(day[1]);
    if (!Number.isNaN(n) && n > 0) return clampDeferDays(n);
  }
  // 4) 「下周…」→ 默认顺延一周
  if (/下周/.test(t)) return clampDeferDays(7);
  return 0;
}

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 无夏令时，固定 UTC+8（同 utils/quietHours 口径）

/** 上海日历日序号：+8h 后按 UTC 天数取整（间隔闸/当日判定用，不受运行时区与当天时刻差影响） */
function shanghaiDayIndex(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / 86400000);
}

function fmtDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 轮询所有已建联用户的私聊回复
 * @param {object} [options] { silent } silent=true 时纯只读：不写状态、不发确认回执（dry-run 用），
 *   已识别的回复留到下一次真实执行再消费
 */
async function pollAllReplies(options = {}) {
  ensureInit();
  const stats = { users: 0, deferred: 0, cannotSubmit: 0, ignored: 0, collected: 0, rejected: 0, duplicated: 0, collectFailed: 0 };

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
      if (!isFromUser(msg)) continue;

      // 催办私聊直接回发票（图片/PDF，2026-09-25 起）：走发票采集链路，
      // 采集成功→回写补交发票栏→下轮催办名单自动排除；dry-run(silent) 不消费
      if (msg.msg_type === 'image' || msg.msg_type === 'file') {
        if (options.silent) { stats.ignored++; continue; }
        const content = parseMsgContent(msg);
        const fileKey = msg.msg_type === 'image' ? content.image_key : content.file_key;
        if (!fileKey) { stats.ignored++; continue; }
        try {
          const r = await invoiceCollectService.collectFromMessage({
            openId,
            senderName: user.name || '',
            messageId: msg.message_id,
            fileKey,
            msgType: msg.msg_type,
            fileName: content.file_name || '',
            source: 'urge_reply',
          });
          if (r.action === 'collected') stats.collected++;
          else if (r.action === 'ignored' || r.action === 'already_collected') stats.ignored++;
          else if (r.action === 'duplicated') stats.duplicated++;
          else stats.rejected++;
        } catch (err) {
          stats.collectFailed++;
          console.warn(`[催发票] 回票采集失败 ${openId}: ${err.message}`);
          try {
            await bot.sendTextToUser(openId, `⚠️ 发票接收失败：${err.message}\n请重发一次；仍失败请直接联系财务人工登记。`);
          } catch (e) { /* 回执失败不中断轮询 */ }
        }
        continue;
      }
      if (msg.msg_type !== 'text') continue;

      const text = extractMsgText(msg);
      const kind = parseReply(text);
      if (!kind) {
        stats.ignored++;
        continue;
      }

      const recordIds = (user.lastUrgeRecordIds || []).filter((id) => urgeStateStore.getRecord(id));
      if (!recordIds.length) continue;

      if (kind === 'deferred') {
        // 延期时长：回复里带天数/周数（如「延期7天」「延期两周」）按回复，否则回落 deferDays 默认值
        const days = parseDeferDays(text) || config.invoiceUrge.deferDays;
        const snoozeUntil = Date.now() + days * 24 * 60 * 60 * 1000;
        stats.deferred++;
        if (!options.silent) {
          for (const id of recordIds) {
            urgeStateStore.updateRecord(id, { status: 'deferred', snoozeUntil, statusNote: `发起人申请延期${days}天` });
          }
          // 回执发送失败只记日志，不允许中断整个轮询（否则当天所有人的催办都会不发）
          try {
            await bot.sendTextToUser(
              openId,
              `✅ 已收到您的延期申请：名下 ${recordIds.length} 笔超期发票 ${days} 天内（至 ${fmtDay(snoozeUntil)}）不再私聊提醒，请尽快安排提交。`
            );
          } catch (err) {
            console.warn(`[催发票] 延期回执发送失败 ${openId}: ${err.message}`);
          }
        }
      } else {
        stats.cannotSubmit++;
        if (!options.silent) {
          for (const id of recordIds) {
            // statusChangedAt：当日状态变化标记，「今日已催」卡在无私聊日也要为它播报（财务可见）
            urgeStateStore.updateRecord(id, { status: 'cannot_submit', statusNote: '发起人称无法提交', statusChangedAt: Date.now() });
          }
          try {
            await bot.sendTextToUser(
              openId,
              `✅ 已记录：${recordIds.length} 笔发票标记为「无法提交」，将呈报财务跟进，后续不再私聊提醒。`
            );
          } catch (err) {
            console.warn(`[催发票] 无法提交回执发送失败 ${openId}: ${err.message}`);
          }
        }
      }
    }

    if (!options.silent && lastRead > (user.lastReadTime || 0)) {
      urgeStateStore.updateUser(openId, { lastReadTime: lastRead });
    }
  }

  return stats;
}

/**
 * 会话消息列表（sort 按创建时间升序，客户端再按 lastReadTime 过滤）。
 * 2026-09-20 修复 230001：GET /im/v1/messages 的 start_time/end_time 查询参数是
 * 【秒级】时间戳（响应体 create_time 才是毫秒）——此前把毫秒 lastReadTime 直接当
 * start_time 传且不给 end_time，服务端视为「未来」起止倒挂，凡私聊催过的用户
 * 回复轮询必报 230001（「延期/无法提交」永远识别不到）。客户端过滤仍用毫秒 since。
 */
async function listChatMessages(chatId, lastReadTime) {
  const since = Math.max(0, Math.floor((lastReadTime || 0)));
  const query = new URLSearchParams({
    container_id_type: 'chat',
    container_id: chatId,
    sort_type: 'ByCreateTimeAsc',
    page_size: '50',
    end_time: String(Math.floor(Date.now() / 1000)),
  });
  if (since > 0) query.set('start_time', String(Math.floor(since / 1000)));

  const items = [];
  let pageToken = '';
  do {
    if (pageToken) query.set('page_token', pageToken);
    const res = await client.requestAPI('GET', `/im/v1/messages?${query.toString()}`);
    if (res.code !== 0) {
      throw new Error(`拉取会话消息失败: ${res.msg} (code: ${res.code})`);
    }
    items.push(...((res.data && res.data.items) || []));
    pageToken = (res.data && res.data.has_more && res.data.page_token) || '';
  } while (pageToken);
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

/** 消息 content JSON 解析（image/file 的 image_key/file_key 提取用） */
function parseMsgContent(message) {
  try {
    const content = typeof message.body?.content === 'string'
      ? JSON.parse(message.body.content)
      : message.body?.content;
    return content || {};
  } catch (e) {
    return {};
  }
}

/**
 * [2] 催发票私聊主流程：先轮询回复，再对仍需催的记录私聊
 * 并发互斥：定时任务、/approval-urge 指令、测试接口可能同时触发，
 * 重入会导致同一批记录重复私聊、urgeCount 双计
 */
let urgeRunning = false;

async function runInvoiceUrge(options = {}) {
  if (urgeRunning) {
    console.warn('[催发票] 上一轮催发票仍在执行，跳过本次触发（防重复私聊）');
    return { skipped: true, reason: 'already_running' };
  }
  urgeRunning = true;
  try {
    return await runInvoiceUrgeInner(options);
  } finally {
    urgeRunning = false;
  }
}

async function runInvoiceUrgeInner(options = {}) {
  ensureInit();

  // [1] 先处理回复（延期/无法提交会影响本次过滤）；dry-run 纯只读预览（不消费回复、不改状态）
  const replyStats = await pollAllReplies({ silent: !!options.dryRun });
  if (replyStats.users > 0) {
    console.log(`[催发票] 回复轮询: 监听 ${replyStats.users} 位用户, 延期 ${replyStats.deferred} 批, 无法提交 ${replyStats.cannotSubmit} 批, 未识别 ${replyStats.ignored} 条`);
  }

  const overdue = await approvalService.getOverdueInvoices();
  const now = Date.now();
  const maxTimes = config.invoiceUrge.maxTimes;

  // 状态过滤：延期中 / 无法提交 / 已催满 N 次 的记录跳过；
  // 已退队(resigned)记录单独收集——本轮重新过通讯录校验，发起人回队可自动恢复催办；
  // 间隔闸：定时任务每天跑（回复轮询每日不漏），但同一笔距上次私聊不满 intervalDays 天不重复催
  const urgeList = [];
  const resignedRecords = [];
  const statusCounts = { deferred: 0, cannotSubmit: 0, escalated: 0, resigned: 0, intervalHold: 0 };
  const intervalDays = config.invoiceUrge.intervalDays;
  for (const record of overdue) {
    const st = urgeStateStore.getRecord(record.record_id);
    if (st) {
      if (st.status === 'cannot_submit') { statusCounts.cannotSubmit++; continue; }
      if (st.status === 'deferred' && (st.snoozeUntil || 0) > now) { statusCounts.deferred++; continue; }
      if ((st.urgeCount || 0) >= maxTimes) { statusCounts.escalated++; continue; }
      if (st.status === 'resigned') { resignedRecords.push(record); continue; }
      // 间隔闸按上海日历日比较：精确毫秒差因「now 在拉表后取、lastUrgeAt 在发送后打点」
      // 恒小于 N*24h，会把「2天一催」实际拖成 3 天；按日历日第 0 天催、第 2 天可再催
      if ((st.urgeCount || 0) > 0 && st.lastUrgeAt && shanghaiDayIndex(now) - shanghaiDayIndex(st.lastUrgeAt) < intervalDays) { statusCounts.intervalHold++; continue; }
    }
    urgeList.push(record);
  }

  // 通讯录兜底：私聊前确认发起人有效性（离职/停用成员私聊必然失败，如 230013），
  // 不在通讯录的候选标记 resigned 停止私聊并呈报财务；校验失败 fail-open（本轮不校验按原名单继续）。
  // dry-run 只预览不改状态（mark 静默化）
  let contactsChecked = false;
  let recoveredCount = 0;
  if (urgeList.length || resignedRecords.length) {
    try {
      const activeIds = await contacts.listActiveOpenIds();
      contactsChecked = true;
      const mark = (id, patch) => { if (!options.dryRun) urgeStateStore.updateRecord(id, patch); };
      const stillUrged = [];
      for (const record of urgeList) {
        const uid = getUsers(record.fields?.['发起人'])[0]?.id || '';
        if (uid && !activeIds.has(uid)) {
          mark(record.record_id, { status: 'resigned', statusNote: '发起人已退队（通讯录校验），停止私聊', statusChangedAt: Date.now() });
          statusCounts.resigned++;
        } else {
          stillUrged.push(record);
        }
      }
      urgeList.length = 0;
      urgeList.push(...stillUrged);
      const stillResigned = [];
      for (const record of resignedRecords) {
        const uid = getUsers(record.fields?.['发起人'])[0]?.id || '';
        if (uid && activeIds.has(uid)) {
          mark(record.record_id, { status: 'none', statusNote: '发起人重新入队，恢复催办' });
          urgeList.push(record);
          recoveredCount++;
        } else {
          stillResigned.push(record);
        }
      }
      statusCounts.resigned += stillResigned.length;
      if (statusCounts.resigned || recoveredCount) {
        console.log(`[催发票] 通讯录校验: ${statusCounts.resigned} 条记录发起人已退队（停止私聊）` +
          (recoveredCount ? `，${recoveredCount} 条发起人重新入队恢复催办` : ''));
      }
    } catch (err) {
      console.warn(`[催发票] 通讯录校验失败（本轮不校验人员有效性，按原名单继续）: ${err.message}`);
      statusCounts.resigned += resignedRecords.length;
    }
  }

  if (!urgeList.length) {
    urgeStateStore.prune(overdue.map((r) => r.record_id));
    console.log(`[催发票] 无需私聊（超期 ${overdue.length} 条: 延期中 ${statusCounts.deferred} / 无法提交 ${statusCounts.cannotSubmit} / 已催满 ${statusCounts.escalated} / 已退队 ${statusCounts.resigned} / 间隔未到 ${statusCounts.intervalHold} / 其余 ${overdue.length - statusCounts.deferred - statusCounts.cannotSubmit - statusCounts.escalated - statusCounts.resigned - statusCounts.intervalHold} 条不在私聊范围），跳过`);
    return { sent: false, overdueCount: overdue.length, users: 0, overdueRecords: overdue, urgedRecords: [], statusCounts, contactsChecked, replyStats };
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
    `（延期中 ${statusCounts.deferred} / 无法提交 ${statusCounts.cannotSubmit} / 已催满 ${statusCounts.escalated} / 已退队 ${statusCounts.resigned} / 间隔未到 ${statusCounts.intervalHold}${skippedNoUser ? ` / 无发起人跳过 ${skippedNoUser}` : ''}）`);

  // dry-run：只构建私聊文案与状态预览，不发送、不改状态
  if (options.dryRun) {
    const previews = [];
    for (const [openId, { name, records }] of byUser) {
      previews.push({ openId, name, text: previewInvoiceUrgePost(buildInvoiceUrgePost(records)), urgeCount: urgeStateStore.getRecord(records[0].record_id)?.urgeCount || 0 });
    }
    return { dryRun: true, overdueCount: overdue.length, users: previews.length, urgeCount: urgeList.length, overdueRecords: overdue, urgedRecords: urgeList, statusCounts, contactsChecked, replyStats, previews };
  }

  let sent = 0;
  const failures = [];
  const urgedRecords = []; // 本次实际私聊成功的记录（播报卡用）
  for (const [openId, { name, records }] of byUser) {
    try {
      // 富文本 post：超链接展示为「项目名+金额」，点击直达审批详情页
      const post = buildInvoiceUrgePost(records);
      const res = await bot.sendPostToUser(openId, post.title, post.rows);
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
    overdueRecords: overdue,
    urgedRecords,
    statusCounts,
    contactsChecked,
    replyStats,
    failures,
  };
}

/**
 * 「今日已催」群播报（每日私聊催交后独立播报，与周报能力分开）：
 *   - 今日已私聊明细 + 未私聊汇总
 *   - ⚠️ 需财务关注：多次催交仍无票（urgeCount ≥ 2）/ 回复得知无法提交 / 发起人已退队 的记录
 * 当天无私聊催交且无「当日状态发生变化」的关注项才不发卡（避免空播刷屏，同时保住
 * 当日新增关注——用户当天回「无法提交」/新发现退队时财务看得到）。dry-run 不发送。
 */
async function announceTodayUrged(result) {
  if (!result || result.dryRun) return { announced: false, reason: 'dry-run' };

  const urgedRecords = result.urgedRecords || [];
  const statusCounts = result.statusCounts || {};
  const maxTimes = config.invoiceUrge.maxTimes;

  // 间隔闸下并非每天实际催交：当天没催人且没有当日状态变化（statusChangedAt 为今天，
  // 如回复「无法提交」/通讯录新发现退队）才跳过——否则财务当天看不到新增关注项
  const now = Date.now();
  const changedToday = (result.overdueRecords || []).some((record) => {
    const st = urgeStateStore.getRecord(record.record_id);
    return !!(st && st.statusChangedAt && shanghaiDayIndex(st.statusChangedAt) === shanghaiDayIndex(now));
  });
  if (!urgedRecords.length && !changedToday) {
    console.log('[催发票] 今日无私聊催交且无当日状态变化，跳过「今日已催」播报');
    return { announced: false, reason: 'no_urge_today' };
  }
  const attention = [];
  for (const record of result.overdueRecords || []) {
    const st = urgeStateStore.getRecord(record.record_id);
    if (!st) continue;
    const reasons = [];
    if (st.status === 'cannot_submit') reasons.push('无法提交');
    if (st.status === 'resigned') reasons.push('发起人已退队');
    if ((st.urgeCount || 0) >= maxTimes) reasons.push(`已催满${st.urgeCount}次`);
    else if ((st.urgeCount || 0) >= 2) reasons.push(`已催${st.urgeCount}次`);
    if (reasons.length) attention.push({ record, reasons });
  }

  try {
    const card = buildTodayUrgedCard({
      urgedRecords,
      attention,
      statusCounts,
      urgeStates: urgeStateStore.allRecords(),
    });
    await bot.sendMessage(card);
    console.log(`[催发票] 「今日已催」已播报：今日催交 ${urgedRecords.length} 条，需财务关注 ${attention.length} 条`);
    return { announced: true, attentionCount: attention.length };
  } catch (err) {
    // 播报失败不抛出——避免定时任务重试导致私聊重复发送
    console.error('[催发票] 「今日已催」播报失败（不影响私聊结果）:', err.message);
    return { announced: false, reason: err.message };
  }
}

module.exports = {
  runInvoiceUrge,
  announceTodayUrged,
  pollAllReplies,
  parseReply,
  parseDeferDays,
};
