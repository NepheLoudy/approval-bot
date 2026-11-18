/**
 * 财务大对账（只读巡检）——五方数据源交叉核查。
 *
 * 数据源（全部只读，不写任何记录/单元格）：
 *   1. 审批多维表格（审批记录/催办三分支口径）
 *   2. 发票采集表（真源）
 *   3. 报销批次表（状态机）
 *   4. 《2027年千里团队报销台账》电子表格（13 列，数据自第 3 行）
 *   5. wiki「公用卡收支明细」数据表27（余额递推链）
 *
 * 复用 src/services 现有模块保证口径同源；wiki 读取复刻 cardFlowSyncService.readWikiTable
 * （含翻页与余额包装解包——该函数未导出，此处只读复刻，逻辑以源码为准）。
 *
 * 用法: node scripts/audit-reconcile.js   → 控制台摘要 + 完整报告落 .audit/audit-<ts>.md
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const client = require('../src/feishu/client');
const collectStore = require('../src/services/collectStore');
const approvalService = require('../src/services/approvalService');
const ledgerSheetService = require('../src/services/ledgerSheetService');
const cardFlowSyncService = require('../src/services/cardFlowSyncService');
const { fieldText } = require('../src/utils/fields');

const round2 = n => Math.round(n * 100) / 100;
const issues = [];
function add(level, code, msg) {
  issues.push({ level, code, msg });
  const tag = { P0: '🔴 P0', P1: '🟠 P1', P2: '🟡 P2', INFO: 'ℹ️ ' }[level] || level;
  console.log(`  ${tag} [${code}] ${msg}`);
}

function fmtMoney(n) { return `¥${round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtMs(ms) { return ms ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '(空)'; }

// ---------------- 数据源读取（逐源容错） ----------------
const sources = {};

async function loadAll() {
  const jobs = [
    ['approvals', async () => {
      const all = await approvalService.getAllApprovals();
      return { all, byApplyNo: buildApplyNoIndex(all) };
    }],
    ['collects', () => collectStore.listCollect()],
    ['batches', () => collectStore.listBatches()],
    ['ledger', async () => {
      const { sheetId, rowCount } = await ledgerSheetService.resolveSheet();
      const grid = await ledgerSheetService.readGrid(sheetId, rowCount);
      return { sheetId, rowCount, grid };
    }],
    ['wiki', () => readWikiTable()],
  ];
  for (const [name, fn] of jobs) {
    try {
      sources[name] = { ok: true, data: await fn() };
      console.log(`✓ 数据源 ${name} 读取成功`);
    } catch (err) {
      sources[name] = { ok: false, error: err.message };
      add('P0', `SRC-${name}`, `数据源读取失败: ${err.message}`);
    }
  }
}

/** 审批记录按申请编号索引（同款解析：富文本 {text} 优先） */
function buildApplyNoIndex(all) {
  const map = new Map();
  for (const rec of all) {
    const f = rec.fields || {};
    const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    if (no) {
      if (!map.has(no)) map.set(no, []);
      map.get(no).push(rec);
    }
  }
  return map;
}

/** 复刻 cardFlowSyncService.readWikiTable（含翻页/余额包装/链尾排序），只读 */
async function readWikiTable() {
  const r = await client.requestAPI('GET', '/wiki/v2/spaces/get_node?token=' + encodeURIComponent(config.cardFlow.nodeToken));
  if (r.code !== 0) throw new Error(`wiki 节点解析失败: ${r.msg} (code: ${r.code})`);
  const node = r.data && r.data.node;
  if (!node || node.obj_type !== 'bitable') throw new Error(`wiki 节点不是多维表格（${node ? node.obj_type : '不存在'}）`);
  const appToken = node.obj_token;

  const rows = [];
  let pageToken = '';
  do {
    const r2 = await client.requestAPI('POST', `/bitable/v1/apps/${appToken}/tables/${config.cardFlow.tableId}/records/search?page_token=${encodeURIComponent(pageToken)}`, {
      page_size: 500,
      sort: [{ field_name: '日期', desc: true }],
    });
    if (r2.code !== 0) throw new Error(`公用卡收支明细读取失败: ${r2.msg} (code: ${r2.code})`);
    for (const item of (r2.data && r2.data.items) || []) {
      const fields = (item && item.fields) || {};
      const rawMaterial = fields['购买物资名称'];
      const material = Array.isArray(rawMaterial) ? rawMaterial.map(x => (x && x.text) || '').join('') : String(rawMaterial ?? '');
      const rawBalance = fields['余额'];
      const balance = (rawBalance && typeof rawBalance === 'object' && Array.isArray(rawBalance.value))
        ? round2(Number(rawBalance.value[0]) || 0)
        : round2(Number(rawBalance) || 0);
      const balanceMissing = rawBalance === null || rawBalance === undefined
        || (typeof rawBalance === 'string' && rawBalance.trim() === '');
      rows.push({
        material,
        balance,
        balanceMissing,
        direction: String(fields['收/支'] ?? ''),
        amount: Number(fields['金额']) || 0,
        dateMs: Number(fields['日期']) || 0,
        source: String(fields['来源/去向'] ?? ''),
        recordId: item.record_id,
      });
    }
    pageToken = (r2.data && r2.has_more) ? (r2.data.page_token || '') : '';
  } while (pageToken);
  return { appToken, rows };
}

