const config = require('../config');
const bitableApi = require('../feishu/bitable');
const { buildNewApprovalCard, buildApprovalResultCard, sendMessage } = require('../feishu/bot');

// ============================================================
// 审批播报引擎：快照对账 + 状态迁移分支
//
// 飞书对同一应用的多个长连接随机分发事件（本应用与 PMR/ticket-bot
// 共用），多维表格事件可能被其他项目的连接抢走，因此播报不直接依赖
// 事件体，而是统一走「拉取记录 → 与内存快照 diff → 按迁移分支播报」：
//   - 事件到达（可能只到一半）→ 立即触发一次对账，快速反应
//   - 定时对账（BITABLE_POLL_MINUTES，默认5分钟）→ 兜底补漏
//
// 判断分支（依据「申请状态」单选字段的真实取值）：
//   记录新增（快照中不存在）：
//     审批流程 ∉ 活跃流程列表        → 跳过（历史/测试流程静默）
//     状态 = 审批中                  → 推送「新申请」卡片
//     状态 ∈ {已通过, 已拒绝}        → 直接推送「结果」卡片
//                                     （漏看了创建事件/快速审批的兜底）
//     状态 ∈ 撤回/取消/终止/删除     → 静默，仅记录快照
//   状态变更（prev ≠ next）：
//     → 已通过                       → ✅ 结果卡片
//     → 已拒绝                       → ❌ 结果卡片
//     → 撤回/取消/终止/删除          → 静默（撤回类操作不打扰群）
//     → 审批中                       → 静默（创建时已播报过）
//
// 首次启动的第一次对账只建快照、不播报（避免重启重放历史记录）。
// ============================================================

// record_id -> { status }（内存快照，重启后重建）
let snapshot = null;
// 对账互斥：事件触发与轮询可能并发，串行化避免重复播报
let syncQueue = Promise.resolve();
let lastSyncAt = null;
let lastSyncError = null;

function enqueueSync(fn) {
  const run = syncQueue.then(fn, fn);
  // 防止队列因单次失败而卡死
  syncQueue = run.catch(() => {});
  return run;
}

/** 审批流程是否为当前活跃流程（未配置则不过滤） */
function isActiveProcess(fields) {
  if (!config.approvalProcesses.length) return true;
  const processName = fields['审批流程'];
  return config.approvalProcesses.includes(processName);
}

function isTerminal(status) {
  return status === config.approvalStatus.APPROVED
    || status === config.approvalStatus.REJECTED
    || config.approvalStatus.SILENT_TERMINAL.includes(status);
}

/** 拉取全部记录（仅保留当前表） */
async function fetchAllApprovals() {
  return bitableApi.listAllRecords(config.bitable.approvalTableId);
}

/**
 * 对单条记录执行播报判断（调用方需保证串行）
 * @returns {Promise<{broadcast: boolean, type: string|null}>}
 */
async function evaluateRecord(prev, approval) {
  const recordId = approval.record_id;
  const fields = approval.fields || {};
  const status = fields['申请状态'];

  const no = fields['申请编号'] || recordId;

  if (!prev) {
    // ---- 新记录分支 ----
    if (!isActiveProcess(fields)) {
      console.log(`[审批事件] 跳过非活跃流程记录: ${no} (流程: ${fields['审批流程'] || '空'})`);
      return { broadcast: false, type: null };
    }
    if (status === config.approvalStatus.PENDING) {
      console.log(`[审批事件] 新申请，推送提醒: ${no}`);
      await sendMessage(buildNewApprovalCard(approval));
      return { broadcast: true, type: 'new' };
    }
    if (status === config.approvalStatus.APPROVED || status === config.approvalStatus.REJECTED) {
      // 创建事件被抢走、快照里首次见到的终态记录：直接播结果
      console.log(`[审批事件] 新发现的终态记录，补推结果: ${no} (${status})`);
      await sendMessage(buildApprovalResultCard(approval, status));
      return { broadcast: true, type: 'result' };
    }
    console.log(`[审批事件] 新记录为静默状态 (${status})，不播报: ${no}`);
    return { broadcast: false, type: null };
  }

  // ---- 状态迁移分支 ----
  if (prev.status === status) {
    return { broadcast: false, type: null };
  }
  console.log(`[审批事件] 状态变更: ${no} ${prev.status} -> ${status}`);

  if (status === config.approvalStatus.APPROVED || status === config.approvalStatus.REJECTED) {
    await sendMessage(buildApprovalResultCard(approval, status));
    return { broadcast: true, type: 'result' };
  }

  if (config.approvalStatus.SILENT_TERMINAL.includes(status)) {
    console.log(`[审批事件] 撤回类状态变更，静默处理: ${no} -> ${status}`);
    return { broadcast: false, type: null };
  }

  // 回到审批中或其他中间态：不播报
  return { broadcast: false, type: null };
}

