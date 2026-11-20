const config = require('../config');
const bitableApi = require('../feishu/bitable');
const collectStore = require('./collectStore');
const { fieldText } = require('../utils/fields');

// ============================================================
// 审批数据服务
//
// 播报策略：不做事件即时播报（审批提交/审批结果都不推），
// 播报只有定时任务（周播报催办清单 + 每日待审批提醒 + 催发票私聊），
// 因此这里只负责数据查询与催办分支计算。
// ============================================================

// 完成后 N 个月仍未转账才开始提醒
const TRANSFER_GRACE_MONTHS = 3;

// 宣运物资组别（2026-11-03 曼波定：审批新加的组别，走独立警戒线+物料清单特殊口径，
// 不参与按人名 500 金额线）
const XUANYUN_GROUP = '宣运物资';

/** 拉取全部审批记录 */
async function fetchAllApprovals() {
  return bitableApi.listAllRecords(config.bitable.approvalTableId);
}

/** 审批流程是否为当前活跃流程（未配置则不过滤） */
function isActiveProcess(fields) {
  if (!config.approvalProcesses.length) return true;
  return config.approvalProcesses.includes(fields['审批流程']);
}

function hasAttachment(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 是否已交发票：「发票」（Url）或「补交发票」（附件）任一栏有值即算已交
 * （补交发票为财务新增的补录栏，与发票栏等效；机器人采集通道亦写补交发票栏）
 */
function hasInvoiceSubmitted(fields) {
  return hasAttachment(fields['发票']) || hasAttachment(fields['补交发票']);
}

/**
 * 项目归属统一解析（所有读「项目」栏的地方共用，防口径漂移）。
 * 2026-10-27 审批结构更新（曼波定）：「是否参与集中采购？」变为「是否为教师垫付」，
 * 教师垫付类记录的「项目」栏为空 → **单独算人名项目**（项目=发起人姓名）：
 * 报销单号走非兵种格式 27{人名}{序}，摘要/物料清单用途同源；
 * 无教师垫付标记且项目为空的仍归「未归类」。
 * 2026-11-03 实查审批表（206 条）：同步列真名是「是否是教师垫付？」（v89 误写成
 * 「是否为教师垫付」，恒 undefined → 教师垫付人名项目判定失效回落未归类），两个列名都认。
 */
function resolveProject(fields) {
  const p = fields['项目'];
  const name = typeof p === 'string' ? p.trim() : (p && typeof p === 'object' ? String(p.name || '').trim() : '');
  if (name) return name;
  if (fieldText(fields['是否为教师垫付']) === '是' || fieldText(fields['是否是教师垫付？']) === '是') {
    const person = (Array.isArray(fields['发起人']) && fields['发起人'][0]?.name) || '';
    if (person) return person;
  }
  return '未归类';
}

/** 是否宣运物资组别（2026-11-03 曼波定：独立警戒线/物料清单用途列特殊口径的判定入口，
 *  走 resolveProject 同源——项目栏=宣运物资 即命中） */
function isXuanYunGroup(fields) {
  return resolveProject(fields) === XUANYUN_GROUP;
}

/**
 * 已采集台账的申请编号集合（fail-open：采集表未配置/查询失败时返回空集，
 * 退回两栏判断——本地开发与采集表未建的部署不崩）。
 * 口径：机器人采集成功即视为已交票（采集表为真源，补交发票栏是镜像）。
 * ⚠️ 2026-11-20 多票求和制（v103）后**不再作为「已交票」判据**——「收录 ≥1 张」≠「收齐」，
 * 催办/金额线/backfill 等消费点一律改用 getCollectedSumMap + isFullyCollected（收齐口径）。
 * 本函数仅保留给「这张票已在台账」类的收录性判断。
 */
async function getCollectedApplyNoSet() {
  try {
    const collects = await collectStore.listCollect();
    const set = new Set();
    for (const r of collects) {
      const applyNo = r.fields['关联申请编号'];
      if (applyNo) set.add(String(applyNo));
    }
    return set;
  } catch (err) {
    if (!/未配置发票采集表/.test(err.message)) {
      console.warn('[审批服务] 采集台账查询失败，退回两栏判断:', err.message);
    }
    return new Set();
  }
}

/**
 * 台账已收金额聚合（多票求和制收齐判据的数据源，v103）。
 * fail-open 同 getCollectedApplyNoSet：查询失败返回空 Map（视为全部未收齐，继续催）。
 * @returns {Promise<Map<string, {sum: number, count: number}>>}
 */
async function getCollectedSumMap() {
  try {
    return await collectStore.sumByApplyNo();
  } catch (err) {
    if (!/未配置发票采集表/.test(err.message)) {
      console.warn('[审批服务] 采集台账求和查询失败（按全部未收齐处理）:', err.message);
    }
    return new Map();
  }
}

/** 完成时间是否已超过 N 个月（无完成时间返回 false，不提醒） */
function isOlderThanMonths(timestamp, months) {
  if (!timestamp) return false;
  const ms = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
  if (Number.isNaN(ms)) return false;
  const deadline = new Date(ms);
  const day = deadline.getDate();
  deadline.setMonth(deadline.getMonth() + months);
  if (deadline.getDate() < day) {
    deadline.setDate(0); // 月末溢出（如 11-30 + 3 个月滚到 3-02）钳到目标月最后一天
  }
  return deadline.getTime() <= Date.now();
}

async function getAllApprovals() {
  return fetchAllApprovals();
}

/** 审批中列表（客户端过滤） */
async function getPendingApprovals() {
  const all = await fetchAllApprovals();
  return all.filter(r => r.fields?.['申请状态'] === config.approvalStatus.PENDING);
}

async function getApprovalById(id) {
  try {
    return await bitableApi.getRecord(config.bitable.approvalTableId, id);
  } catch (err) {
    console.error('[审批服务] 获取审批详情失败:', err.message);
    return null;
  }
}

/** 审批统计：全量分类 + 本周滚动7天结果（仅活跃流程；含按「项目」字段粗分类） */
async function getApprovalStats() {
  const all = await fetchAllApprovals();

  const stats = {
    total: all.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    other: 0,
    // 本周（滚动7天，仅活跃流程——周报统计口径与非活跃流程一律静默的约定一致）
    weekNew: 0,
    weekApproved: 0,
    weekRejected: 0,
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const APPROVED = config.approvalStatus.APPROVED;
  const REJECTED = config.approvalStatus.REJECTED;

  // 本周明细按「项目」分组（周报统计展示用；教师垫付类项目栏空 → 人名项目，2026-10-27）
  const weekProjects = { new: {}, approved: {}, rejected: {} };
  const bumpProject = (bucket, fields) => {
    const project = resolveProject(fields);
    bucket[project] = (bucket[project] || 0) + 1;
  };

  for (const item of all) {
    const f = item.fields || {};
    const status = f['申请状态'];
    if (status === config.approvalStatus.PENDING) stats.pending++;
    else if (status === APPROVED) stats.approved++;
    else if (status === REJECTED) stats.rejected++;
    else stats.other++;

    if (!isActiveProcess(f)) continue; // 周/项目统计排除历史与测试流程

    if (typeof f['发起时间'] === 'number' && f['发起时间'] >= weekAgo) {
      stats.weekNew++;
      bumpProject(weekProjects.new, f);
    }
    if (status === APPROVED && typeof f['完成时间'] === 'number' && f['完成时间'] >= weekAgo) {
      stats.weekApproved++;
      bumpProject(weekProjects.approved, f);
    }
    if (status === REJECTED && typeof f['完成时间'] === 'number' && f['完成时间'] >= weekAgo) {
      stats.weekRejected++;
      bumpProject(weekProjects.rejected, f);
    }
  }

  // {项目: 条数} → [{project, count}]，条数多的在前
  const toGroups = (bucket) => Object.entries(bucket)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count);

  const projects = {
    new: toGroups(weekProjects.new),
    approved: toGroups(weekProjects.approved),
    rejected: toGroups(weekProjects.rejected),
  };

  return { stats, projects, all };
}

/**
 * 超期未交发票（催发票私聊用）：「已通过」且完成时间满 graceDays 天、发票/补交发票均为空
 * 按完成时间正序（最久未交的排最前）
 */
/** 解析「总金额」（千分位容错统一入口——全量审查工位 A#6：三处解析口径漂移，
 *  "1,234.5" 裸 parseFloat 会截成 1，求和制收齐判据整体失真；统一走本函数） */
function parseTotalAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const p = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(p) ? p : null;
}