// ---------------- 检查项 ----------------

/** A. 审批表健康 + 催办三分支 + 金额线现状 */
function checkApprovals() {
  console.log('\n—— A. 审批表 ——');
  if (!sources.approvals.ok) return;
  const { all } = sources.approvals.data;
  const statusDist = {};
  let inactive = 0;
  for (const rec of all) {
    const f = rec.fields || {};
    statusDist[f['申请状态'] || '(空)'] = (statusDist[f['申请状态'] || '(空)'] || 0) + 1;
    if (!approvalService.isActiveProcess(f)) inactive++;
  }
  console.log(`  总记录 ${all.length}，状态分布 ${JSON.stringify(statusDist)}，非活跃流程 ${inactive} 条`);
  add('INFO', 'A1', `审批表 ${all.length} 条，分布 ${JSON.stringify(statusDist)}，非活跃 ${inactive}`);

  return (async () => {
    const fu = await approvalService.getFinanceFollowUp();
    console.log(`  催办三分支：未交发票 ${fu.missingInvoice.length} / 未制单 ${fu.missingForm.length} / 未转账 ${fu.missingTransfer.length}`);
    add('INFO', 'A2', `催办三分支：未交发票 ${fu.missingInvoice.length} / 未制单 ${fu.missingForm.length} / 未转账 ${fu.missingTransfer.length}`);

    // 金额线现状（复刻 formAlert 口径：按人名聚合「已开发票且未制单」金额，宣运物资独立线）
    const groups = new Map(); // key=人名/宣运物资 → {amount, records:[]}
    for (const rec of fu.missingForm) {
      const f = rec.fields || {};
      const isXy = approvalService.resolveProject(f) === '宣运物资';
      const key = isXy ? '宣运物资(组)' : (((Array.isArray(f['发起人']) && f['发起人'][0]?.name)) || '(无发起人)');
      const amt = Number(f['总金额']) || 0;
      if (!groups.has(key)) groups.set(key, { amount: 0, records: [] });
      const g = groups.get(key);
      g.amount = round2(g.amount + amt);
      g.records.push(`${f['申请编号']?.text || f['申请编号'] || '?'} ¥${round2(amt)}`);
    }
    const lines = [];
    for (const [key, g] of groups) {
      const isXy = key === '宣运物资(组)';
      const threshold = isXy ? config.formAlert.xuanYunAmount : config.formAlert.amount;
      const hit = g.amount >= threshold;
      lines.push(`${key} ${fmtMoney(g.amount)}/${fmtMoney(threshold)}${hit ? ' ←满线!' : ''} (${g.records.length}笔)`);
      if (hit && !isXy) add('P1', 'A3-金额线', `${key} 名下未制单 ${fmtMoney(g.amount)} 已满线 ${fmtMoney(threshold)} 但批次未锁定（等 10:35 兜底或冷却中?）——若持续多日需查 form_alert 状态文件`);
      if (hit && isXy) add('P1', 'A3-金额线', `宣运物资(组) 未制单 ${fmtMoney(g.amount)} 已满线 ${fmtMoney(threshold)} 但批次未锁定`);
    }
    if (lines.length) console.log(`  金额线现状：\n    · ${lines.join('\n    · ')}`);
    add('INFO', 'A3', `金额线：${lines.length ? lines.join('；') : '无人接近线'}`);

    // 是否打印=是 计数
    let printed = 0;
    for (const rec of all) if (fieldText((rec.fields || {})['是否打印']) === '是') printed++;
    add('INFO', 'A4', `是否打印=是：${printed} 条`);
    return fu;
  })();
}

