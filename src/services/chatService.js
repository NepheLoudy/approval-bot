const config = require('../config');
const approvalService = require('./approvalService');
const invoiceUrgeService = require('./invoiceUrgeService');
const contacts = require('../feishu/contacts');
const { sendTextToChat, replyTextMessage, sendMessage, buildUrgeCard, buildDeliveryCard } = require('../feishu/bot');
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
    '                    submit <批次号> [投递单号] | paid/reject <批次号> | regen <批次号> | ledger <批次号>',
    '                    （submit/paid/reject 自动同步《报销台账》电子表格）',
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
  '接取': handleTakeCommand, // 审批群交付卡领取（hub 转发裸词，非 / 指令）
};

/**
 * 报销批次三件套指令（财务三件套自动化）：
 *   /approval-batch                      → 拟批建议（票池按项目分组）
 *   /approval-batch lock <批次号> [项目] [用途=xx] [费用项=xx] [采购类型=xx]
 *                                        → 锁定（回写两表 + 生成 打印PDF/BOM/物料清单/投递底单
 *                                          + 审批群发交付卡，回复「接取」领取）
 *   /approval-batch status               → 批次总览（含接取人）
 *   /approval-batch submit <批次号> [投递单号] → 标记已提交学校 + 台账表追加行（幂等）
 *   /approval-batch paid <批次号>        → 标记已到账（台账回填入账日期+已到账）+ 归档名建议
 *   /approval-batch reject <批次号>      → 标记已退回（台账标记已退回；退回票自动回票池）
 *   /approval-batch regen <批次号>       → 四件附件重新生成
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
    lines.push('锁定后自动生成 打印件PDF + BOM + 物料清单（校格式）+ 投递底单，落「报销批次」表附件并向本群发交付卡，回复「接取」领取');
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
      r.dsToken ? '· 📮 投递底单 ✅（照单录入小翼Plus）' : '· ⚠️ 投递底单生成失败（可 regen）',
    ].filter(Boolean);
    if (r.markFailed && r.markFailed.length) lines.push(`· ⚠️ ${r.markFailed.length} 张打标失败（${r.markFailed.slice(0, 5).join('、')}${r.markFailed.length > 5 ? '…' : ''}，已记入批次备注），请对漏标票人工补「批次/报销单」栏`);
    if (r.warningCount) lines.push(`· ⚠️ 含 ${r.warningCount} 张待人工/异常票，录入前先核对采集表「校验状态」`);
    if (r.missingContent) lines.push(`· ⚠️ ${r.missingContent} 张缺「开票内容」（底单已标黄），录入时现场补填`);
    // 交付卡（人工锁定触发的直接回路，即时发群；失败不阻断锁定）
    try {
      await sendMessage(buildDeliveryCard({
        batchNo: r.batchNo, project: r.projects.join('/'), count: r.count, amount: r.amount,
        summary: r.summary, warningCount: r.warningCount, missingContent: r.missingContent,
        generated: { pdf: !!r.pdfToken, bom: !!r.bomToken, materialList: !!r.mlToken, deliverySheet: !!r.dsToken },
      }));
    } catch (err) {
      console.error('[对话服务] 交付卡发送失败:', err.message);
      lines.push('· ⚠️ 交付卡发送失败（文件已在报销批次表附件，不影响使用）');
    }
    lines.push(`· 📦 交付卡已发本群，@机器人 回复「接取」领取后录入小翼Plus；完成后：/approval-batch submit ${r.batchNo}`);
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
    const deliveryNo = sub === 'submit' ? (args[2] || '') : '';
    const { operator, verified } = await resolveOperator(ctx);
    const r = await batchService.markBatch(args[1], statusMap[sub].status, operator);
    const lines = [`✅ 批次 ${r.batchNo} 已标记【${statusMap[sub].label}】：${r.count} 张 ¥${r.amount.toFixed(2)}`];
    if (operator) lines.push(`· 👤 操作人：${operator}${verified ? '' : '（自报，未经通讯录校验）'}`);
    // 报销台账电子表格同步（写失败不影响批次状态流转，回执如实提示可重试）
    lines.push(await syncLedgerQuietly(sub, r.batchNo, deliveryNo));
    if (r.archiveFolder) lines.push(`· 🗂️ 归档文件夹名建议：${r.archiveFolder}`);
    if (r.returnedToPool) lines.push(`· ${r.returnedToPool} 张退回票已回票池，可重新拟批`);
    return lines.filter(Boolean).join('\n');
  }

  if (sub === 'ledger') {
    if (!args[1]) return '❌ 用法：/approval-batch ledger <批次号> [投递单号]（把批次同步进台账表；已存在则只补投递单号）';
    const ledger = require('./ledgerSheetService');
    const ls = await ledger.syncOnSubmit(args[1], args[2] || '');
    if (ls.action === 'appended') return `📗 台账已同步：${args[1]} → 第 ${ls.rowIndex} 行`;
    if (ls.action === 'exists') return `📗 台账已有该批次行（第 ${ls.rowIndex} 行）${ls.updated === 'deliveryNo' ? '，已补填投递单号' : '，未重复添加'}`;
    if (ls.action === 'no_summary') return '⚠️ 该批次无摘要（旧批次），没有台账口径，请人工登记';
    if (ls.action === 'disabled') return '⚠️ 未配置台账表（LEDGER_SPREADSHEET_TOKEN），同步关闭';
    return '❌ 台账同步失败（见日志）';
  }

  if (sub === 'regen') {
    if (!args[1]) return '❌ 用法：/approval-batch regen <批次号>（重新生成 打印PDF/BOM/物料清单/投递底单）';
    const r = await batchService.regenerateBatchFiles(args[1]);
    return [
      `🔄 批次 ${r.batchNo} 附件已重新生成（${r.count} 张）：`,
      r.pdfToken ? '· 🖨️ 打印件 PDF ✅' : '· ⚠️ 打印件 PDF 生成失败（见日志）',
      r.bomToken ? '· 📊 BOM 表 ✅' : '· ⚠️ BOM 生成失败（见日志）',
      r.mlToken ? '· 🧾 物料清单（校格式）✅' : '· ⚠️ 物料清单生成失败（见日志）',
      r.dsToken ? '· 📮 投递底单 ✅' : '· ⚠️ 投递底单生成失败（见日志）',
    ].join('\n');
  }

  return '❌ 子指令不支持。用法：/approval-batch [preview] | lock <批次号> [项目] [用途=xx] | status | submit <批次号> [投递单号] | paid/reject <批次号> | regen <批次号> | ledger <批次号> [投递单号]';
}

/**
 * 台账同步（submit/paid/reject 生命周期点）：
 * submit 追加行（可带投递单号），paid 回填入账日期+已到账，reject 标记已退回。
 * 未配置台账表 / 写失败 → 返回提示行（不抛错，不阻断批次状态流转）。
 */
