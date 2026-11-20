/**
 * 发票采集与报销批次数据层（真源=审批 base 下机器人自建的两张表）。
 *
 * 「发票采集」表：每张识别入库的发票一行，查重/批次/对账都以本表为准；
 *   审批表的「补交发票」栏只作为财务可见的镜像（采集成功时回写附件）。
 * 「报销批次」表：财务三件套的批次状态机 拟批→已锁定→已提交→已到账/已退回，
 *   批次号沿用财务既有命名（如 27备赛20步兵5），锁定时回写审批表「报销单」栏。
 *
 * 发票与「补交发票」栏等价口径：审批表判断已交票用 hasInvoiceSubmitted
 * （发票/补交发票任一有值），本表与该口径对齐——采集记录视为已交。
 */
const config = require('../config');
const bitableApi = require('../feishu/bitable');

const COLLECT_TABLE = '发票采集';
const BATCH_TABLE = '报销批次';

function collectTableId() {
  const id = config.bitable.collectTableId;
  if (!id) {
    throw new Error('未配置发票采集表 ID（BITABLE_COLLECT_TABLE_ID，先跑 scripts/create-collect-tables.js）');
  }
  return id;
}

function batchTableId() {
  const id = config.bitable.batchTableId;
  if (!id) {
    throw new Error('未配置报销批次表 ID（BITABLE_BATCH_TABLE_ID，先跑 scripts/create-collect-tables.js）');
  }
  return id;
}

// ---------- 发票采集表 ----------

async function listCollect() {
  return bitableApi.listAllRecords(collectTableId());
}

/** 按发票号精确查（含多记录返回，便于发现一票多挂） */
async function findByInvoiceNo(invoiceNo) {
  if (!invoiceNo) return [];
  const all = await listCollect();
  return all.filter(r => String(r.fields['发票号码'] || '') === String(invoiceNo));
}

/**
 * 按关联申请编号聚合已交票（2026-11-20 多票求和对账，曼波定）：
 * 一个审批可分多张发票提交（分批交票），金额对账=已收票金额之和 vs 审批总金额。
 * 一次全量 listCollect 内存聚合（防逐审批 N+1 查询）。
 * @returns {Map<string, {sum: number, count: number}>} applyNo → 已收金额和/张数
 *   （价税合计非法值按 0 计并 warn——脏数据静默吞会让「收齐」判定失真）
 */
async function sumByApplyNo() {
  const collects = await listCollect();
  const map = new Map();
  for (const r of collects) {
    const applyNo = String(r.fields['关联申请编号'] || '');
    if (!applyNo) continue; // 未归类票不进求和（归类后由 matchRecord 关联）
    const amt = Number(r.fields['价税合计']);
    if (!Number.isFinite(amt)) {
      console.warn(`[采集台账] 关联申请 ${applyNo} 存在非法价税合计（${JSON.stringify(r.fields['价税合计'])}），按 0 计入求和——请财务核对该行`);
    }
    const cur = map.get(applyNo) || { sum: 0, count: 0 };
    cur.sum += Number.isFinite(amt) ? amt : 0;
    cur.count += 1;
    map.set(applyNo, cur);
  }
  return map;
}

/**
 * 收齐判定（2026-11-20 多票求和制，全仓「已交票」判据统一入口）：
 * 已收票金额和 ≥ 审批总金额-0.01（一分容差）= 收齐。
 * 语义是对「未收齐」的审批继续催票/继续补采/继续计金额线——交 1/N 张=已交票的旧口径
 * （getCollectedApplyNoSet）会催办拆单/金额线低估，v103 起各消费点一律改用本判定。
 * 总金额不可解析（null/NaN）时无法判定 → 返回 false（视为未收齐，保守继续催，
 * 由财务人工收口——绝不因数据缺失而静默放行）。
 * @param {number} collectedSum 台账已收票金额和（sumByApplyNo().sum）
 * @param {number|null} totalAmount 审批「总金额」
 * @returns {boolean}
 */