/** B. 采集表健康 */
function checkCollects() {
  console.log('\n—— B. 发票采集表 ——');
  if (!sources.collects.ok) return;
  const collects = sources.collects.data;
  const pool = collects.filter(r => !r.fields['批次']);
  const poolAmount = round2(pool.reduce((s, r) => s + (Number(r.fields['价税合计']) || 0), 0));
  console.log(`  总票数 ${collects.length}，待归集 ${pool.length} 张 ${fmtMoney(poolAmount)}`);
  add('INFO', 'B1', `采集表 ${collects.length} 张票，待归集 ${pool.length} 张 ${fmtMoney(poolAmount)}`);

  // B2 发票号重复（一票多挂）
  const byNo = new Map();
  for (const r of collects) {
    const no = String(r.fields['发票号码'] || '').trim();
    if (!no) continue;
    if (!byNo.has(no)) byNo.set(no, []);
    byNo.get(no).push(r);
  }
  for (const [no, rows] of byNo) {
    if (rows.length > 1) add('P1', 'B2-发票号重复', `发票号 ${no} 挂了 ${rows.length} 条采集记录：${rows.map(r => r.record_id).join(', ')}`);
  }

  // B3 三元组重复
  const byTri = new Map();
  for (const r of collects) {
    const d = r.fields['开票日期'];
    const a = Number(r.fields['价税合计']) || 0;
    const t = String(r.fields['销售方税号'] || '').trim();
    if (!d || !a) continue;
    const key = `${d}|${a}|${t}`;
    if (!byTri.has(key)) byTri.set(key, []);
    byTri.get(key).push(r);
  }
  for (const [key, rows] of byTri) {
    if (rows.length > 1) {
      const nos = rows.map(r => String(r.fields['发票号码'] || '?')).join('/');
      add('P2', 'B3-三元组重复', `同日期+同金额+同税号 ${rows.length} 张（发票号: ${nos}）——不同票正常共用三元组的情形罕见，建议人工核一眼`);
    }
  }

  // B4 无主票（关联申请编号为空）
  const orphan = collects.filter(r => !String(r.fields['关联申请编号'] || '').trim());
  if (orphan.length) add('P2', 'B4-无主票', `${orphan.length} 张采集票无「关联申请编号」：${orphan.map(r => r.record_id).join(', ')}`);

  // B5 校验状态分布
  const checkDist = {};
  for (const r of collects) {
    const s = String(r.fields['校验状态'] || '(空)');
    checkDist[s] = (checkDist[s] || 0) + 1;
  }
  console.log(`  校验状态分布 ${JSON.stringify(checkDist)}`);
  add('INFO', 'B5', `校验状态分布 ${JSON.stringify(checkDist)}`);
}

/** C. 镜像一致性：采集票 → 审批表「发票/补交发票」 */
function checkMirror() {
  console.log('\n—— C. 采集→审批镜像 ——');
  if (!sources.approvals.ok || !sources.collects.ok) return;
  const { byApplyNo, all } = sources.approvals.data;
  const collects = sources.collects.data;

  let mirrorMissing = 0;
  let checked = 0;
  for (const r of collects) {
    const applyNo = String(r.fields['关联申请编号'] || '').trim();
    if (!applyNo) continue;
    checked++;
    const recs = byApplyNo.get(applyNo);
    if (!recs || !recs.length) {
      add('P1', 'C1-镜像断链', `采集票 ${r.record_id} 关联申请编号 ${applyNo} 在审批表不存在`);
      continue;
    }
    const f = recs[0].fields || {};
    const hasInv = approvalService.hasInvoiceSubmitted(f);
    if (!hasInv) {
      mirrorMissing++;
      add('P1', 'C2-镜像丢失', `申请 ${applyNo} 采集票已在库但审批表「发票/补交发票」两栏全空（镜像回写丢失）`);
    }
  }
  console.log(`  采集→审批镜像核对 ${checked} 张，镜像丢失 ${mirrorMissing}`);
  add('INFO', 'C', `镜像核对 ${checked} 张关联票，丢失 ${mirrorMissing}`);

  // C3 反向：审批已交票 vs 采集表（主通道=审批直附，采集只覆盖补充口径——只统计不判异常）
  const collectedNos = new Set(collects.map(r => String(r.fields['关联申请编号'] || '').trim()).filter(Boolean));
  let directOnly = 0, both = 0;
  for (const rec of all) {
    const f = rec.fields || {};
    if (!approvalService.isActiveProcess(f)) continue;
    const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    const has = approvalService.hasInvoiceSubmitted(f);
    if (has && collectedNos.has(no)) both++;
    else if (has) directOnly++;
  }
  add('INFO', 'C3', `审批已交票 ${both + directOnly} 条：采集通道覆盖 ${both}，仅审批直附 ${directOnly}（主通道口径正常）`);
}

