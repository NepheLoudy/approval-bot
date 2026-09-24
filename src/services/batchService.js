/**
 * 报销批次服务：财务三件套自动化（对接口径：重庆大学智能财务系统 + 小翼Plus，人工扫码录入）。
 *
 * 三件套映射：
 *   ① 选批+扫码 → 自动拟批（票池按项目聚合）+ 批次锁定（回写采集表「批次」、审批表「报销单」栏），
 *      附逐张查验要素清单（财务照单依次扫小翼Plus）；
 *   ② 打印文件 → 全自动：按录入顺序（=采集时间序）生成 A4 竖版一页两票 PDF，落批次表附件；
 *   ③ BOM 表 → 全自动：批次内审批记录（物资/型号/金额/发起人）生成 xlsx，落批次表附件。
 *
 * 状态机（曼波拍板）：拟批 → 已锁定 → 已提交 → 已到账 / 已退回。
 * 锁定后顺序不可变（打印件顺序=录入顺序=扫码顺序）；迟到票只能进下一批。
 */
const { PDFDocument } = require('pdf-lib');
const ExcelJS = require('exceljs');
const config = require('../config');
const client = require('../feishu/client');
const bitableApi = require('../feishu/bitable');
const collectStore = require('./collectStore');

const A4 = { width: 595.28, height: 841.89 };
const SLOT = { width: A4.width - 40, height: (A4.height - 60) / 2 }; // 半页票位（上下两票，边距 20/30）

// 按批次号互斥（lock 与 regen 并发防护——复查 P1-6）
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// ---------- 票池与拟批 ----------

/** 票池：已采集未归批，关联审批记录（物资/项目/型号），按采集时间升序（录入序） */
async function getPoolWithRecords() {
  const collects = await collectStore.listCollect();
  const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
  const byApplyNo = new Map();
  for (const r of approvals) {
    const f = r.fields || {};
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    if (applyNo) byApplyNo.set(applyNo, f);
  }

  return collects
    .filter(r => !r.fields['批次'])
    .map((r) => {
      const f = r.fields;
      const applyNo = String(f['关联申请编号'] || '');
      const af = byApplyNo.get(applyNo) || {};
      return {
        record_id: r.record_id,
        invoiceNo: String(f['发票号码'] || ''),
        totalAmount: typeof f['价税合计'] === 'number' ? f['价税合计'] : (parseFloat(f['价税合计']) || 0),
        collectedAt: Number(f['采集时间']) || 0,
        applyNo,
        material: af['购买物资名称'] || '',
        model: af['型号规格参数'] || '',
        project: af['项目'] ? (af['项目'].name || String(af['项目'])) : '未归类',
        applicant: Array.isArray(af['发起人']) ? af['发起人'].map(u => u.name).join(',') : '',
        fileTokens: Array.isArray(f['发票图片']) ? f['发票图片'].map(a => a.file_token).filter(Boolean) : [],
        verifyStatus: f['校验状态'] || '',
      };
    })
    .sort((a, b) => a.collectedAt - b.collectedAt);
}

/** 拟批建议：票池按项目分组（张数多的在前） */
async function previewBatch() {
  const pool = await getPoolWithRecords();
  const groups = new Map();
  for (const p of pool) {
    if (!groups.has(p.project)) groups.set(p.project, []);
    groups.get(p.project).push(p);
  }
  const suggestions = [...groups.entries()]
    .map(([project, items]) => ({
      project,
      count: items.length,
      amount: Math.round(items.reduce((s, i) => s + i.totalAmount, 0) * 100) / 100,
      range: items.length ? `尾号 ${items[0].invoiceNo.slice(-6)}~${items[items.length - 1].invoiceNo.slice(-6)}` : '',
      warningCount: items.filter(i => i.verifyStatus && i.verifyStatus !== '通过').length,
    }))
    .sort((a, b) => b.count - a.count);
  return { poolSize: pool.length, suggestions };
}

// ---------- 批次锁定 ----------

/**
 * 锁定批次：pool 内票（可选按项目过滤）→ 回写采集表「批次」+ 审批表「报销单」栏 →
 * 建批次记录（已锁定）→ 生成打印 PDF + BOM xlsx 落附件。
 * 锁定后顺序不可变；迟到票进下一批。
 */
