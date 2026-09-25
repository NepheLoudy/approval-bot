/**
 * 报销台账电子表格同步（《2027年千里团队报销台账》，飞书 Sheets）。
 *
 * 口径（照财务实表列结构：序号/投递单号/报销摘要/报销金额/项目编号/支付方式/收款方/
 * 收款账号/经办人/申请日期/投递日期/入账日期/状态，数据自第 3 行起，首行为合并标题）：
 *  - submit → 追加一行：摘要/金额/项目编号/支付方式/收款方/收款账号/经办人（=接取人）自动填，
 *    投递单号可带参数、不带留空给财务补；状态沿用财务词表「已提交至中心」；
 *  - paid / reject → 按批次「摘要」精确匹配找到该行，回填 入账日期+状态=已到账 / 状态=已退回；
 *  - 行匹配只用摘要精确等值（机器人拼装的摘要含「第N笔」全局唯一）；财务手填的历史行
 *    摘要对不上 → 如实报 not_found，绝不改别人的行；摘要已存在 → 跳过不重复追加（幂等）；
 *  - 日期写 'YYYY/M/D' 字符串（与实表人工填写风格一致）；
 *  - 台账写失败不影响批次状态流转（调用方 catch 后在回执里如实提示）。
 */
const config = require('../config');
const client = require('../feishu/client');
const collectStore = require('./collectStore');

const SUMMARY_COL_INDEX = 2; // C 列（0 基）
const GRID_COLS = 13; // A..M

function ledgerEnabled() {
  return Boolean(config.ledger.spreadsheetToken);
}

/** 首个工作表 id + 网格行数（LEDGER_SHEET_ID 可指定） */
async function resolveSheet() {
  const token = config.ledger.spreadsheetToken;
  if (config.ledger.sheetId) return { sheetId: config.ledger.sheetId, rowCount: 500 };
  const q = await client.requestAPI('GET', `/sheets/v3/spreadsheets/${token}/sheets/query`);
  if (q.code !== 0) throw new Error(`台账元信息读取失败: ${q.msg} (code: ${q.code})`);
  const sheets = (q.data && q.data.sheets) || [];
  if (!sheets.length) throw new Error('台账电子表格没有工作表');
  return { sheetId: sheets[0].sheet_id, rowCount: sheets[0].grid_properties?.row_count || 200 };
}

/** 读整个数据区（含标题两行） */
async function readGrid(sheetId) {
  const range = encodeURIComponent(`${sheetId}!A1:M500`);
  const r = await client.requestAPI('GET', `/sheets/v2/spreadsheets/${config.ledger.spreadsheetToken}/values/${range}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`);
  if (r.code !== 0) throw new Error(`台账读取失败: ${r.msg} (code: ${r.code})`);
  return (r.data && r.data.valueRange && r.data.valueRange.values) || [];
}

/** 摘要精确匹配行号（1 基；0=未找到） */
function findRowBySummary(grid, summary) {
  const target = String(summary || '').trim();
  for (let i = 0; i < grid.length; i++) {
    if (String(grid[i][SUMMARY_COL_INDEX] ?? '').trim() === target && target) return i + 1;
  }
  return 0;
}

/** 最后一个非空数据行的行号（1 基） */
function lastNonEmptyRow(grid) {
  let last = 0;
  for (let i = 0; i < grid.length; i++) {
    if ((grid[i] || []).some(c => c !== null && c !== undefined && String(c).trim() !== '')) last = i + 1;
  }
  return last;
}

async function writeRange(sheetId, range, values) {
  const r = await client.requestAPI('PUT', `/sheets/v2/spreadsheets/${config.ledger.spreadsheetToken}/values`, {
    valueRange: { range: `${sheetId}!${range}`, values },
  });
  if (r.code !== 0) throw new Error(`台账写入失败: ${r.msg} (code: ${r.code})`);
  return r;
}

