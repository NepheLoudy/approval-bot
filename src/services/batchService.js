/**
 * 报销批次服务：财务三件套自动化（对接口径：重庆大学智能财务系统 + 小翼Plus，人工扫码录入）。
 *
 * 三件套映射：
 *   ① 选批+扫码 → 自动拟批（票池按项目聚合）+ 批次锁定（回写采集表「批次」、审批表「报销单」栏），
 *      附逐张查验要素清单（财务照单依次扫小翼Plus）；
 *   ② 打印文件 → 全自动：按录入顺序（=采集时间序）生成 A4 竖版一页两票 PDF，落批次表附件；
 *   ③ BOM 表 → 全自动：批次内审批记录（物资/型号/金额/发起人）生成 xlsx，落批次表附件。
 *
 * 交付包扩展（2026-09-25，照财务《物料清单》模板与学校「智能财务服务大厅投递单」实样）：
 *   ④ 物料清单（校格式）→ xlsx：序号/项目=开票内容/金额/用途/采购类型 + 总金额 + 制单人，
 *      缺开票内容的行「项目」列标黄（纯 QR 通道的票票面无该信息，录入小翼Plus 时现场补）；
 *   ⑤ 投递底单 → xlsx：投递单除投递号/公章/认证状态外的全部字段预填（报销人/项目卡/摘要/
 *      大写金额/转卡收款人/电子发票明细），财务照单录入小翼Plus；
 *   锁定成功后向审批群发「交付卡」（人工触发的直接回路，即时发送不接静默闸门），
 *   财务 @机器人 回复「接取」领取批次（登记接取人/时间）。
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
const { numToCnyUpper, numToCnOrdinal } = require('../utils/cny');

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
        invoiceCode: String(f['发票代码'] || ''),
        invoiceType: String(f['票种'] || ''),
        sellerName: String(f['销售方名称'] || ''),
        issueDateMs: Number(f['开票日期']) || 0,
        invoiceContent: String(f['开票内容'] || ''),
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
 * 建批次记录（已锁定，含摘要/用途/笔序）→ 生成 打印 PDF + BOM + 物料清单 + 投递底单 落附件。
 * 锁定后顺序不可变；迟到票进下一批。
 * @param {object} options {purpose 用途（默认=主项目）, note 备注}
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
    const primaryProject = projects[0] || '未归类';
    const purpose = String(options.purpose || '').trim() || primaryProject;
    const feeItem = String(options.feeItem || '').trim() || config.batch.feeItem;
    const purchaseType = String(options.purchaseType || '').trim() || config.batch.purchaseType;
    const payee = String(options.payee || '').trim() || config.batch.reporterName;
    const payeeAccount = String(options.payeeAccount || '').trim() || config.batch.bankCardNo;
    const ordinal = await nextProjectOrdinal(primaryProject);
    const summary = composeSummary({ project: primaryProject, purpose, ordinal });

    // 1. 先建批次记录（已锁定）——锁定主记录先行，后续步骤失败可经 regen/status 自愈，
    //    不会出现「票已出池、批次表无记录」的死局（复查 P1-5）
    const batchRecord = await collectStore.createBatch({
      '批次号': batchNo,
      '项目': projects.join('/'),
      '张数': pool.length,
      '金额合计': amount,
      '状态': collectStore.BATCH_STATUS.LOCKED,
      '锁定时间': Date.now(),
      '摘要': summary,
      '用途': purpose,
      '笔序': ordinal,
      '费用项': feeItem,
      '采购类型': purchaseType,
      '收款方': payee,
      '收款账号': payeeAccount,
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

    // 4. 生成四件附件（失败不阻断锁定，可 /approval-batch regen 重生成——复查 P2-5）
    const meta = { summary, purpose, ordinal, feeItem, purchaseType };
    let pdfToken = null, bomToken = null, mlToken = null, dsToken = null;
    try { pdfToken = await uploadBatchPdf(batchNo, pool); } catch (err) { console.error('[批次] 打印 PDF 生成失败:', err.message); }
    try { bomToken = await uploadBatchBom(batchNo, pool); } catch (err) { console.error('[批次] BOM 生成失败:', err.message); }
    try { mlToken = await uploadBatchMaterialList(batchNo, pool, meta); } catch (err) { console.error('[批次] 物料清单生成失败:', err.message); }
    try { dsToken = await uploadBatchDeliverySheet(batchNo, pool, meta); } catch (err) { console.error('[批次] 投递底单生成失败:', err.message); }
    const attach = {};
    if (pdfToken) attach['打印文件'] = [{ file_token: pdfToken }];
    if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
    if (mlToken) attach['物料清单'] = [{ file_token: mlToken }];
    if (dsToken) attach['投递底单'] = [{ file_token: dsToken }];
    if (Object.keys(attach).length) await collectStore.updateBatch(batchRecord.record_id, attach);

    return {
      batchNo, count: pool.length, amount, projects, approvalWritten,
      pdfToken, bomToken, mlToken, dsToken,
      summary, purpose, ordinal,
      warningCount: pool.filter(i => i.verifyStatus && i.verifyStatus !== '通过').length,
      missingContent: pool.filter(i => !i.invoiceContent).length,
      recordId: batchRecord.record_id, items: pool,
    };
  });
}

// ---------- 交付包元数据（摘要/笔序/归档名） ----------

/** 同主项目的既有批次数 + 1 → 「第N笔」序号 */
async function nextProjectOrdinal(primaryProject) {
  const batches = await collectStore.listBatches();
  const count = batches.filter(b => String(b.fields['项目'] || '').split('/').includes(primaryProject)).length;
  return count + 1;
}