/** D. 批次表健康 */
function checkBatches() {
  console.log('\n—— D. 报销批次表 ——');
  if (!sources.batches.ok || !sources.collects.ok) return;
  const batches = sources.batches.data;
  const collects = sources.collects.data;
  const byName = new Map();
  for (const b of batches) {
    const name = String(b.fields['批次号'] || '').trim();
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(b);
    }
  }
  for (const [name, rows] of byName) {
    if (rows.length > 1) add('P1', 'D2-批次号重复', `批次号 ${name} 有 ${rows.length} 条记录`);
  }

  const dist = {};
  let total = 0;
  const now = Date.now();
  const STALE = config.batch.staleDays * 24 * 3600 * 1000;
  for (const b of batches) {
    const st = String(b.fields['状态'] || '(空)');
    const amt = Number(b.fields['金额合计']) || 0;
    if (!dist[st]) dist[st] = { count: 0, amount: 0 };
    dist[st].count++;
    dist[st].amount = round2(dist[st].amount + amt);
    total = round2(total + amt);
    // 超期批次（已锁定/已提交 超 BATCH_STALE_DAYS 未到账）
    if ((st === '已锁定' || st === '已提交') && Number(b.fields['锁定时间']) > 0 && now - Number(b.fields['锁定时间']) > STALE) {
      const days = Math.floor((now - Number(b.fields['锁定时间'])) / 86400000);
      add('P2', 'D3-批次超期', `批次 ${b.fields['批次号']} 状态=${st} 已 ${days} 天未到账（超 ${config.batch.staleDays} 天线）`);
    }
  }
  console.log(`  批次 ${batches.length} 个，状态分布 ${JSON.stringify(dist)}`);
  add('INFO', 'D1', `批次 ${batches.length} 个 ${JSON.stringify(dist)}`);

  // D4 批次金额 vs 批次内票金额
  const byBatch = new Map();
  for (const r of collects) {
    const b = String(r.fields['批次'] || '').trim();
    if (!b) continue;
    if (!byBatch.has(b)) byBatch.set(b, []);
    byBatch.get(b).push(r);
  }
  for (const b of batches) {
    const name = String(b.fields['批次号'] || '').trim();
    if (!name) continue;
    const tickets = byBatch.get(name) || [];
    const sum = round2(tickets.reduce((s, r) => s + (Number(r.fields['价税合计']) || 0), 0));
    const declared = round2(Number(b.fields['金额合计']) || 0);
    if (Math.abs(sum - declared) > 0.01) {
      add('P1', 'D4-批次金额不符', `批次 ${name} 金额合计 ${fmtMoney(declared)} ≠ 批次内 ${tickets.length} 张票合计 ${fmtMoney(sum)}`);
    }
    if (declared > 0 && tickets.length === 0) {
      add('P2', 'D4-空批次', `批次 ${name} 金额 ${fmtMoney(declared)} 但采集表无归属票（票被删/批次字段写错?）`);
    }
  }
}