/**
 * 「已交票」判据 v105（全量审查工位 A#1 修复，求和制最终口径）：
 *   已交 = 「发票」栏有值（审批直附——审批系统管理的 Url 形态，干净信号：47% 已交票
 *   从未走采集通道，2026-11-16 实证） || 台账**收齐**（sumByApplyNo + isFullyCollected）。
 *   「补交发票」栏**不再单独算已交**（v102 求和制病灶本体：采集每张票都镜像 append 该栏，
 *   多票第 2 张起必非空——用它判定会把分批交票的中间态误判已交，v103 曾连同发票栏一起
 *   废止属过度修正——直附记录被永久误催发票，本函数恢复发票栏信号）。
 *   已交的记录进「未制单」分支（票面未进池的由锁定前补采收），不进「未交发票」分支。
 */
function isInvoiceSettled(f, collectedSumMap) {
  if (hasAttachment(f['发票'])) return true; // 审批直附：一次性交齐动作完成
  const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
  const amount = parseTotalAmount(f['总金额']);
  const collected = applyNo ? collectedSumMap.get(applyNo) : null;
  if (collected && collectStore.isFullyCollected(collected.sum, amount)) return true;
  // 总金额不可解析：收齐判定恒 false → 会永久催；fail-open 回落「至少交过一些」
  // （直附或台账收录过 = 视为已交转财务人工收口，不无限催）
  if (amount === null && (collected || hasInvoiceSubmitted(f))) return true;
  return false;
}