/** 摘要拼装（照实样：机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔） */
function composeSummary({ project, purpose, ordinal }) {
  const parts = [config.batch.summaryPrefix, config.batch.season, project, purpose, config.batch.feeType]
    .map(s => String(s || '').trim()).filter(Boolean);
  const cn = numToCnOrdinal(ordinal);
  parts.push(cn ? `第${cn}笔` : `第${ordinal}笔`);
  return parts.join('-');
}

/** 归档文件夹名建议（照财务实样：20260920-对抗赛-飞镖-第二十四笔-237.04；非法字符替换） */
function buildArchiveFolderName({ dateMs, project, purpose, ordinal, amount }) {
  const d = new Date(dateMs || Date.now());
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();
  const parts = [ymd, sanitize(project), sanitize(purpose || project)];
  if (ordinal) {
    const cn = numToCnOrdinal(ordinal);
    parts.push(cn ? `第${cn}笔` : `第${ordinal}笔`);
  }
  parts.push(Number(amount).toFixed(2));
  return parts.join('-');
}

/** 毫秒时间戳 → 'YYYY-MM-DD'（开票日期展示，+08:00） */
function fmtDateMs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 批次附件重生成（/approval-batch regen） ----------

/** 重新生成指定批次的四件附件（打印件/BOM/物料清单/投递底单，生成失败自愈入口——复查 P2-5） */
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
      invoiceCode: String(f['发票代码'] || ''),
      invoiceType: String(f['票种'] || ''),
      sellerName: String(f['销售方名称'] || ''),
      issueDateMs: Number(f['开票日期']) || 0,
      invoiceContent: String(f['开票内容'] || ''),
    };
  }).sort((a, b) => a.collectedAt - b.collectedAt || 0);

  // 元数据（旧批次可能没有摘要/用途/笔序列 → 回落重算，不炸）
  const bf = batch.fields;
  const primaryProject = String(bf['项目'] || '').split('/')[0] || '未归类';
  const purpose = String(bf['用途'] || '') || primaryProject;
  const ordinal = Number(bf['笔序']) || await nextProjectOrdinal(primaryProject);
  const summary = String(bf['摘要'] || '') || composeSummary({ project: primaryProject, purpose, ordinal });
  const meta = {
    summary, purpose, ordinal,
    feeItem: String(bf['费用项'] || ''),
    purchaseType: String(bf['采购类型'] || ''),
  };

  let pdfToken = null, bomToken = null, mlToken = null, dsToken = null;
  try { pdfToken = await uploadBatchPdf(batchNo, items); } catch (err) { console.error('[批次] 打印 PDF 重生成失败:', err.message); }
  try { bomToken = await uploadBatchBom(batchNo, items); } catch (err) { console.error('[批次] BOM 重生成失败:', err.message); }
  try { mlToken = await uploadBatchMaterialList(batchNo, items, meta); } catch (err) { console.error('[批次] 物料清单重生成失败:', err.message); }
  try { dsToken = await uploadBatchDeliverySheet(batchNo, items, meta); } catch (err) { console.error('[批次] 投递底单重生成失败:', err.message); }
  const attach = {};
  if (pdfToken) attach['打印文件'] = [{ file_token: pdfToken }];
  if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
  if (mlToken) attach['物料清单'] = [{ file_token: mlToken }];
  if (dsToken) attach['投递底单'] = [{ file_token: dsToken }];
  if (Object.keys(attach).length) await collectStore.updateBatch(batch.record_id, attach);
  return { batchNo, count: items.length, pdfToken, bomToken, mlToken, dsToken };
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