async function lockBatch(batchNo, project, options = {}) {
  if (!batchNo || !batchNo.trim()) throw new Error('批次号不能为空（如 27备赛20步兵5）');
  batchNo = batchNo.trim();

  // 全程按批次号加锁（防并发双锁同一池票——复查 P1-6）；锁内二次查重
  return withLock(`batch_${batchNo}`, async () => {
    const existing = await collectStore.findBatchByName(batchNo);
    if (existing) throw new Error(`批次号已存在：${batchNo}（报销批次表）`);

    let pool = await getPoolWithRecords();
    if (project) pool = pool.filter(p => p.project === project);
    if (!pool.length) throw new Error('票池中没有可锁定的发票（已全部归批或项目无票）');

    const amount = Math.round(pool.reduce((s, p) => s + p.totalAmount, 0) * 100) / 100;
    const projects = [...new Set(pool.map(p => p.project))];

    // 1. 先建批次记录（已锁定）——锁定主记录先行，后续步骤失败可经 regen/status 自愈，
    //    不会出现「票已出池、批次表无记录」的死局（复查 P1-5）
    const batchRecord = await collectStore.createBatch({
      '批次号': batchNo,
      '项目': projects.join('/'),
      '张数': pool.length,
      '金额合计': amount,
      '状态': collectStore.BATCH_STATUS.LOCKED,
      '锁定时间': Date.now(),
      ...(options.note ? { '备注': options.note } : {}),
    });

    // 2. 采集表回写批次
    for (const p of pool) {
      await collectStore.updateCollect(p.record_id, { '批次': batchNo });
    }

    // 3. 审批表「报销单」栏回写（单选，值不存在飞书自动建选项；有申请编号的才回写）
    let approvalWritten = 0;
    if (pool.some(p => p.applyNo)) {
      const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
      const byApplyNo = new Map();
      for (const r of approvals) {
        const f = r.fields || {};
        const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
        if (no) byApplyNo.set(no, r);
      }
      for (const p of pool) {
        if (!p.applyNo) continue;
        const hit = byApplyNo.get(p.applyNo);
        if (!hit) continue;
        try {
          await bitableApi.updateRecord(config.bitable.approvalTableId, hit.record_id, { '报销单': batchNo });
          approvalWritten++;
        } catch (err) {
          console.error(`[批次] 回写审批表报销单栏失败（${p.applyNo}）:`, err.message);
        }
      }
    }

    // 4. 生成打印 PDF + BOM（失败不阻断锁定，可 /approval-batch regen 重生成——复查 P2-5）
    let pdfToken = null, bomToken = null;
    try { pdfToken = await uploadBatchPdf(batchNo, pool); } catch (err) { console.error('[批次] 打印 PDF 生成失败:', err.message); }
    try { bomToken = await uploadBatchBom(batchNo, pool); } catch (err) { console.error('[批次] BOM 生成失败:', err.message); }
    const attach = {};
    if (pdfToken) attach['打印文件'] = [{ file_token: pdfToken }];
    if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
    if (Object.keys(attach).length) await collectStore.updateBatch(batchRecord.record_id, attach);

    return { batchNo, count: pool.length, amount, projects, approvalWritten, pdfToken, bomToken, recordId: batchRecord.record_id, items: pool };
  });
}

// ---------- 批次附件重生成（/approval-batch regen） ----------