/** E. 台账 vs 批次（摘要精确匹配口径，与 ledgerSheetService 同源） */
function checkLedger() {
  console.log('\n—— E. 台账 ↔ 批次 ——');
  if (!sources.ledger.ok || !sources.batches.ok) return;
  const { grid, rowCount } = sources.ledger.data;
  const batches = sources.batches.data;

  // 台账数据行（第 3 行起）
  const ledgerRows = [];
  for (let i = 2; i < grid.length; i++) {
    const row = grid[i] || [];
    const summary = String(row[2] ?? '').trim();
    if (!summary) continue;
    ledgerRows.push({
      row: i + 1,
      seq: row[0],
      deliveryNo: row[1],
      summary,
      amount: Number(row[3]) || 0,
      operator: row[8],
      applyDate: row[9],
      deliverDate: row[10],
      entryDate: row[11],
      status: String(row[12] ?? '').trim(),
    });
  }
  console.log(`  台账数据行 ${ledgerRows.length}（rowCount=${rowCount}）`);
  add('INFO', 'E0', `台账 ${ledgerRows.length} 行数据（sheet 行数上限 ${rowCount}，追加空间 ${rowCount - ledgerSheetService.lastNonEmptyRow(grid)} 行）`);

  // 批次摘要 → 批次
  const bySummary = new Map();
  for (const b of batches) {
    const s = String(b.fields['摘要'] || '').trim();
    if (s) {
      if (!bySummary.has(s)) bySummary.set(s, []);
      bySummary.get(s).push(b);
    }
  }

  // E1/E2 批次 → 台账
  let noSummaryBatches = 0;
  for (const b of batches) {
    const summary = String(b.fields['摘要'] || '').trim();
    const status = String(b.fields['状态'] || '已锁定');
    if (!summary) { noSummaryBatches++; continue; }
    const hits = ledgerSheetService.findRowsBySummary(grid, summary);
    if (hits.length > 1) {
      add('P1', 'E1-摘要多行', `批次 ${b.fields['批次号']} 摘要在台账命中 ${hits.length} 行（${hits.join(',')}）——ambiguous，人工裁决`);
      continue;
    }
    const row = hits[0] ? ledgerRows[hits[0] - 1 - 0] || ledgerRows.find(r => r.row === hits[0]) : null;
    const hit = hits[0] ? ledgerRows.find(r => r.row === hits[0]) : null;

    if (status === '已到账' || status === '已退回' || status === '已提交') {
      if (!hit) {
        add('P1', 'E1-台账缺行', `批次 ${b.fields['批次号']}（${status}，${fmtMoney(Number(b.fields['金额合计']) || 0)}）台账无对应行——syncOnSubmit/ledger 补同步未做或失败`);
        continue;
      }
      // E2 状态一致性
      const expect = { '已到账': '已到账', '已退回': '已退回', '已提交': '已提交至中心' }[status];
      if (hit.status !== expect) {
        // 台账状态比批次进度更超前=财务手填在先（可接受但要提示）；滞后=机器人回填缺失
        add('P2', 'E2-状态不一致', `批次 ${b.fields['批次号']} 状态=${status}，台账第 ${hit.row} 行状态=「${hit.status || '(空)'}」（预期「${expect}」）`);
      }
      if (status === '已到账' && !String(hit.entryDate ?? '').trim()) {
        add('P2', 'E2-入账日期空', `批次 ${b.fields['批次号']} 已到账但台账第 ${hit.row} 行入账日期为空（会阻塞公用卡同步）`);
      }
    } else if (status === '已锁定') {
      // v92 printed 预登记：打过打印标记的锁定批次应有预登记行
      const printedAt = b.fields['打印确认时间'];
      const hasPrintedMark = printedAt && (typeof printedAt === 'number' ? printedAt > 0 : String(printedAt).trim() !== '');
      if (hasPrintedMark && !hit) {
        add('P2', 'E1-预登记缺行', `批次 ${b.fields['批次号']} 已打印（v92 打印回执即记账）但台账无预登记行——printed 记账失败?`);
      }
    }
  }
  if (noSummaryBatches) add('INFO', 'E1', `${noSummaryBatches} 个批次无摘要（老批次，不进台账属正常）`);

  // E3 台账孤儿行：摘要以机器人前缀开头但无对应批次
  const prefix = config.batch.summaryPrefix;
  let orphan = 0;
  for (const lr of ledgerRows) {
    if (bySummary.has(lr.summary)) continue;
    const isBotStyle = prefix && lr.summary.startsWith(prefix);
    if (isBotStyle) {
      add('P2', 'E3-孤儿行', `台账第 ${lr.row} 行摘要「${lr.summary}」是机器人格式但批次表无对应批次（批次被删?笔序撞号?）`);
      orphan++;
    }
  }

  // E4 台账自身状态异常：L 已填 M 空 / L 空 M=已到账
  for (const lr of ledgerRows) {
    const hasEntry = String(lr.entryDate ?? '').trim() !== '';
    if (hasEntry && !lr.status) add('P2', 'E4-入账未标状态', `台账第 ${lr.row} 行「${lr.summary}」入账日期已填但状态为空`);
    if (!hasEntry && lr.status === '已到账') add('P2', 'E4-状态倒挂', `台账第 ${lr.row} 行「${lr.summary}」状态=已到账但入账日期为空`);
  }

  // E5 机器人写入行的完整性：摘要命中批次但经办人/金额对不上
  for (const lr of ledgerRows) {
    const b = bySummary.get(lr.summary);
    if (!b || !b.length) continue;
    const rec = b[0];
    const declared = round2(Number(rec.fields['金额合计']) || 0);
    if (Math.abs(declared - lr.amount) > 0.01) {
      add('P2', 'E5-台账金额不符', `台账第 ${lr.row} 行金额 ${fmtMoney(lr.amount)} ≠ 批次 ${rec.fields['批次号']} 金额合计 ${fmtMoney(declared)}`);
    }
  }
}