// ---------- 交付包④：物料清单（校格式，严格照财务《物料清单》模板排版） ----------

// 缺失项标黄（开票内容缺失/配置缺失 → 录入小翼Plus 时现场补）。
// 注意 fill 必须带 type:'pattern'，否则 ExcelJS 写文件时会静默丢掉填充
const YELLOW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const SONG = { name: '宋体', family: 3, charset: 134 };

async function uploadBatchMaterialList(batchNo, items, meta = {}) {
  const purpose = String(meta.purpose || '').trim();
  const purchaseType = String(meta.purchaseType || '').trim() || config.batch.purchaseType;
  const preparer = config.batch.preparer || config.batch.reporterName;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  // 列宽/合并照模板：A 序号窄、B 项目宽、C 金额、D 用途、E 采购类型
  ws.columns = [{ width: 6 }, { width: 58 }, { width: 12 }, { width: 14 }, { width: 14 }];

  // 标题行（模板 A1:E1 合中）
  ws.mergeCells('A1:E1');
  const title = ws.getCell('A1');
  title.value = '物料清单';
  title.font = { ...SONG, size: 9 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };

  // 表头行
  const header = ws.getRow(2);
  ['序号', '项目', '金额', '用途', '采购类型'].forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = h;
    c.font = { ...SONG, size: 9 };
    c.alignment = { vertical: 'middle' };
  });

  // 数据行：项目列 = 开票内容（缺失标黄留空）
  items.forEach((item, i) => {
    const row = ws.getRow(3 + i);
    const values = [i + 1, item.invoiceContent || '', item.totalAmount, purpose, purchaseType];
    values.forEach((v, col) => {
      const c = row.getCell(col + 1);
      c.value = v;
      c.font = { ...SONG, size: 9 };
      c.alignment = { vertical: 'middle' };
      if (col === 1 && !item.invoiceContent) c.fill = YELLOW_FILL;
    });
  });

  // 总金额行（模板：B 列标签右对齐 + C 列 SUM 公式）
  const lastDataRow = 2 + items.length;
  const totalRow = ws.getRow(lastDataRow + 1);
  const totalLabel = totalRow.getCell(2);
  totalLabel.value = '总金额：';
  totalLabel.font = { ...SONG, size: 11 };
  totalLabel.alignment = { horizontal: 'right', vertical: 'middle' };
  const totalCell = totalRow.getCell(3);
  totalCell.value = { formula: `SUM(C3:C${lastDataRow})`, result: Math.round(items.reduce((s, i) => s + i.totalAmount, 0) * 100) / 100 };
  totalCell.numFmt = '0.00';

  // 制单人行
  const prepRow = ws.getRow(lastDataRow + 2);
  const prepLabel = prepRow.getCell(2);
  prepLabel.value = '制单人：';
  prepLabel.font = { ...SONG, size: 11 };
  prepLabel.alignment = { horizontal: 'right', vertical: 'middle' };
  const prepCell = prepRow.getCell(3);
  prepCell.value = preparer || '';
  prepCell.font = { ...SONG, size: 11 };
  prepCell.alignment = { vertical: 'middle' };
  if (!preparer) { prepCell.fill = YELLOW_FILL; }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return client.uploadMediaToBitable(buffer, `报销单_${batchNo}_物料清单.xlsx`);
}

// ---------- 交付包⑤：投递底单（照学校「智能财务服务大厅投递单」字段预填） ----------