/** 重新生成指定批次的打印 PDF + BOM（生成失败后的自愈入口，复查 P2-5） */
async function regenerateBatchFiles(batchNo) {
  const batch = await collectStore.findBatchByName(batchNo);
  if (!batch) throw new Error(`批次不存在：${batchNo}`);
  const collects = (await collectStore.listCollect()).filter(r => String(r.fields['批次'] || '') === batchNo);
  if (!collects.length) throw new Error(`批次 ${batchNo} 下没有采集记录`);

  const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
  const byApplyNo = new Map();
  for (const r of approvals) {
    const f = r.fields || {};
    const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    if (no) byApplyNo.set(no, f);
  }
  const items = collects.map((r) => {
    const f = r.fields;
    const af = byApplyNo.get(String(f['关联申请编号'] || '')) || {};
    return {
      record_id: r.record_id,
      invoiceNo: String(f['发票号码'] || ''),
      totalAmount: typeof f['价税合计'] === 'number' ? f['价税合计'] : (parseFloat(f['价税合计']) || 0),
      applyNo: String(f['关联申请编号'] || ''),
      material: af['购买物资名称'] || '',
      model: af['型号规格参数'] || '',
      project: af['项目'] ? (af['项目'].name || String(af['项目'])) : '未归类',
      applicant: Array.isArray(af['发起人']) ? af['发起人'].map(u => u.name).join(',') : '',
      fileTokens: Array.isArray(f['发票图片']) ? f['发票图片'].map(a => a.file_token).filter(Boolean) : [],
      verifyStatus: f['校验状态'] || '',
    };
  }).sort((a, b) => a.collectedAt - b.collectedAt || 0);

  let pdfToken = null, bomToken = null;
  try { pdfToken = await uploadBatchPdf(batchNo, items); } catch (err) { console.error('[批次] 打印 PDF 重生成失败:', err.message); }
  try { bomToken = await uploadBatchBom(batchNo, items); } catch (err) { console.error('[批次] BOM 重生成失败:', err.message); }
  const attach = {};
  if (pdfToken) attach['打印文件'] = [{ file_token: pdfToken }];
  if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
  if (Object.keys(attach).length) await collectStore.updateBatch(batch.record_id, attach);
  return { batchNo, count: items.length, pdfToken, bomToken };
}

// ---------- 财务三件套②：打印 PDF（录入序，一页两票，A4 竖版） ----------

async function downloadMediaSafe(fileToken) {
  try {
    return await client.downloadMedia(fileToken);
  } catch (err) {
    console.warn(`[批次] 附件下载失败（${String(fileToken).slice(0, 12)}…）: ${err.message}`);
    return null;
  }
}

async function uploadBatchPdf(batchNo, items) {
  const out = await PDFDocument.create();
  let index = 0;
  for (const item of items) {
    if (!item.fileTokens.length) {
      addPlaceholderPage(out, index, item, '票面原件缺失（采集时未成功转存），请财务手工补复印');
      index++;
      continue;
    }
    for (const token of item.fileTokens) {
      const buf = await downloadMediaSafe(token);
      if (!buf) {
        addPlaceholderPage(out, index, item, '票面原件下载失败，请财务手工补');
        index++;
        continue;
      }
      index = await addInvoiceToPdf(out, buf, index, item);
    }
  }
  if (index === 0) throw new Error('批次内没有任何可排版的票面');

  const bytes = await out.save();
  const uploaded = await client.uploadMediaToBitable(Buffer.from(bytes), `报销单_${batchNo}_打印件.pdf`);
  return uploaded;
}

/** 票位底部 y：index 偶=上半页（顶 841.89-30），奇=下半页（顶=上半页底）；内容顶对齐缩放后贴顶 */
function slotBottomY(isTop, contentHeight) {
  const slotTop = isTop ? A4.height - 30 : A4.height - 30 - SLOT.height;
  return slotTop - contentHeight;
}

/** 半页票位排版：两票一页；PDF 原件每页占一个票位（缩放适配） */
async function addInvoiceToPdf(out, buf, index, item) {
  const isPdf = buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF';

  if (isPdf) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      if (index % 2 === 0) out.addPage([A4.width, A4.height]);
      const target = out.getPage(out.getPageCount() - 1);
      const scale = Math.min(SLOT.width / p.getWidth(), SLOT.height / p.getHeight());
      const w = p.getWidth() * scale, h = p.getHeight() * scale;
      target.drawPage(p, { x: (A4.width - w) / 2, y: slotBottomY(index % 2 === 0, h), width: w, height: h });
      index++;
    }
    return index;
  }

  // 图片（jpg/png）
  let img;
  try {
    img = isPng(buf) ? await out.embedPng(buf) : await out.embedJpg(buf);
  } catch (err) {
    addPlaceholderPage(out, index, item, `票面图片解码失败（${err.message.slice(0, 40)}），请财务手工补`);
    return index + 1;
  }
  if (index % 2 === 0) out.addPage([A4.width, A4.height]);
  const target = out.getPage(out.getPageCount() - 1);
  const scale = Math.min(SLOT.width / img.width, SLOT.height / img.height);
  const w = img.width * scale, h = img.height * scale;
  target.drawImage(img, { x: (A4.width - w) / 2, y: slotBottomY(index % 2 === 0, h), width: w, height: h });
  return index + 1;
}

