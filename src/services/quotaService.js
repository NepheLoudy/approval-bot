/**
 * 项目额度服务（2026-11-21 曼波定）：每个项目的花销（以报销单=批次表为准）从给定额度
 * 里扣除，周报播报各项目剩余额度；额度输入/重置经运维台（SSH 代理 → 本服务 HTTP 端点）
 * 或财务群 /approval-quota 指令（资金白名单）操作。
 *
 * 数据模型：「项目额度」表（审批 base 下，scripts/create-collect-tables.js 幂等建表）：
 *   项目（唯一 key，=批次表「项目」口径）/ 总额度 / 初始已用 / 备注 / 更新时间。
 *
 * 占用口径（细化定稿）：
 *   - 消耗 spent = 批次表「已锁定/已提交/已到账」的「金额合计」之和，按项目聚合
 *     （承诺即占用：锁定=机器人已发布报销单，这笔钱注定要花；已到账=真实消耗）；
 *   - 「已退回」不占（退回票池，额度释放）；「拟批」不占（未锁定）；
 *   - 多项目批次（项目='A/B'）按主项目（split('/')[0]）归属——金额无法拆分，成文为已知限制；
 *   - 初始已用（initialSpent）：建账前的历史消耗预扣——v50 前的手工批次只存在于台账
 *     （摘要解析项目不可靠），设额度时把历史花销填进「初始已用」一次性计入；
 *   - remaining = 总额度 - 初始已用 - spent，< 0 = 超支（🚨）。
 *
 * 额度表无记录的项目不参与额度管理（批次照常走，仅不显示额度行）——额度是可选管理项，
 * 不是硬闸（报销流程不因缺额度配置而阻断）。
 */
const config = require('../config');
const bitableApi = require('../feishu/bitable');
const collectStore = require('./collectStore');

const QUOTA_TABLE = '项目额度';

function quotaTableId() {
  const id = config.bitable.quotaTableId;
  if (!id) throw new Error('未配置项目额度表 ID（BITABLE_QUOTA_TABLE_ID，先跑 scripts/create-collect-tables.js）');
  return id;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 读额度表全部行：[{record_id, project, quota, initialSpent, note}]（项目名去空白；同名行取首行并 warn） */
async function listQuotas() {
  const rows = await bitableApi.listAllRecords(quotaTableId());
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const f = r.fields || {};
    const project = String(f['项目'] || '').trim();
    if (!project) continue;
    if (seen.has(project)) console.warn(`[项目额度] 项目「${project}」在额度表存在多行，取首行（请清理重复行）`);
    seen.add(project);
    const num = (v) => {
      if (typeof v === 'number') return v;
      const p = parseFloat(String(v ?? '').replace(/,/g, ''));
      return Number.isFinite(p) ? p : 0;
    };
    out.push({
      record_id: r.record_id,
      project,
      quota: num(f['总额度']),
      initialSpent: num(f['初始已用']),
      note: String(f['备注'] || ''),
    });
  }
  return out;
}

/** upsert 单项目额度（幂等：同名行更新，无则新建）。amount/initialSpent 均须 ≥0。
 * @returns {{action: 'created'|'updated', project, quota, initialSpent}}
 */
async function setQuota(project, amount, initialSpent = 0, note = '') {
  const name = String(project || '').trim();
  if (!name) throw new Error('项目名不能为空');
  const quota = Number(amount);
  const init = Number(initialSpent) || 0;
  if (!Number.isFinite(quota) || quota < 0) throw new Error(`总额度非法：${amount}（须为 ≥0 的数字）`);
  if (!Number.isFinite(init) || init < 0) throw new Error(`初始已用非法：${initialSpent}（须为 ≥0 的数字）`);
  if (init > quota) throw new Error(`初始已用（${init}）大于总额度（${quota}）——若历史消耗确超预算请调高总额度`);

  const rows = await bitableApi.listAllRecords(quotaTableId());
  const hit = rows.find(r => String((r.fields || {})['项目'] || '').trim() === name);
  const fields = {
    '项目': name,
    '总额度': quota,
    '初始已用': init,
    '更新时间': Date.now(),
    ...(note ? { '备注': String(note).slice(0, 200) } : {}),
  };
  if (hit) {
    await bitableApi.updateRecord(quotaTableId(), hit.record_id, fields);
    return { action: 'updated', project: name, quota, initialSpent: init };
  }
  await bitableApi.createRecord(quotaTableId(), fields);
  return { action: 'created', project: name, quota, initialSpent: init };
}