/** F. 公用卡收支明细 ↔ 台账 */
function checkCardFlow() {
  console.log('\n—— F. 公用卡收支明细 ↔ 台账 ——');
  if (!sources.wiki.ok || !sources.ledger.ok) return;
  const { rows: wikiRows } = sources.wiki.data;
  const { grid } = sources.ledger.data;

  // 台账入账行（复用 cardFlowSyncService.readLedgerRows 口径）
  const ledgerRows = [];
  for (let i = 2; i < grid.length; i++) {
    const row = grid[i] || [];
    const summary = String(row[2] ?? '').trim();
    if (!summary) continue;
    ledgerRows.push({
      row: i + 1,
      summary,
      amount: Number(row[3]) || 0,
      entryDateMs: cardFlowSyncService.parseLedgerDateMs(row[11]),
    });
  }
  const entryRows = ledgerRows.filter(r => r.entryDateMs > 0);

  // wiki 已有摘要集合
  const wikiByMaterial = new Map();
  for (const w of wikiRows) {
    if (!w.material) continue;
    if (!wikiByMaterial.has(w.material)) wikiByMaterial.set(w.material, []);
    wikiByMaterial.get(w.material).push(w);
  }

  // F1 应同步未同步（基线豁免：v94 首航 2026-11-07 前的入账行不回灌历史）
  const BASELINE = new Date('2026-11-07T00:00:00+08:00').getTime();
  let missing = 0;
  for (const lr of entryRows) {
    const hits = wikiByMaterial.get(lr.summary);
    if (hits && hits.length) {
      // F2 金额一致性
      if (hits.length > 1) add('P2', 'F2-同名多行', `wiki 有 ${hits.length} 行同名「${lr.summary}」（人工复制?）`);
      const w = hits[0];
      if (Math.abs(round2(w.amount) - round2(lr.amount)) > 0.01) {
        add('P1', 'F2-金额错账', `wiki「${lr.summary}」金额 ${fmtMoney(w.amount)} ≠ 台账 ${fmtMoney(lr.amount)}`);
      }
      // 日期一致性
      if (w.dateMs > 0 && Math.abs(w.dateMs - lr.entryDateMs) > 12 * 3600 * 1000) {
        add('P2', 'F2-日期不一致', `wiki「${lr.summary}」日期 ${fmtMs(w.dateMs)} ≠ 台账入账 ${fmtMs(lr.entryDateMs)}`);
      }
    } else {
      missing++;
      if (lr.entryDateMs >= BASELINE) {
        add('P1', 'F1-应同步未同步', `台账第 ${lr.row} 行「${lr.summary}」入账 ${fmtMs(lr.entryDateMs)}（基线后）但 wiki 无对应行——card_flow 同步链断/状态文件异常`);
      } else {
        add('INFO', 'F1-基线豁免', `台账第 ${lr.row} 行「${lr.summary}」入账 ${fmtMs(lr.entryDateMs)}，基线前历史行不回灌（wiki 或以聚合「报销款」行记账）`);
      }
    }
  }
  console.log(`  台账入账行 ${entryRows.length}，wiki 覆盖 ${entryRows.length - missing}，缺失 ${missing}`);
  add('INFO', 'F1', `台账入账行 ${entryRows.length}，wiki 覆盖 ${entryRows.length - missing}，缺失 ${missing}（基线前豁免不计异常）`);

  // F3 余额递推链验证（按日期块：同日多行顺序不定，验块首块尾）
  const dated = wikiRows.filter(w => w.dateMs > 0).sort((a, b) => a.dateMs - b.dateMs);
  const blocks = [];
  for (const w of dated) {
    const dayKey = new Date(w.dateMs).toISOString().slice(0, 10);
    const last = blocks[blocks.length - 1];
    if (last && last.dayKey === dayKey) last.rows.push(w);
    else blocks.push({ dayKey, rows: [w] });
  }
  let chainOk = 0, chainBroken = 0;
  let prevTailBalance = null;
  const dirUnknown = new Set();
  for (const blk of blocks) {
    const signed = blk.rows.reduce((s, w) => {
      const dir = w.direction;
      if (dir === '收入') return s + w.amount;
      if (dir === '支出') return s - w.amount;
      dirUnknown.add(dir || '(空)');
      return s + w.amount; // 未知方向按 + 处理并标记
    }, 0);
    const first = blk.rows[0];
    const last = blk.rows[blk.rows.length - 1];
    if (prevTailBalance === null) {
      // 首块：验块内自洽 余额尾 = 上一笔余额 + 净额（块内上一笔余额应一致）
      const prevs = blk.rows.map(w => w.balance - signedAmount(w)).map(x => round2(x));
      // 简化：验最后一行 余额 == 上一笔余额 + signed
      const lastRow = blk.rows[blk.rows.length - 1];
      const prev = lastRow.balance - signedAmount(lastRow);
      // 不比了，首块只记录
      prevTailBalance = round2(last.balance);
      chainOk++;
      continue;
    }
    const delta = round2(last.balance - prevTailBalance);
    if (Math.abs(delta - signed) > 0.01) {
      chainBroken++;
      add('P2', 'F3-余额断链', `${blk.dayKey} 日块余额跳变 ${fmtMoney(prevTailBalance)} → ${fmtMoney(last.balance)}（Δ${fmtMoney(delta)}），当日净额应为 ${fmtMoney(signed)}——人工行日期错序/漏行/方向字段异常`);
    } else {
      chainOk++;
    }
    prevTailBalance = round2(last.balance);
  }
  console.log(`  余额链：${chainOk} 个日块连续，${chainBroken} 处断链`);
  add('INFO', 'F3', `wiki 余额链 ${chainOk} 个日块连续 / ${chainBroken} 断链（同日多行按块验）`);
  if (dirUnknown.size) add('INFO', 'F3', `「收/支」出现非收入/支出的值: ${[...dirUnknown].join('、')}（已按收入处理）`);

  // F4 余额缺失行（人工残行）
  const noBalance = wikiRows.filter(w => w.balanceMissing);
  if (noBalance.length) add('P2', 'F4-余额残行', `${noBalance.length} 行无余额（人工残行，不作为链尾依据）：${noBalance.slice(0, 5).map(w => w.material || w.recordId).join(' / ')}`);

  // F5 wiki 支出行方向统计
  const income = wikiRows.filter(w => w.direction === '收入');
  const expense = wikiRows.filter(w => w.direction === '支出');
  const incSum = round2(income.reduce((s, w) => s + w.amount, 0));
  const expSum = round2(expense.reduce((s, w) => s + w.amount, 0));
  add('INFO', 'F5', `wiki 全表：收入 ${income.length} 行 ${fmtMoney(incSum)}，支出 ${expense.length} 行 ${fmtMoney(expSum)}，净 ${fmtMoney(incSum - expSum)}`);
}

