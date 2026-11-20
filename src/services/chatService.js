const config = require('../config');
const approvalService = require('./approvalService');
const invoiceUrgeService = require('./invoiceUrgeService');
const contacts = require('../feishu/contacts');
const { sendTextToChat, replyTextMessage, sendMessage, buildUrgeCard, buildDeliveryCard, sendDeliveryCard } = require('../feishu/bot');
const { fieldText } = require('../utils/fields');

// ============================================================
// 指令与对话触发（仅面向审批群）
//
// ⚠️ qianli 架构铁律：除工单接单监听外，所有对话逻辑统一由
// 对话型机器人（爆米花机-对话型 / knowledge-tracker）触发。
// 生产环境中本服务不消费消息事件——对话型机器人收到 /approval-*
// 后转发到本服务 POST /api/chat/command（executeCommand）。
// 本模块的消息处理仅用于本地调试（独立长连接模式）。
// 与正常其他群的对话能力分离的规则：
//   1. 群聊消息：只有 chat_id === BOT_CHAT_ID 的目标群才处理，
//      且必须 @机器人；其他群一律跳过（不回复、不记录）
//   2. 私聊消息：一律跳过（私聊对话能力属于爆米花机）
//   3. 指令命名空间统一为 /approval-*，与爆米花机的 /print-* 等互不冲突
// ============================================================

const processedMessageIds = new Set();

/**
 * 检测消息是否指向机器人（群聊场景）
 * 飞书事件中机器人 mention 的 mentioned_type 为 "bot"，
 * 实际名称可能与配置名不一致，因此多信号判断
 */