/** 'YYYY/M/D'（与实表人工填写风格一致） */
function fmtDate(ms) {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * submit 时同步台账：追加一行（幂等——摘要已存在则跳过）。
 * @param {string} batchNo 批次号
 * @param {string} [deliveryNo] 投递单号（财务 submit 时可带；不带留空由财务回填）
 * @returns {{action:'appended'|'exists'|'no_summary'|'disabled', rowIndex?, row?}}
 */
async function syncOnSubmit(batchNo, deliveryNo = '') {
  if (!ledgerEnabled()) return { action: 'disabled' };
  const batch = await collectStore.findBatchByName(batchNo);
  if (!batch) throw new Error(`批次不存在：${batchNo}`);
  const f = batch.fields;
  const summary = String(f['摘要'] || '').trim();
  if (!summary) return { action: 'no_summary' }; // 老批次无摘要，不进台账（如实上报调用方）

  const { sheetId, rowCount } = await resolveSheet();
  const grid = await readGrid(sheetId);
  const existRow = findRowBySummary(grid, summary);
  if (existRow) {
    // 已有该批次行：投递单号留空且本次带了 → 补填，其余不动
    const existing = grid[existRow - 1] || [];
    if (deliveryNo && String(existing[1] ?? '').trim() === '') {
      await writeRange(sheetId, `B${existRow}:B${existRow}`, [[/^\d+$/.test(deliveryNo) ? Number(deliveryNo) : deliveryNo]]);
      return { action: 'appended', rowIndex: existRow, updated: 'deliveryNo' };
    }
    return { action: 'exists', rowIndex: existRow };
  }

  const next = lastNonEmptyRow(grid) + 1;
  if (next > rowCount) throw new Error(`台账表行数已满（${rowCount} 行），请人工插入行后重试`);
  const seq = next >= 3 ? Number(grid[next - 2]?.[0]) + 1 || next - 2 : next - 2; // 序号=上一行序号+1
  const payee = String(f['收款方'] || '').trim() || config.batch.reporterName;
  const payeeAccount = String(f['收款账号'] || '').trim() || config.batch.bankCardNo;
  const operator = String(f['接取人'] || '').trim() || config.batch.reporterName;
  const row = [
    seq,
    /^\d+$/.test(deliveryNo) ? Number(deliveryNo) : deliveryNo,
    summary,
    Number(f['金额合计']) || 0,
    config.batch.projectCode,
    '转卡',
    payee,
    payeeAccount,
    operator,
    fmtDate(Number(f['锁定时间']) || Date.now()),
    fmtDate(Date.now()),
    '',
    '已提交至中心',
  ];
  await writeRange(sheetId, `A${next}:M${next}`, [row]);
  return { action: 'appended', rowIndex: next, row };
}

/**
 * paid / reject 时同步台账：按摘要精确匹配回填指定列（找不到如实报 not_found，不动别人的行）。
 * @param {string} batchNo 批次号
 * @param {{paid?: boolean, rejected?: boolean}} mode
 */
async function syncOnStatus(batchNo, mode = {}) {
  if (!ledgerEnabled()) return { action: 'disabled' };
  const batch = await collectStore.findBatchByName(batchNo);
  if (!batch) throw new Error(`批次不存在：${batchNo}`);
  const summary = String(batch.fields['摘要'] || '').trim();
  if (!summary) return { action: 'no_summary' };

  const { sheetId } = await resolveSheet();
  const grid = await readGrid(sheetId);
  const row = findRowBySummary(grid, summary);
  if (!row) return { action: 'not_found' };

  if (mode.paid) {
    // L 入账日期 + M 状态
    await writeRange(sheetId, `L${row}:M${row}`, [[fmtDate(Date.now()), '已到账']]);
  } else if (mode.rejected) {
    await writeRange(sheetId, `M${row}:M${row}`, [['已退回']]);
  }
  return { action: 'updated', rowIndex: row };
}

module.exports = {
  ledgerEnabled,
  resolveSheet,
  readGrid,
  findRowBySummary,
  lastNonEmptyRow,
  syncOnSubmit,
  syncOnStatus,
};