// signedAmount：按方向给出行对余额的影响（块内自洽检查用）
function signedAmount(w) {
  if (w.direction === '支出') return -w.amount;
  return w.amount;
}

/** G. 金额管道总览 */
function checkMoneyPipe() {
  console.log('\n—— G. 金额管道 ——');
  if (!sources.approvals.ok || !sources.collects.ok || !sources.batches.ok || !sources.ledger.ok) return;
  const { all } = sources.approvals.data;
  const collects = sources.collects.data;
  const batches = sources.batches.data;
  const { grid } = sources.ledger.data;

  // 审批：已通过+活跃+已交票 的总金额
  const collectedNos = new Set(collects.map(r => String(r.fields['关联申请编号'] || '').trim()).filter(Boolean));
  let approvedSubmittedAmt = 0, approvedSubmittedCnt = 0;
  for (const rec of all) {
    const f = rec.fields || {};
    if (f['申请状态'] !== '已通过' || !approvalService.isActiveProcess(f)) continue;
    const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    if (!(approvalService.hasInvoiceSubmitted(f) || collectedNos.has(no))) continue;
    approvedSubmittedAmt = round2(approvedSubmittedAmt + (Number(f['总金额']) || 0));
    approvedSubmittedCnt++;
  }

  const collectAmt = round2(collects.reduce((s, r) => s + (Number(r.fields['价税合计']) || 0), 0));
  const poolAmt = round2(collects.filter(r => !r.fields['批次']).reduce((s, r) => s + (Number(r.fields['价税合计']) || 0), 0));
  const batchAmt = round2(batches.reduce((s, b) => s + (Number(b.fields['金额合计']) || 0), 0));
  const batchPaid = round2(batches.filter(b => String(b.fields['状态']) === '已到账').reduce((s, b) => s + (Number(b.fields['金额合计']) || 0), 0));
  const batchSubmitted = round2(batches.filter(b => ['已提交', '已到账'].includes(String(b.fields['状态']))).reduce((s, b) => s + (Number(b.fields['金额合计']) || 0), 0));

  let ledgerAmt = 0, ledgerPaid = 0;
  for (let i = 2; i < grid.length; i++) {
    const row = grid[i] || [];
    const amt = Number(row[3]) || 0;
    if (!String(row[2] ?? '').trim() && !amt) continue;
    ledgerAmt = round2(ledgerAmt + amt);
    if (String(row[12] ?? '').trim() === '已到账') ledgerPaid = round2(ledgerPaid + amt);
  }

  const lines = [
    `审批[已通过+已交票] ${approvedSubmittedCnt} 条 ${fmtMoney(approvedSubmittedAmt)}`,
    `采集表全部票 ${collectAmt}（待归集 ${poolAmt}）`,
    `批次表合计 ${batchAmt}（已提交+ ${batchSubmitted}，已到账 ${batchPaid}）`,
    `台账 D 合计 ${ledgerAmt}（状态已到账 ${ledgerPaid}）`,
  ];
  console.log('  ' + lines.join('\n  '));
  add('INFO', 'G1', `金额管道：${lines.join(' | ')}`);

  // 交叉核验
  if (Math.abs(batchAmt - collectInBatches(collects)) > 0.01) { /* D4 已细查，此处不重复 */ }
  if (batchPaid > 0 && Math.abs(batchPaid - ledgerPaid) > 0.01) {
    add('P2', 'G2-管道差', `批次「已到账」合计 ${fmtMoney(batchPaid)} vs 台账「已到账」合计 ${fmtMoney(ledgerPaid)}（差异来自财务手填历史行/无摘要批次，属口径差异，人工复核）`);
  }
}