/** 删除项目额度行（撤销额度管理）。
 * @returns {{action: 'deleted'|'not_found', project}}
 */
async function deleteQuota(project) {
  const name = String(project || '').trim();
  if (!name) throw new Error('项目名不能为空');
  const rows = await bitableApi.listAllRecords(quotaTableId());
  const hit = rows.find(r => String((r.fields || {})['项目'] || '').trim() === name);
  if (!hit) return { action: 'not_found', project: name };
  await bitableApi.deleteRecord(quotaTableId(), hit.record_id);
  return { action: 'deleted', project: name };
}

/**
 * 额度总览：额度表 × 批次表占用聚合。
 * 批次项目归属：primaryProject = 项目字段 split('/')[0]（多项目批次按主项目归属，已知限制）。
 * @returns {Promise<{items: Array<{project, quota, initialSpent, locked, submitted, paid, spent, remaining, overspend}>, unmanaged: Array<{project, spent}>}>}
 *   items=额度表内的项目（按剩余升序，超支在前）；unmanaged=批次表里消耗着但没有额度配置的项目（提示补配）。
 */
async function getQuotaOverview() {
  const quotas = await listQuotas();
  const batches = await collectStore.listBatches();

  const byProject = new Map();
  for (const b of batches) {
    const f = b.fields || {};
    const status = String(f['状态'] || '已锁定');
    if (status === '拟批' || status === '已退回') continue; // 未锁定/已退回不占额度
    const project = String(f['项目'] || '').split('/')[0].trim() || '未归类';
    const amount = typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(String(f['金额合计'] ?? '').replace(/,/g, '')) || 0);
    const cur = byProject.get(project) || { locked: 0, submitted: 0, paid: 0 };
    if (status === '已锁定') cur.locked = round2(cur.locked + amount);
    else if (status === '已提交') cur.submitted = round2(cur.submitted + amount);
    else if (status === '已到账') cur.paid = round2(cur.paid + amount);
    byProject.set(project, cur);
  }

  const items = quotas.map((q) => {
    const spend = byProject.get(q.project) || { locked: 0, submitted: 0, paid: 0 };
    const spent = round2(spend.locked + spend.submitted + spend.paid);
    const remaining = round2(q.quota - q.initialSpent - spent);
    return {
      project: q.project,
      quota: q.quota,
      initialSpent: q.initialSpent,
      note: q.note,
      locked: spend.locked,
      submitted: spend.submitted,
      paid: spend.paid,
      spent,
      remaining,
      overspend: remaining < 0,
    };
  });
  items.sort((a, b) => a.remaining - b.remaining); // 超支/紧张在前

  const managed = new Set(quotas.map(q => q.project));
  const unmanaged = [...byProject.entries()]
    .filter(([p]) => !managed.has(p))
    .map(([project, s]) => ({ project, spent: round2(s.locked + s.submitted + s.paid) }));
  unmanaged.sort((a, b) => b.spent - a.spent);

  return { items, unmanaged };
}

/** 单项目额度视角（lockBatch 超支预警用）：无配置返回 null（不预警）。
 * @returns {Promise<{remaining: number, quota: number, spent: number} | null>} */
async function getProjectQuota(project) {
  const overview = await getQuotaOverview();
  return overview.items.find(i => i.project === String(project || '').trim()) || null;
}

module.exports = {
  QUOTA_TABLE,
  quotaTableId,
  listQuotas,
  setQuota,
  deleteQuota,
  getQuotaOverview,
  getProjectQuota,
};