async function uploadBatchDeliverySheet(batchNo, items, meta = {}) {
  const b = config.batch;
  const total = Math.round(items.reduce((s, i) => s + i.totalAmount, 0) * 100) / 100;
  const upper = numToCnyUpper(total);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('投递底单');
  ws.columns = [{ width: 16 }, { width: 36 }, { width: 14 }, { width: 20 }, { width: 42 }, { width: 12 }, { width: 12 }];

  let r = 1;
  const put = (label, value, { yellow = false, bold = false, note = '' } = {}) => {
    const row = ws.getRow(r++);
    const lc = row.getCell(1);
    lc.value = label;
    lc.font = { ...SONG, size: 10, bold };
    lc.alignment = { vertical: 'middle' };
    const vc = row.getCell(2);
    vc.value = value;
    vc.font = { ...SONG, size: 10 };
    vc.alignment = { vertical: 'middle' };
    if (yellow) vc.fill = YELLOW_FILL;
    if (note) {
      const nc = row.getCell(3);
      nc.value = note;
      nc.font = { ...SONG, size: 9, italic: true, color: { argb: 'FF808080' } };
    }
  };

  // 标题 + 说明
  ws.mergeCells(`A${r}:G${r}`);
  const title = ws.getCell(`A${r}`);
  title.value = '重庆大学投递报销单（投递底单）';
  title.font = { ...SONG, size: 14, bold: true };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  r++;
  ws.mergeCells(`A${r}:G${r}`);
  const note = ws.getCell(`A${r}`);
  note.value = `机器人预填稿 · 批次 ${batchNo} · 照单录入小翼Plus；投递号/公章/认证状态由学校系统与纸质流程生成`;
  note.font = { ...SONG, size: 9, italic: true, color: { argb: 'FF808080' } };
  r++;

  put('投递号', '', { note: '提交后由学校系统生成' });
  put('填报时间', '', { note: '提交时自动生成' });
  put('公章', '', { note: '纸质件盖章处' });
  put('报销人工号', b.reporterStuId, { yellow: !b.reporterStuId });
  put('姓名', b.reporterName, { yellow: !b.reporterName });
  put('联系电话', b.reporterPhone, { yellow: !b.reporterPhone });
  put('项目编号', b.projectCode, { yellow: !b.projectCode });
  put('项目所属部门', b.projectDept, { yellow: !b.projectDept });
  put('项目名称', b.projectName, { yellow: !b.projectName });
  put('项目负责人', b.projectLeader, { yellow: !b.projectLeader });
  put('团队负责人', '', { note: '如学校要求则手填' });
  put('摘要', meta.summary || '');
  put('附件张数', items.length);
  put('备注', '');
  put('费用项', String(meta.feeItem || '').trim() || config.batch.feeItem);
  put('报销金额', total);
  put('申请总金额', total);
  put('大写金额', upper, { yellow: !upper });
  put('财务核准报销金额', '', { note: '财务填写' });
  put('支付方式', '转卡');
  put('收款人工号', b.reporterStuId, { yellow: !b.reporterStuId });
  put('收款人姓名', b.reporterName, { yellow: !b.reporterName });
  put('卡号', b.bankCardNo, { yellow: !b.bankCardNo });
  put('开户行', b.bankName, { yellow: !b.bankName });
  put('金额', total);

  r++;
  // 电子发票明细
  const headRow = ws.getRow(r++);
  ['发票代码', '发票号码', '开票单位', '开票日期', '开票内容', '发票金额', '是否已认证'].forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h;
    c.font = { ...SONG, size: 10, bold: true };
    c.alignment = { vertical: 'middle' };
  });
  for (const item of items) {
    const row = ws.getRow(r++);
    const invoiceCode = item.invoiceType === '全电发票' ? '数电票' : (item.invoiceCode || item.invoiceType || '');
    const values = [invoiceCode, item.invoiceNo, item.sellerName, fmtDateMs(item.issueDateMs), item.invoiceContent || '', item.totalAmount, ''];
    values.forEach((v, col) => {
      const c = row.getCell(col + 1);
      c.value = v;
      c.font = { ...SONG, size: 10 };
      c.alignment = { vertical: 'middle' };
      if (col === 4 && !item.invoiceContent) c.fill = YELLOW_FILL;
    });
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return client.uploadMediaToBitable(buffer, `报销单_${batchNo}_投递底单.xlsx`);
}

// ---------- 批次接取（审批群回复「接取」领取） ----------

/**
 * 接取批次：登记「接取人/接取时间」。不带批次号 = 接取最近锁定的未接取批次。
 * 仅【已锁定】可接取；已被他人接取报错（重复接取幂等返回）。
 */