/**
 * 全量对账：拉取审批表全部记录并与快照 diff，按分支播报
 * @param {boolean} [announce=true] false 时仅静默重建快照（启动初始化）
 */
async function syncAllApprovals(announce = true) {
  const records = await fetchAllApprovals();

  if (snapshot === null || !announce) {
    const count = records.length;
    snapshot = new Map(records.map(r => [r.record_id, { status: r.fields?.['申请状态'] }]));
    console.log(`[审批对账] 快照已初始化，共 ${count} 条记录${announce ? '' : '（静默模式）'}`);
    return { initialized: true, total: count, broadcasts: 0 };
  }

  let broadcasts = 0;
  const nextSnapshot = new Map();

  for (const record of records) {
    const prev = snapshot.get(record.record_id) || null;
    try {
      const result = await evaluateRecord(prev, record);
      if (result.broadcast) broadcasts++;
    } catch (err) {
      // 单条播报失败不阻断整轮对账，快照仍更新，避免反复重试造成刷屏
      console.error(`[审批对账] 记录 ${record.record_id} 播报失败:`, err.message);
    }
    nextSnapshot.set(record.record_id, { status: record.fields?.['申请状态'] });
  }

  // 消失的记录（被物理删除）→ 从快照移除即可
  snapshot = nextSnapshot;
  lastSyncAt = new Date().toISOString();

  if (broadcasts > 0) {
    console.log(`[审批对账] 本轮完成，播报 ${broadcasts} 条`);
  }
  return { initialized: false, total: records.length, broadcasts };
}

/**
 * 单条记录对账（事件触发路径）：立即回查该记录并按迁移分支播报
 * @param {string} recordId
 */
async function syncRecord(recordId) {
  if (!recordId) return { broadcast: false };

  // 快照未初始化时退化为全量对账（会静默建快照）
  if (snapshot === null) {
    return syncAllApprovals(true);
  }

  let approval;
  try {
    approval = await bitableApi.getRecord(config.bitable.approvalTableId, recordId);
  } catch (err) {
    // 记录可能已被删除或尚未同步到表格，静默跳过，等待全量对账
    console.log(`[审批事件] 回查记录失败（可能未同步），跳过: ${recordId} - ${err.message}`);
    return { broadcast: false };
  }

  const prev = snapshot.get(recordId) || null;
  const result = await evaluateRecord(prev, approval);
  snapshot.set(recordId, { status: approval.fields?.['申请状态'] });
  lastSyncAt = new Date().toISOString();
  return result;
}

/**
 * 串行执行对账（事件与轮询统一入口）
 * @param {'all'|'record'} mode
 * @param {string} [recordId]
 */
function scheduleSync(mode, recordId) {
  return enqueueSync(async () => {
    try {
      lastSyncError = null;
      return mode === 'record' ? await syncRecord(recordId) : await syncAllApprovals(true);
    } catch (err) {
      lastSyncError = err.message;
      throw err;
    }
  });
}

// ---------- 查询接口（供 API / 指令 / 播报使用） ----------

async function getAllApprovals() {
  return fetchAllApprovals();
}

/** 审批中列表（客户端过滤，不依赖 API 的 filter 参数） */
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

/** 审批统计（按真实状态值分类） */
async function getApprovalStats() {
  const all = await fetchAllApprovals();

  const stats = {
    total: all.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    other: 0,
    weekNew: 0,
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const item of all) {
    const status = item.fields?.['申请状态'];
    if (status === config.approvalStatus.PENDING) stats.pending++;
    else if (status === config.approvalStatus.APPROVED) stats.approved++;
    else if (status === config.approvalStatus.REJECTED) stats.rejected++;
    else stats.other++;

    const startTime = item.fields?.['发起时间'];
    if (typeof startTime === 'number' && startTime >= weekAgo) stats.weekNew++;
  }

  return { stats, all };
}

function getSyncStatus() {
  return {
    snapshotReady: snapshot !== null,
    snapshotSize: snapshot ? snapshot.size : 0,
    lastSyncAt,
    lastSyncError: lastSyncError ? String(lastSyncError) : null,
    pollIntervalMinutes: config.bitable.pollIntervalMinutes,
  };
}

module.exports = {
  getAllApprovals,
  getPendingApprovals,
  getApprovalById,
  getApprovalStats,
  scheduleSync,
  getSyncStatus,
};