function isMentionedBot(message) {
  if (!message) return false;

  const mentions = message.mentions || [];
  const botName = config.bot.name;

  return mentions.some(m => {
    if (m.id === 'self') return true;
    if (m.mentioned_type === 'app' || m.mentioned_type === 'bot') return true;
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
    '  /approval-urge    手动催办 [发票|报销单|转账]，留空=发票私聊催交',
    '  /approval-batch   报销批次：拟批建议 | lock <批次号> [项目] [用途=xx] [费用项=xx] [采购类型=xx] [收款方=xx] | status |',
    '                    submit <批次号> [投递单号] | paid/reject <批次号> | confirm <批次号> | printed <批次号> | regen <批次号> | ledger [submit|paid|reject] <批次号> [投递单号]',
    '                    （confirm=确认自动批次明细后才生成交付件与二维码；printed=标记打印完成并自动预登记《报销台账》；submit/paid/reject 自动同步《报销台账》）',
    '  /approval-quota  项目额度：查看各项目剩余额度（占用=锁定+提交+到账）；set <项目> <额度> [初始已用] / unset <项目>（资金白名单）',
    '  接取 [批次号]     领取交付包（锁定后群里回复「接取」，登记接取人）',
    '',
    `使用方式：群聊中先 @${config.bot.name} 再发送指令`,
    '定时播报：每周一 18:00 财务催办周报（催发票/报销单/转账 + 报销台账状态）',
    '催发票私聊：已通过满 14 天未交发票将私聊发起人催交（每天 10:30）；',
    '  私聊直接回发票图片/PDF 即可交票，机器人自动识别归类并回执',
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

/**
 * 手动催办：/approval-urge [发票|报销单|转账]，留空=发票私聊催交
 * 分支与催办通道一一对应（与定时任务同款能力，按需触发）：
 *   - 发票（默认）→ 私聊发起人催交 + 群播「发票催交播报」卡片：本次催了哪些未开票记录
 *     （单号超链接 + 状态徽标 + 未私聊汇总；申请人回复延期/无法提交自动识别）
 *   - 报销单/转账 → 群卡片播报对应清单 @财务（该二分支的常规展示由周报承担，
 *     手动仅在显式传参时播报）
 * 回复文本为触发结果摘要。
 */
const URGE_CATEGORIES = {
  invoice: ['发票', '开票', 'invoice', '全部', 'all'],
  form: ['报销单', '制单', 'form'],
  transfer: ['转账', 'transfer'],
};

async function handleUrgeCommand(args = []) {
  const raw = (args[0] || '').toLowerCase();
  let category = 'invoice'; // 留空默认：发票私聊催交
  if (raw) {
    category = null;
    for (const [key, aliases] of Object.entries(URGE_CATEGORIES)) {
      if (aliases.includes(raw)) { category = key; break; }
    }
    if (!category) {
      return `❌ 未知催办类别：${args[0]}\n用法：/approval-urge [发票|报销单|转账]，留空=发票私聊催交`;
    }
  }

  const lines = ['🔔 手动催办完成：'];

  // 发票 → 私聊发起人（复用催发票私聊能力）+ 群播「今日已催」卡
  if (category === 'invoice') {
    const r = await invoiceUrgeService.runInvoiceUrge();
    // 撞上正在执行的定时轮：如实告知而非误报「本次无私聊」（2026-10-30 审查批 P2）
    if (r && r.skipped) {
      return `⏳ 上一轮催办仍在执行中，本次未启动（${r.reason || 'already_running'}）——请稍后重试`;
    }
    const skipped = r.statusCounts || {};
    const skippedTotal = (skipped.deferred || 0) + (skipped.cannotSubmit || 0) + (skipped.escalated || 0) + (skipped.resigned || 0) + (skipped.intervalHold || 0);

    // 群播「今日已催」：今日催交明细 + 需财务关注（多次催交/无法提交）+ 未私聊汇总
    const announce = await invoiceUrgeService.announceTodayUrged(r);

    lines.push(
      r.urgedRecords && r.urgedRecords.length
        ? `🧾 未开票：已私聊 ${r.sentCount}/${r.users} 位发起人（${r.urgedRecords.length} 条，明细见群卡片「今日已催」）${r.failures?.length ? `，⚠️ ${r.failures.length} 人发送失败` : ''}`
        : '🧾 未开票：✅ 本次无私聊（无超期或均处于延期/无法提交/已催满状态）'
    );
    if (skippedTotal > 0) {
      lines.push(`⏸ 未私聊：延期中 ${skipped.deferred || 0} · 无法提交 ${skipped.cannotSubmit || 0} · 已催满 ${skipped.escalated || 0} · 已退队 ${skipped.resigned || 0} · 间隔未到 ${skipped.intervalHold || 0}`);
    }
    if (!announce.announced && announce.reason === 'no_urge_today') {
      lines.push('（今日无私聊催交，未发「今日已催」卡）');
    }
    return lines.join('\n');
  }

  // 报销单/转账 → 群卡片 @财务（周报同款清单，显式触发才播）
  const { missingForm, missingTransfer } = await approvalService.getFinanceFollowUp();
  const pickedForm = category === 'form' ? missingForm : [];
  const pickedTransfer = category === 'transfer' ? missingTransfer : [];

  if (pickedForm.length + pickedTransfer.length > 0) {
    const card = buildUrgeCard({
      missingForm: pickedForm,
      missingTransfer: pickedTransfer,
      mentionIds: config.reminder.mentionIds,
    });
    await sendMessage(card);
  }
  if (category === 'form') {
    lines.push(pickedForm.length ? `📄 未制单：已播报 ${pickedForm.length} 笔（群卡片 @财务；常规展示见每周一 18:00 周报）` : '📄 未制单：✅ 无待催办');
  }
  if (category === 'transfer') {
    lines.push(pickedTransfer.length ? `💸 未转账：已播报 ${pickedTransfer.length} 笔（群卡片 @财务；常规展示见每周一 18:00 周报）` : '💸 未转账：✅ 无待催办');
  }
  return lines.join('\n');
}

const commandHandlers = {
  '/approval-help': handleHelpCommand,
  '/approval-list': handleListCommand,
  '/approval-pending': handlePendingCommand,
  '/approval-status': handleStatusCommand,
  '/approval-urge': handleUrgeCommand,
  '/approval-batch': handleBatchCommand,
  '/approval-quota': handleQuotaCommand,
  '接取': handleTakeCommand, // 审批群交付卡领取（hub 转发裸词，非 / 指令）
};

/**
 * 项目额度指令（2026-11-21 曼波定额度功能）：
 *   /approval-quota                       → 总览（财务群可用，无需白名单）
 *   /approval-quota set <项目> <额度> [初始已用] → 设置/更新（资金白名单——写额度真值）
 *   /approval-quota unset <项目>          → 撤销该项目的额度管理（资金白名单）
 * 占用口径：批次表「已锁定/已提交/已到账」金额合计（承诺即占用），已退回释放；
 * 初始已用=建账前历史消耗预扣（v50 前手工批次只在台账，统计不到）。
 */
async function handleQuotaCommand(args = [], ctx = {}) {
  if (!config.bitable.quotaTableId) {
    return 'ℹ️ 未配置项目额度表（BITABLE_QUOTA_TABLE_ID）——先跑 scripts/create-collect-tables.js 建表并配 .env，额度功能才会启用';
  }
  const quotaService = require('./quotaService');
  const sub = String(args[1] || '').toLowerCase();

  // 查看：财务群人人可用（只读）
  if (!sub || sub === 'overview') {
    const { items, unmanaged } = await quotaService.getQuotaOverview();
    if (!items.length) return '📊 尚未配置任何项目额度——运维台或 /approval-quota set <项目> <额度> [初始已用] 设置';
    const lines = ['💰 项目额度总览（占用=已锁定+已提交+已到账，已退回释放）：'];
    for (const i of items) {
      const flag = i.overspend ? '🚨' : (i.remaining < i.quota * 0.2 ? '⚠️' : '✅');
      lines.push(`· ${flag} ${i.project}：剩余 ¥${i.remaining.toFixed(2)} / 额度 ¥${i.quota.toFixed(2)}（占用 ¥${i.spent.toFixed(2)}${i.initialSpent ? `，初始已用 ¥${i.initialSpent.toFixed(2)}` : ''}）`);
    }
    if (unmanaged.length) {
      lines.push(`· ℹ️ 有消耗但未设额度的项目：${unmanaged.map(u => `${u.project} ¥${u.spent.toFixed(2)}`).join('、')}（需要管理就补设）`);
    }
    return lines.join('\n');
  }

  // 设置/撤销：资金指令级——挂 fundOperatorDenied 白名单
  const denied = fundOperatorDenied(ctx);
  if (denied) return denied;

  if (sub === 'set') {
    const project = String(args[2] || '').trim();
    const amount = parseFloat(String(args[3] ?? ''));
    if (!project || !Number.isFinite(amount) || amount < 0) {
      return '❌ 用法：/approval-quota set <项目> <额度> [初始已用]（如 /approval-quota set 对抗赛 20000 15000）';
    }
    const init = parseFloat(String(args[4] ?? '')) || 0;
    const r = await quotaService.setQuota(project, amount, init);
    const item = (await quotaService.getProjectQuota(project));
    return `✅ 项目额度已${r.action === 'created' ? '设置' : '更新'}：${r.project} 额度 ¥${r.quota.toFixed(2)}${r.initialSpent ? `（初始已用 ¥${r.initialSpent.toFixed(2)}）` : ''}${item ? `，当前剩余 ¥${item.remaining.toFixed(2)}` : ''}`;
  }
  if (sub === 'unset') {
    const project = String(args[2] || '').trim();
    if (!project) return '❌ 用法：/approval-quota unset <项目>';
    const r = await quotaService.deleteQuota(project);
    return r.action === 'deleted' ? `✅ 已撤销「${r.project}」的额度管理（批次流转不受影响）` : `ℹ️ 「${r.project}」本来就没有额度配置`;
  }
  return '❌ 用法：/approval-quota（查看总览）| set <项目> <额度> [初始已用] | unset <项目>';
}

/**
 * 资金指令白名单闸（2026-09-27 对抗审查 P1）：APPROVAL_FUND_OPERATOR_IDS 配置后，
 * lock/submit/paid/reject/printed 仅限名单内 open_id（以 hub 透传的 senderId 为准，
 * 自报 senderName 不可信；printed 2026-11-06 曼波批入列——它写台账真账）；未配置 = 维持现状
 * 不限（回执仍显示操作人校验状态）。
 * 放行返回空串；拦截返回错误文案（executeCommand 直接回群，不抛错）。
 */
function fundOperatorDenied(ctx = {}) {
  const allowed = config.fundOperatorIds || [];
  if (!allowed.length) return '';
  const senderId = ctx.senderId || '';
  if (senderId && allowed.includes(senderId)) return '';
  return '❌ 未获资金指令权限：lock/submit/paid/reject/printed 已启用操作人白名单（APPROVAL_FUND_OPERATOR_IDS），请联系管理员把你的 open_id 加入名单';
}

/**
 * 报销批次三件套指令（财务三件套自动化）：
 *   /approval-batch                      → 拟批建议（票池按项目分组）
 *   /approval-batch lock <批次号> [项目] [用途=xx] [费用项=xx] [采购类型=xx]
 *                                        → 锁定（回写两表 + 生成 打印PDF/BOM/物料清单/扫码清单
 *                                          + 审批群发交付卡，回复「接取」领取）
 *   /approval-batch status               → 批次总览（含接取人）
 *   /approval-batch submit <批次号> [投递单号] → 标记已提交学校 + 台账表追加行（幂等）
 *   /approval-batch paid <批次号>        → 标记已到账（台账回填入账日期+已到账）+ 归档名建议
 *   /approval-batch reject <批次号>      → 标记已退回（台账标记已退回；退回票自动回票池）
 *   /approval-batch regen <批次号>       → 全部交付件重新生成（打印PDF/docx、BOM、物料清单、扫码清单、特殊事项附页）
 *   /approval-batch ledger <批次号> [投递单号] → 手动把批次同步进台账电子表格
 *   接取 [批次号]                        → 审批群回复「接取」领取交付包（登记接取人）
 */
async function handleBatchCommand(args = [], ctx = {}) {
  const batchService = require('./batchService'); // 延迟 require：重依赖（pdf-lib/exceljs）仅在用到时加载
  const [sub] = args;

  if (!sub || sub === 'preview') {
    const { poolSize, suggestions } = await batchService.previewBatch();
    if (!poolSize) return '📥 票池为空：没有待归集的已采集发票（队员私聊/催办回票后自动入池）';
    const lines = [`📋 票池 ${poolSize} 张待归集，按项目分组建议：`];
    for (const s of suggestions) {
      lines.push(`· ${s.project}：${s.count} 张 ¥${s.amount.toFixed(2)}（${s.range}）${s.warningCount ? `⚠️ 含 ${s.warningCount} 张待人工/异常` : ''}`);
    }
    lines.push('锁定：/approval-batch lock <批次号> [项目] [用途=xx]（批次号沿用财务命名，如 27备赛20步兵5；不传项目=锁定全池）');
    lines.push('锁定后自动生成 打印件PDF + BOM + 物料清单（校格式）+ 扫码清单，落「报销批次」表附件并向本群发交付卡，回复「接取」领取');
    return lines.join('\n');
  }

  if (sub === 'lock') {
    // 位置参数：批次号 [项目]；键值参数：用途=/费用项=/采购类型=/收款方=/收款账号=（覆盖 .env 默认）
    const kv = {};
    const positional = [];
    for (const a of args.slice(1)) {
      const m = a.match(/^(用途|费用项|采购类型|收款方|收款账号)=(.+)$/);
      if (m) kv[m[1]] = m[2].trim();
      else positional.push(a);
    }
    const [batchNo, project] = positional;
    if (!batchNo) return '❌ 用法：/approval-batch lock <批次号> [项目] [用途=xx] [费用项=xx] [采购类型=xx] [收款方=xx 收款账号=xx]';
    const denied = fundOperatorDenied(ctx);
    if (denied) return denied;
    // 锁定人留痕（复查 P2-4）：与 submit/paid/reject 同款实名反查，落批次表「最后操作人/时间」
    const { operator, verified } = await resolveOperator(ctx);
    const r = await batchService.lockBatch(batchNo, project || '', {
      purpose: kv['用途'] || '',
      feeItem: kv['费用项'] || '',
      purchaseType: kv['采购类型'] || '',
      payee: kv['收款方'] || '',
      payeeAccount: kv['收款账号'] || '',
      operator,
    });
    const lines = [
      `✅ 批次已锁定：${r.batchNo}（${r.projects.join('/')}）`,
      `· ${r.count} 张发票 ¥${r.amount.toFixed(2)}，已回写审批表「报销单」栏 ${r.approvalWritten} 条`,
      r.summary ? `· 摘要：${r.summary}` : '',
      operator ? `· 👤 锁定人：${operator}${verified ? '' : '（自报，未经通讯录校验）'}` : '',
      r.pdfToken ? '· 🖨️ 打印件 PDF ✅（按录入顺序，一页两票）' : '· ⚠️ 打印件 PDF 生成失败（可 /approval-batch regen 重试）',
      r.bomToken ? '· 📊 BOM 表 ✅' : '· ⚠️ BOM 生成失败（可 regen）',
      r.mlToken ? '· 🧾 物料清单（校格式）✅' : '· ⚠️ 物料清单生成失败（可 regen）',
      r.docxToken ? '· 📄 打印件 docx（可编辑版）✅' : '· ⚠️ 打印件 docx 生成失败（可 regen）',
      ...(r.specialCount ? [`· 🚩 特殊事项附页 ✅（${r.specialCount} 张：大额/公私属性不分明/有支付记录，单独成页）`] : []),
    ].filter(Boolean);
    if (r.markFailed && r.markFailed.length) lines.push(`· ⚠️ ${r.markFailed.length} 张打标失败（${r.markFailed.slice(0, 5).join('、')}${r.markFailed.length > 5 ? '…' : ''}，已记入批次备注），请对漏标票人工补「批次/报销单」栏`);
    if (r.warningCount) lines.push(`· ⚠️ 含 ${r.warningCount} 张待人工/异常票，录入前先核对采集表「校验状态」`);
    if (r.missingContent) lines.push(`· ⚠️ ${r.missingContent} 张缺「开票内容」（底单已标黄），录入时现场补填`);
    // 未收齐申请（v103 校核姿态）：多票分批交的收口提示
    if (r.notFullyCollected && r.notFullyCollected.length) {
      lines.push(`· 🧮 ${r.notFullyCollected.length} 个申请未收齐：${r.notFullyCollected.slice(0, 3).map(n => `${n.applyNo} 已收¥${n.collected.toFixed(2)}/共¥${n.total.toFixed(2)}`).join('、')}${r.notFullyCollected.length > 3 ? ` 等 ${r.notFullyCollected.length} 个` : ''}（多票金额加起来=申请即可，制单前与队员确认补齐）`);
    }
    // 项目额度超支预警（v104 额度功能）：锁定本批后剩余 < 0
    if (r.quotaAlert) {
      lines.push(`· 🚨 项目额度超支：${r.quotaAlert.project} 锁定本批 ¥${Number(r.amount).toFixed(2)} 后剩余 ¥${r.quotaAlert.remainingAfter.toFixed(2)}（额度 ¥${r.quotaAlert.quota.toFixed(2)}，锁定前 ¥${r.quotaAlert.remainingBefore.toFixed(2)}）——请裁决补额度或调整报销计划`);
    }
    // 交付卡（人工锁定触发的直接回路，即时发群；卡内按序内嵌全部有效发票二维码——
    // 2026-09-29 曼波定；失败不阻断锁定）。sendMessage 被播报熔断时静默返回 null——
    // 如实回执「暂缓」而非谎报已发（2026-10-30 审查批，同 cron 先例）。
    // 2026-11-03 审查 P2：异常与熔断分路（此前 catch 后 sent 仍 null，回执双条矛盾提示）
    try {
      const sent = await sendDeliveryCard({
        batchNo: r.batchNo, project: r.projects.join('/'), count: r.count, amount: r.amount,
        summary: r.summary, warningCount: r.warningCount, missingContent: r.missingContent,
        generated: { pdf: !!r.pdfToken, printDocx: !!r.docxToken, bom: !!r.bomToken, materialList: !!r.mlToken, specialSheet: !!(r.specialPdfToken || r.specialDocxToken), scanSheet: !!r.ssToken },
        specialCount: r.specialCount, blankCount: r.blankCount,
        scanItems: r.scanItems || [],
        abnormalItems: r.abnormalItems || [],
        notFullyCollected: r.notFullyCollected || [],
      });
      if (sent) {
        lines.push(`· 📦 交付卡已发本群，@机器人 回复「接取」领取后录入小翼Plus；完成后：/approval-batch submit ${r.batchNo}`);
      } else {
        lines.push('· ⚠️ 交付卡被播报熔断暂缓（今日卡片额度已满），稍后重试或从报销批次表附件取用');
      }
    } catch (err) {
      console.error('[对话服务] 交付卡发送失败:', err.message);
      lines.push('· ⚠️ 交付卡发送失败（文件已在报销批次表附件，不影响使用）');
    }
    return lines.join('\n');
  }

  if (sub === 'status') {
    const batches = await batchService.batchOverview();
    if (!batches.length) return '📊 暂无报销批次（/approval-batch 先看拟批建议）';
    const lines = ['📊 报销批次总览：'];
    for (const b of batches) {
      lines.push(`· ${b.batchNo}（${b.project}）：${b.count} 张 ¥${b.amount.toFixed(2)}【${b.status}】${b.taker ? ` 接取:${b.taker}` : ''}${b.operator ? ` 操作:${b.operator}` : ''}`);
    }
    return lines.join('\n');
  }


  const statusMap = {
    submit: { status: '已提交', label: '已提交学校' },
    paid: { status: '已到账', label: '已到账' },
    reject: { status: '已退回', label: '已退回' },
  };
  if (statusMap[sub]) {
    if (!args[1]) return `❌ 用法：/approval-batch ${sub} <批次号>${sub === 'submit' ? ' [投递单号]' : ''}`;
    const denied = fundOperatorDenied(ctx);
    if (denied) return denied;
    const deliveryNo = sub === 'submit' ? (args[2] || '') : '';
    const { operator, verified } = await resolveOperator(ctx);
    const r = await batchService.markBatch(args[1], statusMap[sub].status, operator);
    const lines = [`✅ 批次 ${r.batchNo} 已标记【${statusMap[sub].label}】：${r.count} 张 ¥${r.amount.toFixed(2)}`];
    if (operator) lines.push(`· 👤 操作人：${operator}${verified ? '' : '（自报，未经通讯录校验）'}`);
    // 报销台账电子表格同步（写失败不影响批次状态流转，回执如实提示可重试）
    lines.push(await syncLedgerQuietly(sub, r.batchNo, deliveryNo));
    if (r.archiveFolder) lines.push(`· 🗂️ 归档文件夹名建议：${r.archiveFolder}`);
    if (r.returnedToPool) lines.push(`· ${r.returnedToPool} 张退回票已回票池，可重新拟批`);
    // 回票失败透出（复查 P1-3）：失败票仍挂批次，重发 reject 幂等续回
    if (r.returnFailed && r.returnFailed.length) {
      lines.push(`· ⚠️ ${r.returnFailed.length} 张回票失败（${r.returnFailed.slice(0, 5).join('、')}${r.returnFailed.length > 5 ? '…' : ''}），已记批次备注，可重发 reject 续回`);
    }
    return lines.filter(Boolean).join('\n');
  }

  if (sub === 'ledger') {
    // ledger [submit|paid|reject] <批次号> [投递单号]（首参是模式之一则作为模式，默认 submit
    // ——复查 P2：此前只有 submit 入口，台账同步失败后无法补救 paid/reject 的 L/M 列回填）
    const MODES = ['submit', 'paid', 'reject'];
    const rest = args.slice(1);
    let mode = 'submit';
    if (rest.length && MODES.includes(rest[0])) mode = rest.shift();
    const [ledgerBatchNo, deliveryNo] = rest;
    if (!ledgerBatchNo) {
      return '❌ 用法：/approval-batch ledger [submit|paid|reject] <批次号> [投递单号]（默认 submit；paid/reject 用于补回填台账入账日期/退回标记）';
    }
    const ledger = require('./ledgerSheetService');
    // 台账补录写的是《报销台账》真账（追加行/回填入账日期/退回标记），同挂资金指令白名单
    // （2026-10-30 审查批 P2：此前绕过了 lock/submit/paid/reject 的操作人口径）
    const denied = fundOperatorDenied(ctx);
    if (denied) return denied;
    if (mode !== 'submit') {
      const ls = await ledger.syncOnStatus(ledgerBatchNo, mode === 'paid' ? { paid: true } : { rejected: true });
      if (ls.action === 'updated') {
        return mode === 'paid'
          ? `📗 台账已回填：入账日期 + 已到账（第 ${ls.rowIndex} 行）`
          : `📗 台账已标记：已退回（第 ${ls.rowIndex} 行）`;
      }
      if (ls.action === 'no_summary') return '⚠️ 该批次无摘要（旧批次），没有台账口径，请人工登记';
      if (ls.action === 'not_found') return '⚠️ 台账未找到该批次行（按摘要匹配），请人工核对补记';
      if (ls.action === 'disabled') return '⚠️ 未配置台账表（LEDGER_SPREADSHEET_TOKEN），同步关闭';
      if (ls.action === 'ambiguous') return '⚠️ 台账存在多行同摘要，请人工处理';
      return '❌ 台账同步失败（见日志）';
    }
    const ls = await ledger.syncOnSubmit(ledgerBatchNo, deliveryNo || '');
    if (ls.action === 'appended') return `📗 台账已同步：${ledgerBatchNo} → 第 ${ls.rowIndex} 行`;
    // updated 已改多列形态 'deliveryNo,deliverDate,status'（v92 printed 预登记批）——
    // 旧 `=== 'deliveryNo'` 判定在多列补填时谎报「未重复添加」（2026-11-09 审查 P2）
    if (ls.action === 'exists') {
      const filledText = ls.updated
        ? `，已补填${ls.updated.split(',').map(s => ({ deliveryNo: '投递单号', deliverDate: '投递日期', status: '状态' }[s] || s)).join('/')}`
        : '';
      return `📗 台账已有该批次行（第 ${ls.rowIndex} 行）${filledText}，未重复添加`;
    }
    if (ls.action === 'no_summary') return '⚠️ 该批次无摘要（旧批次），没有台账口径，请人工登记';
    if (ls.action === 'disabled') return '⚠️ 未配置台账表（LEDGER_SPREADSHEET_TOKEN），同步关闭';
    if (ls.action === 'ambiguous') return '⚠️ 台账存在多行同摘要，请人工处理';
    return '❌ 台账同步失败（见日志）';
  }

  if (sub === 'regen') {
    if (!args[1]) return '❌ 用法：/approval-batch regen <批次号>（重新生成 打印PDF/BOM/物料清单/扫码清单）';
    const r = await batchService.regenerateBatchFiles(args[1]);
    const lines = [
      `🔄 批次 ${r.batchNo} 附件已重新生成（${r.count} 张）：`,
      r.pdfToken ? '· 🖨️ 打印件 PDF ✅' : '· ⚠️ 打印件 PDF 生成失败（见日志）',
      r.bomToken ? '· 📊 BOM 表 ✅' : '· ⚠️ BOM 生成失败（见日志）',
      r.mlToken ? '· 🧾 物料清单（校格式）✅' : '· ⚠️ 物料清单生成失败（见日志）',
      r.docxToken ? '· 📄 打印件 docx（可编辑版）✅' : '· ⚠️ 打印件 docx 生成失败（见日志）',
      ...(r.specialCount ? [`· 🚩 特殊事项附页 ✅（${r.specialCount} 张）`] : []),
    ];
    // 金额漂移警示（复查 P1）：regen 用采集表现值重造附件，与锁定值对不上要财务核对台账
    if (r.amountDrift) {
      lines.push(`· ⚠️ regen 后金额合计 ¥${r.amountDrift.current.toFixed(2)} 与批次锁定值 ¥${r.amountDrift.recorded.toFixed(2)} 不一致，请核对台账与采集表`);
    }
    // 重发交付卡（2026-10-27 曼波反馈：regen 补票/修文件后群里的旧卡二维码数量/内容已过期——
    // 新卡按最新 scanItems 重发，财务不用翻表格）。发送失败不遮蔽 regen 成果，回执提示即可；
    // 熔断返回 null 时如实说「暂缓」（2026-10-30 审查批）。异常与熔断分路（2026-11-03 审查 P2）
    try {
      const sent = await sendDeliveryCard({
        batchNo: r.batchNo, project: r.project || '', count: r.count, amount: r.amount || 0,
        summary: r.summary || '', warningCount: 0, missingContent: 0,
        generated: { pdf: !!r.pdfToken, printDocx: !!r.docxToken, bom: !!r.bomToken, materialList: !!r.mlToken, specialSheet: !!(r.specialPdfToken || r.specialDocxToken), scanSheet: !!r.ssToken },
        specialCount: r.specialCount, blankCount: r.blankCount, scanItems: r.scanItems || [], abnormalItems: r.abnormalItems || [],
        notFullyCollected: r.notFullyCollected || [],
      });
      if (sent) lines.push('· 📦 最新交付卡已重发群（二维码按当前票面重建）');
      else lines.push('· ⚠️ 交付卡重发被播报熔断暂缓（今日卡片额度已满），稍后重试或从批次表附件取用');
    } catch (err) {
      console.error('[对话服务] regen 后交付卡重发失败:', err.message);
      lines.push(`· ⚠️ 交付卡重发失败（${err.message.slice(0, 40)}），请从批次表附件取用`);
    }
    return lines.join('\n');
  }

  if (sub === 'confirm') {
    // 交付确认（2026-09-29 两阶段流程）：确认自动批次详情 → 生成交付件 + 群发二维码卡
    if (!args[1]) return '❌ 用法：/approval-batch confirm <批次号>（确认报销单明细后才开始生成交付件与二维码）';
    const { operator } = await resolveOperator(ctx);
    const r = await batchService.confirmDelivery(args[1], operator);
    if (!r.generated) return `ℹ️ 批次 ${r.batchNo} 的交付件此前已生成，无需重复确认（直接从报销批次表附件取用即可）`;
    const g = r.regen;
    let sent = null;
    try {
      sent = await sendDeliveryCard({
        batchNo: r.batchNo, project: g.project || '', count: g.count, amount: g.amount || 0,
        summary: g.summary || '', warningCount: 0, missingContent: 0,
        generated: { pdf: !!g.pdfToken, printDocx: !!g.docxToken, bom: !!g.bomToken, materialList: !!g.mlToken, specialSheet: !!(g.specialPdfToken || g.specialDocxToken), scanSheet: !!g.ssToken },
        specialCount: g.specialCount, blankCount: g.blankCount, scanItems: g.scanItems || [], abnormalItems: g.abnormalItems || [],
        notFullyCollected: g.notFullyCollected || [],
      });
    } catch (err) {
      console.error('[对话服务] 确认后交付卡发送失败:', err.message);
      return `✅ 批次 ${r.batchNo} 已确认，交付件已生成并落「报销批次」表附件（${g.count} 张）；⚠️ 交付卡发送失败（${err.message.slice(0, 40)}），请直接从表格附件取用`;
    }
    if (sent === null) {
      return `✅ 批次 ${r.batchNo} 已确认，交付件已生成并落「报销批次」表附件（${g.count} 张）；⚠️ 交付卡被播报熔断暂缓（今日卡片额度已满），稍后重试或直接从表格附件取用`;
    }
    return `✅ 批次 ${r.batchNo} 已确认并开始工作：交付件（发票排版/物料清单/扫码清单）已生成，二维码卡已发群。录入完成后：/approval-batch submit ${r.batchNo}；打印完成后：/approval-batch printed ${r.batchNo}`;
  }

  if (sub === 'printed') {
    // 打印完成标记（2026-09-29 两阶段流程收尾）：12h 询问后财务回复确认。
    // 2026-11-06 曼波定：打印回执即记账——标记完成的同时台账自动预登记（行不存在才追加）；
    // 同批挂资金指令白名单（printed 会写台账真账，与 lock/submit/paid/reject/ledger 同口径）
    if (!args[1]) return '❌ 用法：/approval-batch printed <批次号>（标记该批发票已打印完成，同时台账自动预登记）';
    const denied = fundOperatorDenied(ctx);
    if (denied) return denied;
    const { operator } = await resolveOperator(ctx);
    await batchService.markPrinted(args[1], operator);
    const lines = [`🖨️ 批次 ${args[1]} 已标记打印完成（${operator || '财务确认'}）。`];
    lines.push(await syncLedgerQuietly('printed', args[1]));
    lines.push('接下来照常 submit/paid 走资金流转。');
    return lines.filter(Boolean).join('\n');
  }

  return '❌ 子指令不支持。用法：/approval-batch [preview] | lock <批次号> [项目] [用途=xx] | status | submit <批次号> [投递单号] | paid/reject <批次号> | confirm <批次号> | printed <批次号> | regen <批次号> | ledger [submit|paid|reject] <批次号> [投递单号]';
}

/**
 * 台账同步（submit/paid/reject 生命周期点）：
 * submit 追加行（可带投递单号），paid 回填入账日期+已到账，reject 标记已退回。
 * 未配置台账表 / 写失败 → 返回提示行（不抛错，不阻断批次状态流转）。
 */
async function syncLedgerQuietly(sub, batchNo, deliveryNo = '') {
  try {
    const ledger = require('./ledgerSheetService');
    if (sub === 'printed') {
      // 打印回执即记账（2026-11-06 曼波定）：台账自动预登记，写失败不影响打印标记
      const ls = await ledger.syncOnSubmit(batchNo, '', { stage: 'printed' });
      if (ls.action === 'appended') return `· 📗 台账已预登记：第 ${ls.rowIndex} 行（提交后 ${deliveryNo ? 'submit 补投递单号/日期/状态' : 'submit 会补投递单号/日期/状态'}）`;
      if (ls.action === 'exists') return `· 📗 台账已有该批次行（第 ${ls.rowIndex} 行），未重复登记`;
      if (ls.action === 'no_summary') return '· ⚠️ 台账未登记：该批次无摘要（旧批次），请人工登记';
      if (ls.action === 'ambiguous') return '· ⚠️ 台账存在多行同摘要，请人工处理（未追加、未改动）';
      if (ls.action === 'disabled') return '· ⚠️ 未配置台账表（LEDGER_SPREADSHEET_TOKEN），同步关闭';
      return '';
    }
    if (sub === 'submit') {
      const ls = await ledger.syncOnSubmit(batchNo, deliveryNo);
      if (ls.action === 'appended') return `· 📗 台账已同步：第 ${ls.rowIndex} 行（投递单号${deliveryNo ? '已填' : '留空，可在表内补'}）`;
      if (ls.action === 'exists') {
        const filledText = ls.updated
          ? `，已补填${ls.updated.split(',').map(s => ({ deliveryNo: '投递单号', deliverDate: '投递日期', status: '状态' }[s] || s)).join('/')}`
          : '';
        return `· 📗 台账已有该批次行（第 ${ls.rowIndex} 行）${filledText}，未重复添加`;
      }
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次），请人工登记';
      if (ls.action === 'ambiguous') return '· ⚠️ 台账存在多行同摘要，请人工处理（未追加、未改动）';
      return '';
    }
    if (sub === 'paid') {
      const ls = await ledger.syncOnStatus(batchNo, { paid: true });
      if (ls.action === 'updated') {
        // 公用卡收支明细即时同步（2026-11-06 曼波定：入账行 → wiki 数据表27）；
        // 失败仅记日志不回执，每小时轮询兜底重试
        require('./cardFlowSyncService').triggerAfterPaid();
        return `· 📗 台账已回填：入账日期 + 已到账（第 ${ls.rowIndex} 行）`;
      }
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次）';
      if (ls.action === 'not_found') return '· ⚠️ 台账未找到该批次行（按摘要匹配），请人工核对补记';
      if (ls.action === 'ambiguous') return '· ⚠️ 台账存在多行同摘要，请人工处理（未回填）';
      return '';
    }
    if (sub === 'reject') {
      const ls = await ledger.syncOnStatus(batchNo, { rejected: true });
      if (ls.action === 'updated') return `· 📗 台账已标记：已退回（第 ${ls.rowIndex} 行）`;
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次）';
      if (ls.action === 'not_found') return ''; // 尚未 submit 过的批次本就没进台账，静默
      if (ls.action === 'ambiguous') return '· ⚠️ 台账存在多行同摘要，请人工处理（未标记）';
      return '';
    }
    return '';
  } catch (err) {
    console.error('[对话服务] 台账同步失败:', err.message);
    return `· ⚠️ 台账同步失败：${err.message}（批次状态已变更，可 /approval-batch ledger ${batchNo} 重试）`;
  }
}

/**
 * 操作人归属（2026-09-25 安全审查 #2 防冒名）：资金指令的操作人身份以 hub 透传的
 * senderId（open_id）反查通讯录实名为准，**不信自报 senderName**；
 * 通讯录失败 fail-open 回落自报名（同催发票通讯录兜底口径），查无此人如实降级。
 */
async function resolveOperator(ctx = {}) {
  const senderId = ctx.senderId || '';
  const selfReported = ctx.senderName || '';
  if (!senderId) return { operator: selfReported, verified: false };
  try {
    const users = await contacts.listActiveUsers();
    if (users.has(senderId)) return { operator: users.get(senderId) || selfReported || senderId, verified: true };
    return { operator: selfReported || senderId, verified: false };
  } catch (err) {
    console.error('[对话服务] 通讯录实名反查失败（fail-open 回落自报名）:', err.message);
    return { operator: selfReported, verified: false };
  }
}

/**
 * 接取批次（审批群交付卡的领取回路）：回复「接取」= 接最近锁定的未接取批次；
 * 「接取 <批次号>」= 指定批次。登记接取人（hub 透传 senderName）与时间。
 */
async function handleTakeCommand(args = [], ctx = {}) {
  const batchService = require('./batchService');
  const { operator, verified } = await resolveOperator(ctx);
  const r = await batchService.claimBatch(args[0] || '', operator);
  return [
    // 未经通讯录校验时如实标注（复查 P2：接取人登记可被自报名冒用，回执要让财务可见）
    `✅ 批次 ${r.batchNo} 已接取（${r.taker}${verified ? '' : '，未经通讯录校验'}）${r.reClaim ? '· 重复接取，登记不变' : ''}`,
    `· ${r.count} 张 ¥${Number(r.amount).toFixed(2)}（${r.project}）`,
    r.summary ? `· 摘要：${r.summary}` : '',
    `· 按打印件顺序扫小翼Plus 录入，开票内容缺失的现场补；完成后：/approval-batch submit ${r.batchNo}`,
  ].filter(Boolean).join('\n');
}

/**
 * 执行指令并返回回复文本（群聊消息与 HTTP 转发共用）
 * @param {string} command
 * @param {string[]} args
 * @param {{senderName?: string, senderId?: string}} ctx hub 转发透传的发送者身份（「接取」登记用）
 * @returns {Promise<string|null>} 未匹配指令返回 null
 */
async function executeCommand(command, args = [], ctx = {}) {
  // args 形态守卫（2026-11-03 审查 P3）：契约传数组；传字符串时 args[0] 会取到首字符、
  // lock 分支 for-of 迭代字符——统一归一成数组
  if (!Array.isArray(args)) args = args ? [String(args)] : [];
  // 审批群内 /help 即为财务帮助
  if (command === '/help') command = '/approval-help';
  const handler = commandHandlers[command];
  if (!handler) return null;
  try {
    return await handler(args, ctx);
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
  resolveOperator, // 安全审查 #2：操作人实名反查（桩测试断言用）
};