function collectInBatches(collects) {
  return round2(collects.filter(r => r.fields['批次']).reduce((s, r) => s + (Number(r.fields['价税合计']) || 0), 0));
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('=== approval-bot 财务大对账（只读） ===');
  console.log(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  await loadAll();

  const fuPromise = checkApprovals();
  checkCollects();
  checkMirror();
  checkBatches();
  checkLedger();
  checkCardFlow();
  checkMoneyPipe();
  await fuPromise;

  // 报告落盘
  const outDir = path.join(__dirname, '..', '.audit');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `audit-${ts}.md`);
  fs.writeFileSync(outFile, renderReport(), 'utf8');
  console.log(`\n报告已落盘: ${outFile}`);

  const cnt = { P0: 0, P1: 0, P2: 0, INFO: 0 };
  for (const i of issues) cnt[i.level]++;
  console.log(`\n=== 结果: P0=${cnt.P0} P1=${cnt.P1} P2=${cnt.P2}（INFO ${cnt.INFO}） ===`);
}

function renderReport() {
  const L = [];
  L.push(`# approval-bot 财务大对账报告`);
  L.push('');
  L.push(`- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  L.push(`- 方式：只读巡检（scripts/audit-reconcile.js），复用 src/services 生产口径`);
  L.push(`- 数据源：审批表 / 发票采集表 / 报销批次表 / 报销台账 / wiki 公用卡收支明细`);
  L.push('');
  L.push(`## 异常清单`);
  const order = { P0: 0, P1: 1, P2: 2, INFO: 3 };
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  const p0 = sorted.filter(i => i.level === 'P0');
  const p1 = sorted.filter(i => i.level === 'P1');
  const p2 = sorted.filter(i => i.level === 'P2');
  const info = sorted.filter(i => i.level === 'INFO');
  const emit = (list) => list.length
    ? list.map(i => `- [${i.level}] [${i.code}] ${i.msg}`).join('\n')
    : '-（无）';
  L.push(`### 🔴 P0（数据不可用/读取失败）\n${emit(p0)}`);
  L.push(`\n### 🟠 P1（错账风险/链路断）\n${emit(p1)}`);
  L.push(`\n### 🟡 P2（不一致/需人工复核）\n${emit(p2)}`);
  L.push(`\n### ℹ️ INFO（口径快照）\n${emit(info)}`);

  L.push(`\n## 说明`);
  L.push(`- 台账行匹配口径=摘要精确等值（ledgerSheetService 同源）；`);
  L.push(`- 公用卡基线：v94（2026-11-07）首航前入账的历史行不回灌 wiki，缺失属预期；`);
  L.push(`- P2 的余额断链多为人工行日期错序，需财务侧核对；`);
  L.push(`- 本脚本无任何写操作，可随时重跑。`);
  return L.join('\n');
}

main().catch(err => {
  console.error('对账主流程失败:', err);
  process.exit(1);
});