async function getOverdueInvoices() {
  const all = await fetchAllApprovals();
  const APPROVED = config.approvalStatus.APPROVED;
  const collectedSumMap = await getCollectedSumMap();
  const graceMs = config.invoiceUrge.graceDays * 24 * 60 * 60 * 1000;

  const overdue = all.filter((record) => {
    const f = record.fields || {};
    if (f['申请状态'] !== APPROVED) return false;
    if (!isActiveProcess(f)) return false;
    // v105 统一判据（工位 A#1/#2）：直附或收齐=已交不催；部分交未收齐继续催剩余票；
    // 总金额缺失 fail-open（此前与本函数在 getFinanceFollowUp 口径分叉——同一记录
    // 周报不催私聊催，修复为同款回落）
    if (isInvoiceSettled(f, collectedSumMap)) return false;
    const ms = typeof f['完成时间'] === 'number' ? f['完成时间'] : parseInt(f['完成时间'], 10);
    if (!ms || Number.isNaN(ms)) return false; // 无完成时间不催
    return ms + graceMs <= Date.now();
  });

  overdue.sort((a, b) => (a.fields['完成时间'] || 0) - (b.fields['完成时间'] || 0));
  return overdue;
}

/**
 * 财务催办三分支（仅针对「已通过」的活跃流程记录）：
 *   0. 是否打印=是 → 财务已自行制单打印（或已进机器人批次），整条跳过不催
 *   1. 未交发票：发票/补交发票均为空   → 催发票
 *   2. 未制单：  已有发票但报销单为空   → 做报销单
 *               （报销单=无需报销 视为已制单/无需处理；
 *                 「是否转账=是」不豁免本分支——报销单为空照催，
 *                 表格填录与线下流程可能不同步，2026-10-15 曼波定）
 *   3. 未转账：  已有发票和报销单但「是否转账」为空，
 *               且完成时间已超过 3 个月 → 提醒转账
 */
async function getFinanceFollowUp() {
  const all = await fetchAllApprovals();
  const APPROVED = config.approvalStatus.APPROVED;
  const collectedSumMap = await getCollectedSumMap();

  const missingInvoice = [];  // 未交发票（含部分交未收齐——求和制下继续催剩余票）
  const missingForm = [];     // 未制单（缺报销单）
  const missingTransfer = []; // 未转账（完成超3个月）

  for (const record of all) {
    const f = record.fields || {};
    if (f['申请状态'] !== APPROVED) continue;
    if (!isActiveProcess(f)) continue;

    // v105 统一判据（工位 A#1）：直附（发票栏）或台账收齐=已交 → 进「未制单」分支；
    // 部分交未收齐且总金额可解析 → 继续走「催发票」分支催剩余票（求和制，不再提前催制单
    // 拆单）；总金额缺失 fail-open 回落「至少交过」转财务人工收口（同 getOverdueInvoices）
    const hasInvoice = isInvoiceSettled(f, collectedSumMap);
    // 是否打印=是（2026-09-29 曼波定）：财务已自行制单打印（或已进机器人批次）——
    // 该记录整条跳过（不催制单也不催转账），机器人不与财务手工线重合
    if (fieldText(f['是否打印']) === '是') continue;
    // 报销单为单选：null=未制单；「无需报销」=无需制单，视为已完成该环节
    const form = f['报销单'];
    const hasForm = form !== null && form !== undefined && form !== '';

    if (!hasInvoice) {
      missingInvoice.push(record);
      continue; // 没发票时不会走到制单/转账环节
    }

    if (!hasForm) {
      missingForm.push(record);
      continue;
    }

    // 已有发票和报销单，检查转账（完成时间3个月后才开始提醒）
    if (!f['是否转账'] && isOlderThanMonths(f['完成时间'], TRANSFER_GRACE_MONTHS)) {
      missingTransfer.push(record);
    }
  }

  // 各段按完成/发起时间倒序，最老的在前（越久未处理越靠前）
  const byTime = (a, b) => (a.fields['完成时间'] || a.fields['发起时间'] || 0) - (b.fields['完成时间'] || b.fields['发起时间'] || 0);
  missingInvoice.sort(byTime);
  missingForm.sort(byTime);
  missingTransfer.sort(byTime);

  return { missingInvoice, missingForm, missingTransfer };
}

module.exports = {
  getAllApprovals,
  getPendingApprovals,
  getApprovalById,
  getApprovalStats,
  getFinanceFollowUp,
  getOverdueInvoices,
  isActiveProcess,
  hasInvoiceSubmitted,
  resolveProject,
  isXuanYunGroup,
  XUANYUN_GROUP,
  getCollectedApplyNoSet,
  getCollectedSumMap,
};