function isPng(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function addPlaceholderPage(out, index, item, reason) {
  // 占位页：整页说明（不参与两票拼版，避免打印件顺序歧义）。
  // 注意 pdf-lib 内置字体仅 WinAnsi，只能 ASCII（中文说明见批次表 BOM/备注）
  const page = out.addPage([A4.width, A4.height]);
  page.drawText(`Slot ${index + 1} | ${item.applyNo || 'N/A'} | no.${item.invoiceNo.slice(-6)} | CNY ${item.totalAmount.toFixed(2)}`, {
    x: 50, y: A4.height - 120, size: 16,
  });
  page.drawText(`MISSING ORIGINAL - ${String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}`, { x: 50, y: A4.height - 160, size: 12 });
}

// ---------- 财务三件套③：BOM xlsx ----------

async function uploadBatchBom(batchNo, items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`BOM-${batchNo}`);
  ws.columns = [
    { header: '序号', key: 'idx', width: 6 },
    { header: '申请编号', key: 'applyNo', width: 16 },
    { header: '项目', key: 'project', width: 14 },
    { header: '物资名称', key: 'material', width: 28 },
    { header: '型号规格参数', key: 'model', width: 32 },
    { header: '发起人', key: 'applicant', width: 10 },
    { header: '申请金额', key: 'applyAmount', width: 12 },
    { header: '发票号码', key: 'invoiceNo', width: 24 },
    { header: '发票金额(价税合计)', key: 'invoiceAmount', width: 18 },
    { header: '校验状态', key: 'verifyStatus', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  items.forEach((item, i) => {
    ws.addRow({
      idx: i + 1,
      applyNo: item.applyNo || '',
      project: item.project,
      material: item.material,
      model: typeof item.model === 'string' ? item.model : JSON.stringify(item.model),
      applicant: item.applicant,
      applyAmount: '',
      invoiceNo: item.invoiceNo,
      invoiceAmount: item.totalAmount,
      verifyStatus: item.verifyStatus || '通过',
    });
  });
  const total = items.reduce((s, i) => s + i.totalAmount, 0);
  const totalRow = ws.addRow({ material: '合计', invoiceAmount: Math.round(total * 100) / 100 });
  totalRow.font = { bold: true };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return client.uploadMediaToBitable(buffer, `报销单_${batchNo}_BOM.xlsx`);
}

// ---------- 批次状态流转（已提交/已到账/已退回） ----------

async function markBatch(batchNo, status) {
  const batch = await collectStore.findBatchByName(batchNo);
  if (!batch) throw new Error(`批次不存在：${batchNo}`);
  const now = Date.now();
  const fields = { '状态': status };
  if (status === collectStore.BATCH_STATUS.SUBMITTED) fields['提交时间'] = now;
  if (status === collectStore.BATCH_STATUS.PAID) fields['到账时间'] = now;
  await collectStore.updateBatch(batch.record_id, fields);

  // 已退回 → 该批次票清空「批次」标记自动回票池（与 /approval-batch 帮助文案一致——复查 P2-4）
  let returnedToPool = 0;
  if (status === collectStore.BATCH_STATUS.REJECTED) {
    const collects = (await collectStore.listCollect()).filter(r => String(r.fields['批次'] || '') === batchNo);
    for (const r of collects) {
      await collectStore.updateCollect(r.record_id, { '批次': '' });
      returnedToPool++;
    }
  }

  const f = batch.fields;
  return {
    batchNo,
    status,
    count: f['张数'],
    amount: typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(f['金额合计']) || 0),
    returnedToPool,
  };
}

/** 批次总览（/approval-batch status 用） */
async function batchOverview() {
  const batches = await collectStore.listBatches();
  return batches
    .map(b => ({
      batchNo: String(b.fields['批次号'] || ''),
      project: b.fields['项目'] || '',
      count: b.fields['张数'] || 0,
      amount: typeof b.fields['金额合计'] === 'number' ? b.fields['金额合计'] : (parseFloat(b.fields['金额合计']) || 0),
      status: b.fields['状态'] || collectStore.BATCH_STATUS.LOCKED,
    }))
    .sort((a, b) => (a.status === b.status ? b.amount - a.amount : 0));
}

module.exports = {
  getPoolWithRecords,
  previewBatch,
  lockBatch,
  markBatch,
  regenerateBatchFiles,
  batchOverview,
  uploadBatchPdf,
  uploadBatchBom,
};