function isFullyCollected(collectedSum, totalAmount) {
  if (typeof totalAmount !== 'number' || !Number.isFinite(totalAmount)) return false;
  return collectedSum >= totalAmount - 0.01;
}

/**
 * 三元组近似查重（开票日期+价税合计+销售方税号）：发票号 OCR 错一位时的第二道闸。
 * 注意「开票日期」在表内是毫秒时间戳（DATE 字段），入参 issueDate 是 'YYYY-MM-DD'，
 * 这里统一转毫秒比对（此前直接字符串比较导致该闸恒不命中——复查 P1-1）。
 * 返回近似命中的采集记录列表。
 */
async function findBySimilarity({ issueDate, totalAmount, sellerTaxNo }) {
  if (!issueDate || !totalAmount) return [];
  const expectedMs = new Date(`${issueDate}T00:00:00+08:00`).getTime();
  if (Number.isNaN(expectedMs)) return [];
  const all = await listCollect();
  return all.filter((r) => {
    const f = r.fields;
    const recorded = typeof f['开票日期'] === 'number' ? f['开票日期'] : parseInt(f['开票日期'], 10);
    if (!(recorded === expectedMs)) return false;
    const amount = typeof f['价税合计'] === 'number' ? f['价税合计'] : parseFloat(f['价税合计']);
    if (!(Math.abs((amount || NaN) - totalAmount) < 0.005)) return false;
    if (sellerTaxNo && f['销售方税号'] && String(f['销售方税号']) !== String(sellerTaxNo)) return false;
    return true;
  });
}

async function createCollect(fields) {
  return bitableApi.createRecord(collectTableId(), fields);
}

async function updateCollect(recordId, fields) {
  return bitableApi.updateRecord(collectTableId(), recordId, fields);
}

// ---------- 报销批次表 ----------

async function listBatches() {
  return bitableApi.listAllRecords(batchTableId());
}

async function findBatchByName(batchName) {
  const all = await listBatches();
  return all.find(r => String(r.fields['批次号'] || '') === String(batchName)) || null;
}

async function createBatch(fields) {
  return bitableApi.createRecord(batchTableId(), fields);
}

async function updateBatch(recordId, fields) {
  return bitableApi.updateRecord(batchTableId(), recordId, fields);
}

// ---------- 台账汇总（财务播报「报销台账」段用） ----------

const BATCH_STATUS = {
  DRAFT: '拟批',
  LOCKED: '已锁定',
  SUBMITTED: '已提交',
  PAID: '已到账',
  REJECTED: '已退回',
};

/** 台账状态快照：票池/各状态批次张数与金额 */
async function getLedgerSummary() {
  const collects = await listCollect();
  const batches = await listBatches();

  const pool = collects.filter(r => !r.fields['批次']); // 已识别未归集
  const batchByStatus = {};
  let batchAmount = 0;
  for (const b of batches) {
    const status = b.fields['状态'] || BATCH_STATUS.LOCKED;
    const amount = typeof b.fields['金额合计'] === 'number' ? b.fields['金额合计'] : (parseFloat(b.fields['金额合计']) || 0);
    if (!batchByStatus[status]) batchByStatus[status] = { count: 0, amount: 0 };
    batchByStatus[status].count++;
    batchByStatus[status].amount += amount;
    batchAmount += amount;
  }
  const poolAmount = pool.reduce((s, r) => s + (typeof r.fields['价税合计'] === 'number' ? r.fields['价税合计'] : (parseFloat(r.fields['价税合计']) || 0)), 0);

  return {
    poolCount: pool.length,
    poolAmount: Math.round(poolAmount * 100) / 100,
    batches: batchByStatus,
    totalCollected: collects.length,
  };
}

module.exports = {
  COLLECT_TABLE,
  BATCH_TABLE,
  BATCH_STATUS,
  collectTableId,
  batchTableId,
  listCollect,
  findByInvoiceNo,
  sumByApplyNo,
  isFullyCollected,
  findBySimilarity,
  createCollect,
  updateCollect,
  listBatches,
  findBatchByName,
  createBatch,
  updateBatch,
  getLedgerSummary,
};