async function syncLedgerQuietly(sub, batchNo, deliveryNo = '') {
  try {
    const ledger = require('./ledgerSheetService');
    if (sub === 'submit') {
      const ls = await ledger.syncOnSubmit(batchNo, deliveryNo);
      if (ls.action === 'appended') return `· 📗 台账已同步：第 ${ls.rowIndex} 行（投递单号${deliveryNo ? '已填' : '留空，可在表内补'}）`;
      if (ls.action === 'exists') return `· 📗 台账已有该批次行（第 ${ls.rowIndex} 行），未重复添加${ls.updated === 'deliveryNo' ? '，已补填投递单号' : ''}`;
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次），请人工登记';
      return '';
    }
    if (sub === 'paid') {
      const ls = await ledger.syncOnStatus(batchNo, { paid: true });
      if (ls.action === 'updated') return `· 📗 台账已回填：入账日期 + 已到账（第 ${ls.rowIndex} 行）`;
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次）';
      if (ls.action === 'not_found') return '· ⚠️ 台账未找到该批次行（按摘要匹配），请人工核对补记';
      return '';
    }
    if (sub === 'reject') {
      const ls = await ledger.syncOnStatus(batchNo, { rejected: true });
      if (ls.action === 'updated') return `· 📗 台账已标记：已退回（第 ${ls.rowIndex} 行）`;
      if (ls.action === 'no_summary') return '· ⚠️ 台账未同步：该批次无摘要（旧批次）';
      if (ls.action === 'not_found') return ''; // 尚未 submit 过的批次本就没进台账，静默
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
  const { operator } = await resolveOperator(ctx);
  const r = await batchService.claimBatch(args[0] || '', operator);
  return [
    `✅ 批次 ${r.batchNo} 已接取（${r.taker}）${r.reClaim ? '· 重复接取，登记不变' : ''}`,
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