async function claimBatch(batchNo, claimer = '') {
  let batch;
  if (batchNo) {
    batch = await collectStore.findBatchByName(batchNo);
    if (!batch) throw new Error(`批次不存在：${batchNo}`);
  } else {
    const candidates = (await collectStore.listBatches())
      .filter(b => (b.fields['状态'] || collectStore.BATCH_STATUS.LOCKED) === collectStore.BATCH_STATUS.LOCKED && !b.fields['接取人'])
      .sort((a, b) => (Number(b.fields['锁定时间']) || 0) - (Number(a.fields['锁定时间']) || 0));
    if (!candidates.length) throw new Error('当前没有待接取的已锁定批次（锁定后群里回复「接取」即可领取）');
    batch = candidates[0];
  }

  const f = batch.fields;
  const bNo = String(f['批次号'] || '');
  const status = f['状态'] || collectStore.BATCH_STATUS.LOCKED;
  if (status !== collectStore.BATCH_STATUS.LOCKED) throw new Error(`批次 ${bNo} 状态为【${status}】，仅【已锁定】批次可接取`);
  const reClaim = Boolean(f['接取人']);
  if (reClaim && claimer && String(f['接取人']) !== claimer) {
    throw new Error(`批次 ${bNo} 已由 ${f['接取人']} 接取（如需改派请管理员在报销批次表修改）`);
  }
  if (!reClaim) {
    await collectStore.updateBatch(batch.record_id, { '接取人': claimer || '财务', '接取时间': Date.now() });
  }
  return {
    batchNo: bNo,
    project: f['项目'] || '',
    count: f['张数'] || 0,
    amount: typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(f['金额合计']) || 0),
    summary: String(f['摘要'] || ''),
    taker: String(f['接取人'] || claimer || '财务'),
    reClaim,
  };
}

// ---------- 批次状态流转（已提交/已到账/已退回） ----------

async function markBatch(batchNo, status, operator = '') {
  const batch = await collectStore.findBatchByName(batchNo);
  if (!batch) throw new Error(`批次不存在：${batchNo}`);
  const now = Date.now();
  const fields = { '状态': status };
  if (status === collectStore.BATCH_STATUS.SUBMITTED) fields['提交时间'] = now;
  if (status === collectStore.BATCH_STATUS.PAID) fields['到账时间'] = now;
  // 操作留痕（2026-09-25 安全审查 #2：资金状态变更必须可追责；operator 经 open_id 反查实名）
  if (operator) {
    fields['最后操作人'] = operator;
    fields['最后操作时间'] = now;
  }
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
  const paidAt = fields['到账时间'] || f['到账时间'];
  return {
    batchNo,
    status,
    count: f['张数'],
    amount: typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(f['金额合计']) || 0),
    returnedToPool,
    // 已到账 → 归档文件夹名建议（照财务实样 20260920-对抗赛-飞镖-第二十四笔-237.04）
    archiveFolder: status === collectStore.BATCH_STATUS.PAID
      ? buildArchiveFolderName({
          dateMs: Number(paidAt) || Date.now(),
          project: String(f['项目'] || ''),
          purpose: String(f['用途'] || '') || undefined,
          ordinal: Number(f['笔序']) || 0,
          amount: typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(f['金额合计']) || 0),
        })
      : '',
  };
}

/** 批次总览（/approval-batch status 用）：按状态机先后分组（未知的排最后），组内金额降序 */
async function batchOverview() {
  const { BATCH_STATUS } = collectStore;
  const statusOrder = {
    [BATCH_STATUS.DRAFT]: 0,
    [BATCH_STATUS.LOCKED]: 1,
    [BATCH_STATUS.SUBMITTED]: 2,
    [BATCH_STATUS.PAID]: 3,
    [BATCH_STATUS.REJECTED]: 4,
  };
  const batches = await collectStore.listBatches();
  return batches
    .map(b => ({
      batchNo: String(b.fields['批次号'] || ''),
      project: b.fields['项目'] || '',
      count: b.fields['张数'] || 0,
      amount: typeof b.fields['金额合计'] === 'number' ? b.fields['金额合计'] : (parseFloat(b.fields['金额合计']) || 0),
      status: b.fields['状态'] || collectStore.BATCH_STATUS.LOCKED,
      taker: String(b.fields['接取人'] || ''),
      operator: String(b.fields['最后操作人'] || ''),
    }))
    .sort((a, b) => ((statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99) || b.amount - a.amount));
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
  uploadBatchMaterialList,
  uploadBatchDeliverySheet,
  claimBatch,
  composeSummary,
  buildArchiveFolderName,
  fmtDateMs,
};
