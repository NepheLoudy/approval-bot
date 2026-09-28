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
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink, Table, TableRow, TableCell, WidthType } = require('docx');
const QRCode = require('qrcode');
const config = require('../config');
const client = require('../feishu/client');
const bitableApi = require('../feishu/bitable');
const collectStore = require('./collectStore');
const invoiceParser = require('./invoiceParser');
const { numToCnyUpper, numToCnOrdinal } = require('../utils/cny');
const { fieldText } = require('../utils/fields');

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

/** 审批表记录 → 申请编号字段索引（票池与 regen 共用，防两处口径漂移） */
async function approvalFieldsByApplyNo() {
  const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
  const byApplyNo = new Map();
  for (const r of approvals) {
    const f = r.fields || {};
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    if (applyNo) byApplyNo.set(applyNo, f);
  }
  return byApplyNo;
}

/**
 * 采集记录 → 票池 item（getPoolWithRecords 与 regenerateBatchFiles 共用的唯一映射——
 * 复查 P1-8：此前 regen 侧复制了一份映射且漏带 collectedAt，排序恒 0 打印件顺序漂移）。
 */
function collectToItem(r, byApplyNo) {
  const f = r.fields;
  const applyNo = String(f['关联申请编号'] || '');
  const af = byApplyNo.get(applyNo) || {};
  // 金额解析：parseFloat 前先去千分位逗号（复查 P2：'1,234.56' 直接 parseFloat 会截断成 1）；
  // 解析后非数或 <=0 标 amountInvalid（计入 warningCount + 投递底单金额格标黄——复查 P2，
  // 此前静默归零无任何警示，财务容易按 0 元漏录）
  const rawAmount = f['价税合计'];
  const totalAmount = typeof rawAmount === 'number'
    ? rawAmount
    : (parseFloat(String(rawAmount ?? '').replace(/,/g, '')) || 0);
  return {
    record_id: r.record_id,
    invoiceNo: String(f['发票号码'] || ''),
    totalAmount,
    amountInvalid: !(totalAmount > 0),
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
    qrPayload: String(f['二维码内容'] || ''),
    // 特殊事项触发源（2026-09-27 曼波反馈：公私属性不分明/大额票要单独排纸——
    // 表单字段名自带触发规则，非空即命中；值为审批管理员预览链接 {link,text}）
    payRecord: af['支付记录（大于800元或宣传材料需要）'] || null,
    evidencePhoto: af['实物佐证照片（公私属性不分明或宣传材料需要）-副本'] || null,
    // 人机制单去重标记（2026-09-29 曼波定）：审批表「是否打印=是」= 财务自行制单打印，
    // 该票不进票池/不参与机器人制单；regen 侧不受此过滤（已归批票照常重生成附件）
    printed: fieldText(af['是否打印']) === '是',
  };
}

/** 票池：已采集未归批，关联审批记录（物资/项目/型号），按采集时间升序（录入序）。
 *  「是否打印=是」的票不进池（财务已自行制单，与机器人制单能力去重） */
async function getPoolWithRecords() {
  const collects = await collectStore.listCollect();
  const byApplyNo = await approvalFieldsByApplyNo();

  return collects
    .filter(r => !r.fields['批次'])
    .map((r) => collectToItem(r, byApplyNo))
    .filter(p => !p.printed)
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
      warningCount: items.filter(i => i.verifyStatus !== '通过' || i.amountInvalid).length,
    }))
    .sort((a, b) => b.count - a.count);
  return { poolSize: pool.length, suggestions };
}

// ---------- 批次锁定 ----------

/**
 * 锁定批次：pool 内票（可选按项目过滤）→ 回写采集表「批次」+ 审批表「报销单」栏 →
 * 建批次记录（已锁定，含摘要/用途/笔序）→ 生成 打印 PDF + BOM + 物料清单 + 投递底单 落附件。
 * 锁定后顺序不可变；迟到票进下一批。
 * @param {object} options {purpose 用途（默认=主项目）, note 备注, operator 操作人（锁定留痕）}
 */
async function lockBatch(batchNo, project, options = {}) {
  if (!batchNo || !batchNo.trim()) throw new Error('批次号不能为空（如 27备赛20步兵5）');
  batchNo = batchNo.trim();

  // 全程按批次号加锁（防并发双锁同一池票——复查 P1-6）；锁内二次查重。
  // batch_ 锁内全程再包 pool 锁（复查 P1：batch_ 锁只互斥同批次号，不同批次号并发 lock
  // 会在互不排斥的情况下各自快照同一票池，同一张票进两批 → 双金额双张数；
  // 嵌套锁顺序恒为 batch_ → pool → proj_，无反向嵌套，安全）
  return withLock(`batch_${batchNo}`, () => withLock('pool', async () => {
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
    // 笔序计算与建批包进主项目锁（复查 P1-9）：同项目两笔不同批次号并发锁定时，外层
    // batch_ 锁互不排斥，「数既有批次+1」会撞出同一笔序 → 摘要重复 → 台账按摘要匹配丢账。
    // 嵌套锁顺序恒为 batch_ → proj_（无反向嵌套），安全
    const { ordinal, summary, batchRecord } = await withLock(`proj_${primaryProject}`, async () => {
      const ord = await nextProjectOrdinal(primaryProject);
      const sum = composeSummary({ project: primaryProject, purpose, ordinal: ord });
      // 1. 先建批次记录（已锁定）——锁定主记录先行，后续步骤失败可经 regen/status 自愈，
      //    不会出现「票已出池、批次表无记录」的死局（复查 P1-5）
      const rec = await collectStore.createBatch({
        '批次号': batchNo,
        '项目': projects.join('/'),
        '张数': pool.length,
        '金额合计': amount,
        '状态': collectStore.BATCH_STATUS.LOCKED,
        '锁定时间': Date.now(),
        '摘要': sum,
        '用途': purpose,
        '笔序': ord,
        '费用项': feeItem,
        '采购类型': purchaseType,
        '收款方': payee,
        '收款账号': payeeAccount,
        ...(options.note ? { '备注': options.note } : {}),
        // 操作留痕（复查 P2-4：锁定无操作留痕；有 operator 才写）
        ...(options.operator ? { '最后操作人': options.operator, '最后操作时间': Date.now() } : {}),
      });
      return { ordinal: ord, summary: sum, batchRecord: rec };
    });

    // 2. 采集表回写批次（逐张 catch 收集失败清单——复查 P2-6：中途失败要在回执/备注暴露）
    const markFailed = [];
    for (const p of pool) {
      try {
        await collectStore.updateCollect(p.record_id, { '批次': batchNo });
      } catch (err) {
        console.error(`[批次] 回写采集表批次失败（${p.invoiceNo}）:`, err.message);
        markFailed.push(p.invoiceNo);
      }
    }

    // 3. 审批表「报销单」栏 + 「是否打印」回写（单选，值不存在飞书自动建选项；有申请编号的才回写）。
    //    是否打印=是（2026-09-29 曼波定）：锁定即视为已进打印流程（票已归批不会再进池，附件
    //    生成失败可 regen 自愈，先标无重复制单风险），同时让财务在表格里看到这批已由机器人处理
    let approvalWritten = 0;
    if (pool.some(p => p.applyNo)) {
      const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
      const recordByApplyNo = new Map();
      for (const r of approvals) {
        const f = r.fields || {};
        const no = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
        if (no) recordByApplyNo.set(no, r);
      }
      for (const p of pool) {
        if (!p.applyNo) continue;
        const hit = recordByApplyNo.get(p.applyNo);
        if (!hit) continue;
        try {
          await bitableApi.updateRecord(config.bitable.approvalTableId, hit.record_id, { '报销单': batchNo, '是否打印': '是' });
          approvalWritten++;
        } catch (err) {
          console.error(`[批次] 回写审批表报销单栏失败（${p.applyNo}）:`, err.message);
          markFailed.push(p.applyNo);
        }
      }
    }

    // 4. 生成四件附件（失败不阻断锁定，可 /approval-batch regen 重生成——复查 P2-5）。
    //    meta 带 payee/payeeAccount（复查 P1：收款方覆盖要进投递底单，否则底单恒写 .env
    //    CQ_* 默认卡，账实分离——批次记录/台账是 A 卡、钱打到 .env 默认 B 卡）
    const meta = { summary, purpose, ordinal, feeItem, purchaseType, payee, payeeAccount };
    let pdfToken = null, docxToken = null, bomToken = null, mlToken = null, dsToken = null, specialPdfToken = null, specialDocxToken = null, ssToken = null, scanItems = [];
    try { pdfToken = await uploadBatchPdf(batchNo, pool); } catch (err) { console.error('[批次] 打印 PDF 生成失败:', err.message); }
    try { docxToken = await uploadBatchDocx(batchNo, pool); } catch (err) { console.error('[批次] 打印件 docx 生成失败:', err.message); }
    try { bomToken = await uploadBatchBom(batchNo, pool); } catch (err) { console.error('[批次] BOM 生成失败:', err.message); }
    try { mlToken = await uploadBatchMaterialList(batchNo, pool, meta); } catch (err) { console.error('[批次] 物料清单生成失败:', err.message); }
    try { dsToken = await uploadBatchDeliverySheet(batchNo, pool, meta); } catch (err) { console.error('[批次] 投递底单生成失败:', err.message); }
    try { ({ token: ssToken, scanItems } = await uploadBatchScanSheetDocx(batchNo, pool)); } catch (err) { console.error('[批次] 扫码清单生成失败:', err.message); }
    const specials = pool.filter(isSpecialItem);
    if (specials.length) {
      try { specialPdfToken = await uploadBatchSpecialSheetPdf(batchNo, specials); } catch (err) { console.error('[批次] 特殊事项附页 PDF 生成失败:', err.message); }
      try { specialDocxToken = await uploadBatchSpecialSheetDocx(batchNo, specials); } catch (err) { console.error('[批次] 特殊事项附页 docx 生成失败:', err.message); }
    }
    const attach = {};
    if (pdfToken || docxToken) {
      attach['打印文件'] = [
        ...(pdfToken ? [{ file_token: pdfToken }] : []),
        ...(docxToken ? [{ file_token: docxToken }] : []),
      ];
    }
    if (specialPdfToken || specialDocxToken) {
      attach['特殊事项附页'] = [specialPdfToken, specialDocxToken].filter(Boolean).map((t) => ({ file_token: t }));
    }
    if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
    if (mlToken) attach['物料清单'] = [{ file_token: mlToken }];
    if (dsToken) attach['投递底单'] = [{ file_token: dsToken }];
    if (ssToken) attach['扫码清单'] = [{ file_token: ssToken }];
    if (Object.keys(attach).length) await collectStore.updateBatch(batchRecord.record_id, attach);

    // 5. 打标失败暴露（复查 P2-6）：批次备注追加 + 返回给回执，财务可对漏标票人工补
    if (markFailed.length) {
      const markNote = `${markFailed.length} 张打标失败（${markFailed.slice(0, 5).join('、')}${markFailed.length > 5 ? '…' : ''}）`;
      try {
        await collectStore.updateBatch(batchRecord.record_id, {
          '备注': [options.note, markNote].filter(Boolean).join('；'),
        });
      } catch (err) {
        console.error('[批次] 打标失败备注回写失败:', err.message);
      }
    }

    return {
      batchNo, count: pool.length, amount, projects, approvalWritten,
      pdfToken, docxToken, bomToken, mlToken, dsToken, specialPdfToken, specialDocxToken,
      ssToken, scanItems,
      specialCount: specials.length,
      summary, purpose, ordinal, markFailed,
      warningCount: pool.filter(i => i.verifyStatus !== '通过' || i.amountInvalid).length,
      missingContent: pool.filter(i => !i.invoiceContent).length,
      recordId: batchRecord.record_id, items: pool,
    };
  }));
}

// ---------- 交付包元数据（摘要/笔序/归档名） ----------

/** 同主项目的既有批次数 + 1 → 「第N笔」序号 */
async function nextProjectOrdinal(primaryProject) {
  const batches = await collectStore.listBatches();
  // 项目名自身含 '/' 时 split('/') 会把它劈成两段、includes 永不命中（笔序恒 1 →
  // 摘要重复 → 台账按摘要匹配丢账）——复查 P2：此时改用「项目」字段精确等值计数
  const count = String(primaryProject).includes('/')
    ? batches.filter(b => String(b.fields['项目'] || '') === primaryProject).length
    : batches.filter(b => String(b.fields['项目'] || '').split('/').includes(primaryProject)).length;
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

  const byApplyNo = await approvalFieldsByApplyNo();
  // 采集记录 → item 映射与票池共用一份（含 collectedAt，打印件顺序=采集时间序——复查 P1-8）
  const items = collects
    .map((r) => collectToItem(r, byApplyNo))
    .sort((a, b) => a.collectedAt - b.collectedAt);

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
    // 收款方从批次记录读回（复查 P1：regen 也要让锁定时的 收款方=/收款账号= 覆盖进投递底单，
    // 不能回落 .env CQ_* 默认卡造成账实分离）
    payee: String(bf['收款方'] || ''),
    payeeAccount: String(bf['收款账号'] || ''),
  };

  // 金额漂移核对（复查 P1）：regen 用采集表现值重造四件附件，若与批次锁定时记录的
  // 「金额合计」对不上（票被挪动/金额被改），如实暴露给回执与批次备注，财务核对台账
  const regenTotal = Math.round(items.reduce((s, i) => s + i.totalAmount, 0) * 100) / 100;
  const recordedTotal = typeof bf['金额合计'] === 'number' ? bf['金额合计'] : (parseFloat(bf['金额合计']) || 0);
  const amountDrift = Math.abs(regenTotal - recordedTotal) > 0.005
    ? { recorded: recordedTotal, current: regenTotal }
    : null;

  let pdfToken = null, docxToken = null, bomToken = null, mlToken = null, dsToken = null, specialPdfToken = null, specialDocxToken = null, ssToken = null, scanItems = [];
  try { pdfToken = await uploadBatchPdf(batchNo, items); } catch (err) { console.error('[批次] 打印 PDF 重生成失败:', err.message); }
  try { docxToken = await uploadBatchDocx(batchNo, items); } catch (err) { console.error('[批次] 打印件 docx 重生成失败:', err.message); }
  try { bomToken = await uploadBatchBom(batchNo, items); } catch (err) { console.error('[批次] BOM 重生成失败:', err.message); }
  try { mlToken = await uploadBatchMaterialList(batchNo, items, meta); } catch (err) { console.error('[批次] 物料清单重生成失败:', err.message); }
  try { dsToken = await uploadBatchDeliverySheet(batchNo, items, meta); } catch (err) { console.error('[批次] 投递底单重生成失败:', err.message); }
  try { ({ token: ssToken, scanItems } = await uploadBatchScanSheetDocx(batchNo, items)); } catch (err) { console.error('[批次] 扫码清单重生成失败:', err.message); }
  const specials = items.filter(isSpecialItem);
  if (specials.length) {
    try { specialPdfToken = await uploadBatchSpecialSheetPdf(batchNo, specials); } catch (err) { console.error('[批次] 特殊事项附页 PDF 重生成失败:', err.message); }
    try { specialDocxToken = await uploadBatchSpecialSheetDocx(batchNo, specials); } catch (err) { console.error('[批次] 特殊事项附页 docx 重生成失败:', err.message); }
  }
  const attach = {};
  if (pdfToken || docxToken) {
    attach['打印文件'] = [
      ...(pdfToken ? [{ file_token: pdfToken }] : []),
      ...(docxToken ? [{ file_token: docxToken }] : []),
    ];
  }
  if (specialPdfToken || specialDocxToken) {
    attach['特殊事项附页'] = [specialPdfToken, specialDocxToken].filter(Boolean).map((t) => ({ file_token: t }));
  }
  if (bomToken) attach['BOM表'] = [{ file_token: bomToken }];
  if (mlToken) attach['物料清单'] = [{ file_token: mlToken }];
  if (dsToken) attach['投递底单'] = [{ file_token: dsToken }];
  if (ssToken) attach['扫码清单'] = [{ file_token: ssToken }];
  if (Object.keys(attach).length) await collectStore.updateBatch(batch.record_id, attach);
  if (amountDrift) {
    try {
      const prevNote = String(bf['备注'] || '');
      await collectStore.updateBatch(batch.record_id, {
        '备注': `${prevNote ? `${prevNote}；` : ''}⚠️ regen 后金额与锁定值不一致（记录 ¥${recordedTotal.toFixed(2)} / 实际 ¥${regenTotal.toFixed(2)}），请核对台账`,
      });
    } catch (err) {
      console.error('[批次] 金额漂移备注回写失败:', err.message);
    }
  }
  return { batchNo, count: items.length, pdfToken, docxToken, bomToken, mlToken, dsToken, specialPdfToken, specialDocxToken, ssToken, scanItems, specialCount: specials.length, amountDrift };
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
  // 工作表名对批次号消毒（复查 P2：Excel 工作表名禁用 :\/?*[] 等字符，
  // 批次号照财务命名可能带 /，直接用会在 addWorksheet 抛错）
  const safeSheetName = `BOM-${String(batchNo).replace(/[\\/:*?"<>|[\]]/g, '')}`;
  const ws = wb.addWorksheet(safeSheetName);
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
      // 空校验状态显示「未校验」而非「通过」（复查 P2：纯 QR 通道票票面无校验结果，
      // 写「通过」会让财务误以为已核验；「未校验」与 warningCount 口径一致）
      verifyStatus: item.verifyStatus || '未校验',
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
  // 收款人姓名/卡号：批次锁定时 收款方=/收款账号= 覆盖优先（meta 带入），回落 .env 默认卡
  // （复查 P1：此前恒写默认卡，lock 的收款方覆盖只进批次记录与台账 → 账实分离）
  const dsPayee = String(meta.payee || '').trim() || b.reporterName;
  const dsPayeeAccount = String(meta.payeeAccount || '').trim() || b.bankCardNo;
  put('收款人姓名', dsPayee, { yellow: !dsPayee });
  put('卡号', dsPayeeAccount, { yellow: !dsPayeeAccount });
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
      // 金额格：解析失败/<=0 的票标黄（复查 P2：collectToItem 静默归零的票在底单上要有警示）
      if (col === 5 && item.amountInvalid) c.fill = YELLOW_FILL;
    });
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return client.uploadMediaToBitable(buffer, `报销单_${batchNo}_投递底单.xlsx`);
}

// ---------- 交付包⑥：打印件 docx 可编辑版 + 特殊事项附页（2026-09-27 曼波反馈） ----------

const DOCX_CONTENT_WIDTH = 700; // px @96dpi（A4 宽 − 1in 页边距）

/** 特殊事项触发：大额（≥¥BATCH_SPECIAL_AMOUNT，默认 500）/ 有支付记录 / 有实物佐证照片（公私属性不分明） */
function isSpecialItem(item) {
  return item.totalAmount >= config.batch.specialAmount
    || Boolean(item.payRecord)
    || Boolean(item.evidencePhoto);
}

function specialReasons(item) {
  const reasons = [];
  if (item.totalAmount >= config.batch.specialAmount) reasons.push(`大额（≥¥${config.batch.specialAmount}）`);
  if (item.payRecord) reasons.push('有支付记录');
  if (item.evidencePhoto) reasons.push('公私属性不分明/宣传材料（有实物佐证）');
  return reasons;
}

/** 运行时加载系统中文字体（目标机=Windows，simhei/msyh 在位；读不到回退 ASCII 渲染） */
async function loadCjkFont(pdfDoc) {
  const candidates = ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/msyh.ttf'];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      pdfDoc.registerFontkit(fontkit);
      return await pdfDoc.embedFont(fs.readFileSync(p), { subset: true });
    } catch (err) {
      console.warn(`[批次] 中文字体加载失败（${p}）: ${err.message}`);
    }
  }
  return null;
}

/**
 * 特殊事项附页 PDF：每张特殊票一页 A4（触发原因 + 票面要素 + 付款记录/实物佐证链接）。
 * 原件是审批管理员预览链接，机器人抓不到图片本体——链接版：财务有管理员权限，
 * 浏览器点开即原件；APPROVAL_CODE 配置后可升级为实例附件下载直嵌图片。
 */
async function uploadBatchSpecialSheetPdf(batchNo, specials) {
  const out = await PDFDocument.create();
  const cjk = await loadCjkFont(out);
  const ascii = await out.embedFont(StandardFonts.Helvetica);
  const draw = (page, text, y, { size = 11 } = {}) => {
    const hasCJK = /[\u4e00-\u9fff]/.test(text);
    const font = hasCJK ? (cjk || ascii) : ascii;
    page.drawText(hasCJK && !cjk ? text.replace(/[\u4e00-\u9fff]/g, '?') : text, { x: 50, y, size, font });
  };
  specials.forEach((item, i) => {
    const page = out.addPage([A4.width, A4.height]);
    let y = A4.height - 60;
    draw(page, `特殊事项说明（${i + 1}/${specials.length}）· 批次 ${batchNo}`, y, { size: 16 });
    y -= 30;
    draw(page, `物资：${item.material || '—'}`, y); y -= 20;
    draw(page, `申请编号：${item.applyNo || '—'}    金额：¥${item.totalAmount.toFixed(2)}    发票尾号：${item.invoiceNo.slice(-6)}`, y); y -= 20;
    draw(page, `触发原因：${specialReasons(item).join('；') || '—'}`, y); y -= 26;
    if (item.payRecord) {
      draw(page, `支付记录：${item.payRecord.text || '附件'}（浏览器打开链接查看原件）`, y); y -= 16;
      draw(page, item.payRecord.link || '', y, { size: 8 }); y -= 24;
    }
    if (item.evidencePhoto) {
      draw(page, `实物佐证照片：${item.evidencePhoto.text || '附件'}（浏览器打开链接查看原件）`, y); y -= 16;
      draw(page, item.evidencePhoto.link || '', y, { size: 8 }); y -= 24;
    }
    draw(page, 'Note: links require approval-admin permission in browser.', y, { size: 8 });
  });
  const bytes = await out.save();
  return client.uploadMediaToBitable(Buffer.from(bytes), `报销单_${batchNo}_特殊事项附页.pdf`);
}

/** 特殊事项附页 docx（Word 原生：中文/超链接全支持，财务可编辑） */
function specialSheetDocxChildren(batchNo, specials) {
  const children = [new Paragraph({ children: [new TextRun({ text: `特殊事项说明 · 批次 ${batchNo}（${specials.length} 张）`, bold: true, size: 28 })] })];
  specials.forEach((item, i) => {
    children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: `第 ${i + 1} 张 · ${item.material || item.applyNo || item.invoiceNo}`, bold: true, size: 24 })] }));
    const line = (text) => children.push(new Paragraph({ children: [new TextRun({ text, size: 20 })] }));
    line(`物资：${item.material || '—'}`);
    line(`申请编号：${item.applyNo || '—'}    金额：¥${item.totalAmount.toFixed(2)}    发票尾号：${item.invoiceNo.slice(-6)}`);
    line(`触发原因：${specialReasons(item).join('；') || '—'}`);
    if (item.payRecord) {
      children.push(new Paragraph({ children: [new TextRun({ text: '支付记录：', size: 20 }), new ExternalHyperlink({ children: [new TextRun({ text: item.payRecord.text || '打开原件', style: 'Hyperlink', size: 20 })], link: item.payRecord.link })] }));
      children.push(new Paragraph({ children: [new ExternalHyperlink({ children: [new TextRun({ text: item.payRecord.link, style: 'Hyperlink', size: 14 })], link: item.payRecord.link })] }));
    }
    if (item.evidencePhoto) {
      children.push(new Paragraph({ children: [new TextRun({ text: '实物佐证照片：', size: 20 }), new ExternalHyperlink({ children: [new TextRun({ text: item.evidencePhoto.text || '打开原件', style: 'Hyperlink', size: 20 })], link: item.evidencePhoto.link })] }));
      children.push(new Paragraph({ children: [new ExternalHyperlink({ children: [new TextRun({ text: item.evidencePhoto.link, style: 'Hyperlink', size: 14 })], link: item.evidencePhoto.link })] }));
    }
    children.push(new Paragraph({ children: [new TextRun({ text: '注：链接需审批管理员权限，浏览器打开查看原件图片。', size: 16, color: '888888' })] }));
  });
  return children;
}

async function uploadBatchSpecialSheetDocx(batchNo, specials) {
  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 } } }, children: specialSheetDocxChildren(batchNo, specials) }],
  });
  const buffer = await Packer.toBuffer(doc);
  return client.uploadMediaToBitable(Buffer.from(buffer), `报销单_${batchNo}_特殊事项附页.docx`);
}

/** 打印件 docx 可编辑版：发票图片按录入序纵向排入 Word（财务可调可删后直接打印；PDF 原件票标注见 PDF 版） */
async function uploadBatchDocx(batchNo, items) {
  const children = [new Paragraph({ children: [new TextRun({ text: `报销打印件 · 批次 ${batchNo}（${items.length} 张，按录入顺序）`, bold: true, size: 26 })] })];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: `${i + 1}. ${item.material || item.applyNo || '未标注'} ｜ ¥${item.totalAmount.toFixed(2)} ｜ 发票尾号 ${item.invoiceNo.slice(-6)}`, bold: true })] }));
    if (!item.fileTokens.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: '⚠️ 票面原件缺失（采集时未成功转存），请财务手工补印', color: 'FF0000' })] }));
      continue;
    }
    for (const token of item.fileTokens) {
      const buf = await downloadMediaSafe(token);
      if (!buf) {
        children.push(new Paragraph({ children: [new TextRun({ text: '⚠️ 票面原件下载失败，请财务手工补', color: 'FF0000' })] }));
        continue;
      }
      if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF') {
        children.push(new Paragraph({ children: [new TextRun({ text: '（该票为 PDF 原件，版面见打印件 PDF 版）', color: '888888' })] }));
        continue;
      }
      let width = 1000, height = 700;
      try {
        const meta = await sharp(buf).metadata();
        if (meta.width && meta.height) { width = meta.width; height = meta.height; }
      } catch (err) { /* 尺寸读不到按默认比例 */ }
      const w = DOCX_CONTENT_WIDTH;
      const h = Math.max(1, Math.round(w * height / width));
      children.push(new Paragraph({ children: [new ImageRun({ data: buf, transformation: { width: w, height: h } })] }));
    }
  }
  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  return client.uploadMediaToBitable(buffer, `报销单_${batchNo}_打印件.docx`);
}

// ---------- 交付包⑦：扫码清单（2026-09-29 曼波定） ----------
// 财务进重大官网报销的逻辑是扫发票二维码；本清单把批次内所有票的二维码按录入序
// 重新生成并打上序号，财务对屏幕/打印件按序号一次扫完，不用翻原始发票找码。
// 二维码来源优先级：采集时存的「二维码内容」原文重生成（与小翼Plus 扫码同源，100% 可扫）
// → 回退解码「发票图片」原件 → 仍失败 = 无效票（清单标注请扫纸质原件，交付卡不放它的码）。

/** 批次各票二维码图（扫码清单 docx 与交付卡内嵌图共用一份，保证两边顺序/内容一致） */
async function buildBatchQrImages(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const base = {
      seq: i + 1,
      tail: item.invoiceNo ? item.invoiceNo.slice(-6) : '??????',
      amountText: `¥${(item.totalAmount || 0).toFixed(2)}`,
      valid: false,
      png: null,
      note: '',
    };
    let payload = item.qrPayload || '';
    if (!payload && item.fileTokens.length) {
      for (const token of item.fileTokens) {
        const buf = await downloadMediaSafe(token);
        if (!buf || (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF')) continue;
        try {
          const { result } = await invoiceParser.tryQrChannel(buf);
          if (result && result.ok && result.qrPayload) { payload = result.qrPayload; break; }
        } catch (err) { /* 单附件解码失败，试下一张 */ }
      }
    }
    if (!payload) {
      out.push({ ...base, note: !item.fileTokens.length ? '票面原件缺失，请扫纸质原件' : '二维码不可重建（识别时未取得二维码原文），请扫纸质原件' });
      continue;
    }
    // errorCorrectionLevel M + 480px：屏幕/打印两用都够清晰；原文串重生成，内容与小翼Plus 读到的一致
    const png = await QRCode.toBuffer(payload, { type: 'png', width: 480, margin: 1, errorCorrectionLevel: 'M' });
    out.push({ ...base, valid: true, png });
  }
  return out;
}

/** 扫码清单 docx：两列格排（序号+金额+尾号+二维码大图），无效票红字标注占位不跳号 */
async function uploadBatchScanSheetDocx(batchNo, items) {
  const qrImages = await buildBatchQrImages(items);
  const cellOf = (q) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    margins: { top: 120, bottom: 120, left: 120, right: 120 },
    children: [
      new Paragraph({ children: [new TextRun({ text: `#${q.seq}　${q.amountText}　尾号 ${q.tail}`, bold: true, size: 22 })] }),
      ...(q.valid
        ? [new Paragraph({ spacing: { before: 60 }, children: [new ImageRun({ data: q.png, transformation: { width: 150, height: 150 } })] })]
        : [new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: `⚠️ ${q.note || '二维码不可重建，请扫纸质原件'}`, color: 'FF0000', size: 18 })] })]),
    ],
  });
  const rows = [];
  for (let i = 0; i < qrImages.length; i += 2) {
    rows.push(new TableRow({ children: [cellOf(qrImages[i]), qrImages[i + 1] ? cellOf(qrImages[i + 1]) : new TableCell({ children: [new Paragraph({ children: [] })] })] }));
  }
  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children: [
        new Paragraph({ children: [new TextRun({ text: `发票扫码清单 · 批次 ${batchNo}（${items.length} 张，严格按录入顺序）`, bold: true, size: 26 })] }),
        new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '录入小翼Plus/重大财务系统时按序号逐张扫码（顺序与打印件一致）；标 ⚠️ 的票请扫其纸质原件并对应序号补录。', size: 18, color: '666666' })] }),
        new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  const token = await client.uploadMediaToBitable(Buffer.from(buffer), `报销单_${batchNo}_扫码清单.docx`);
  return { token, scanItems: qrImages };
}

// ---------- 批次接取（审批群回复「接取」领取） ----------

/**
 * 接取批次：登记「接取人/接取时间」。不带批次号 = 接取最近锁定的未接取批次。
 * 仅【已锁定】可接取；已被他人接取报错（重复接取幂等返回）。
 * 全程全局锁（复查 P2-5）：查候选→写接取人之间有 await 点，两人并发「接取」
 * 会抢到同一批次；接取低频，全局串行化即可。
 */
async function claimBatch(batchNo, claimer = '') {
  return withLock('batch_claim', async () => {
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
  });
}

// ---------- 批次状态流转（已提交/已到账/已退回） ----------

// 合法流转表（复查 P1-3）：已锁定→已提交/已退回、已提交→已到账/已退回；
// 已到账/已退回为终态，拒绝任何再流转（防「已到账」批次再退回票入池造成重复报销）。
// 唯一例外：「已退回→已退回」幂等重入（见 markBatch 内 special-case，仅用于继续回票）
const BATCH_TRANSITIONS = {
  [collectStore.BATCH_STATUS.LOCKED]: [collectStore.BATCH_STATUS.SUBMITTED, collectStore.BATCH_STATUS.REJECTED],
  [collectStore.BATCH_STATUS.SUBMITTED]: [collectStore.BATCH_STATUS.PAID, collectStore.BATCH_STATUS.REJECTED],
  [collectStore.BATCH_STATUS.PAID]: [],
  [collectStore.BATCH_STATUS.REJECTED]: [],
};

/**
 * 批次状态变化通知发起人（2026-09-29 曼波定，队员侧闭环）：
 *   paid → 「你的申请已入账」；reject → 「批次被退回，发票已回池等下一批」。
 * 按申请编号聚合发票张数/金额；发起人取审批表「发起人」人员字段 id（open_id，
 * 与催发票私聊同源）。任何失败只记日志，绝不向状态机抛。
 */
async function notifyApplicantsOfBatch(batchNo, status) {
  const bot = require('../feishu/bot'); // 延迟 require：通知是可选增强，bot 失败不连坐批次
  try {
    const collects = (await collectStore.listCollect()).filter(r => String(r.fields['批次'] || '') === batchNo);
    const byApply = new Map();
    for (const r of collects) {
      const applyNo = String(r.fields['关联申请编号'] || '');
      if (!applyNo) continue;
      const raw = r.fields['价税合计'];
      const amt = typeof raw === 'number' ? raw : (parseFloat(String(raw ?? '').replace(/,/g, '')) || 0);
      const agg = byApply.get(applyNo) || { count: 0, amount: 0 };
      agg.count++;
      agg.amount = Math.round((agg.amount + amt) * 100) / 100;
      byApply.set(applyNo, agg);
    }
    if (!byApply.size) return { notified: 0 };

    const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
    const ownerByApplyNo = new Map();
    for (const rr of approvals) {
      const ff = rr.fields || {};
      const no = ff['申请编号'] ? (ff['申请编号'].text || String(ff['申请编号'])) : '';
      if (no) ownerByApplyNo.set(no, ff);
    }

    const isPaid = status === collectStore.BATCH_STATUS.PAID;
    let notified = 0, failed = 0, lastErr = '';
    for (const [applyNo, agg] of byApply) {
      const ff = ownerByApplyNo.get(applyNo) || {};
      const users = Array.isArray(ff['发起人']) ? ff['发起人'] : [];
      const openId = users[0] && users[0].id;
      if (!openId) continue;
      const amountText = `¥${agg.amount.toFixed(2)}`;
      const text = isPaid
        ? `💰 你的报销申请 ${applyNo}（发票 ${agg.count} 张合计 ${amountText}）已完成报销并入账，请留意到账情况～`
        : `⚠️ 你的报销申请 ${applyNo}（发票 ${agg.count} 张合计 ${amountText}）所在报销批次已被财务退回，发票已自动退回待处理池（无需重交，会随下一批重新生成报销单）。如有疑问请联系财务。`;
      try {
        await bot.sendTextToUser(openId, text);
        notified++;
      } catch (err) {
        failed++;
        lastErr = err.message;
      }
    }
    console.log(`[批次] ${batchNo} 发起人通知（${isPaid ? '到账' : '退回'}）：成功 ${notified} / 失败 ${failed}${lastErr ? `，最后错误: ${lastErr}` : ''}`);
    return { notified, failed };
  } catch (err) {
    console.error(`[批次] ${batchNo} 发起人通知失败（不影响状态流转）:`, err.message);
    return { notified: 0, failed: 0, error: err.message };
  }
}

async function markBatch(batchNo, status, operator = '') {
  // 全程按批次号加锁（复查 P1：校验 findBatchByName 与写入 updateBatch 之间有 await，
  // 并发 paid+reject 会各自通过状态机校验双成功；与 lockBatch 同 key 族互斥，
  // markBatch 内不再嵌套其他锁，无死锁环）
  return withLock(`batch_${batchNo}`, async () => {
    const batch = await collectStore.findBatchByName(batchNo);
    if (!batch) throw new Error(`批次不存在：${batchNo}`);
    // 状态机校验：非法流转直接拒绝（错误信息带当前状态与合法去向）
    const curStatus = batch.fields['状态'] || collectStore.BATCH_STATUS.LOCKED;
    // 「已退回→已退回」幂等重入（复查 P1-3）：仅用于继续回票——前次 reject 中途失败
    // （终态已写、部分票仍挂批次）时，可重发 reject 续回剩余票；已无本批次票则视为完成
    const reentry = curStatus === collectStore.BATCH_STATUS.REJECTED && status === collectStore.BATCH_STATUS.REJECTED;
    if (!reentry) {
      const allowed = BATCH_TRANSITIONS[curStatus];
      if (!allowed || !allowed.length || !allowed.includes(status)) {
        const to = (!allowed || !allowed.length) ? '无（终态，不可再流转）' : allowed.join('/');
        throw new Error(`批次 ${batchNo} 状态流转非法：当前【${curStatus}】，合法去向【${to}】，收到【${status}】`);
      }
    }
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

    // 已退回 → 该批次票清空「批次」标记自动回票池（与 /approval-batch 帮助文案一致——复查 P2-4）。
    // 逐票 try/catch 收集失败清单（复查 P1-3：此前循环无 catch，单票失败会永久卡死该批——
    // 失败票下次 reject 幂等重入续回）；审批表「报销单」栏一并清（失败不阻断回票）
    let returnedToPool = 0;
    const returnFailed = [];
    if (status === collectStore.BATCH_STATUS.REJECTED) {
      const collects = (await collectStore.listCollect()).filter(r => String(r.fields['批次'] || '') === batchNo);
      for (const r of collects) {
        try {
          await collectStore.updateCollect(r.record_id, { '批次': '' });
          returnedToPool++;
        } catch (err) {
          console.error(`[批次] 退回清批次标记失败（${r.fields['发票号码'] || r.record_id}）:`, err.message);
          returnFailed.push(String(r.fields['发票号码'] || r.record_id));
        }
      }
      const withApplyNo = collects.filter(r => String(r.fields['关联申请编号'] || ''));
      if (withApplyNo.length) {
        const approvals = await bitableApi.listAllRecords(config.bitable.approvalTableId);
        const recordByApplyNo = new Map();
        for (const rr of approvals) {
          const ff = rr.fields || {};
          const no = ff['申请编号'] ? (ff['申请编号'].text || String(ff['申请编号'])) : '';
          if (no) recordByApplyNo.set(no, rr);
        }
        for (const r of withApplyNo) {
          const applyNo = String(r.fields['关联申请编号'] || '');
          const hit = recordByApplyNo.get(applyNo);
          if (!hit) continue;
          try {
            await bitableApi.updateRecord(config.bitable.approvalTableId, hit.record_id, { '报销单': '' });
          } catch (err) {
            console.error(`[批次] 退回清审批表报销单栏失败（${applyNo}）:`, err.message);
            returnFailed.push(applyNo);
          }
        }
      }
      // 失败暴露进批次备注（复查 P1-3），幂等重入续回后自然收敛
      if (returnFailed.length) {
        try {
          const prevNote = String(batch.fields['备注'] || '');
          await collectStore.updateBatch(batch.record_id, {
            '备注': `${prevNote ? `${prevNote}；` : ''}${returnFailed.length} 张回票失败（${returnFailed.slice(0, 5).join('、')}${returnFailed.length > 5 ? '…' : ''}），可重发 reject 续回`,
          });
        } catch (err) {
          console.error('[批次] 回票失败备注回写失败:', err.message);
        }
      }
    }

    // 队员侧闭环（2026-09-29 曼波定）：paid 到账/reject 退票时私聊发起人（按申请聚合）；
    // 幂等重入（reject 续回）不重发。通知尽力而为，失败不阻断状态机
    if (!reentry && (status === collectStore.BATCH_STATUS.PAID || status === collectStore.BATCH_STATUS.REJECTED)) {
      await notifyApplicantsOfBatch(batchNo, status);
    }

    const f = batch.fields;
    const paidAt = fields['到账时间'] || f['到账时间'];
    return {
      batchNo,
      status,
      count: f['张数'],
      amount: typeof f['金额合计'] === 'number' ? f['金额合计'] : (parseFloat(f['金额合计']) || 0),
      returnedToPool,
      returnFailed,
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
  });
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

/** 批次推进超期（周报用，2026-09-29）：已锁定/已提交状态超过 days 天仍未到账的批次，最久在前 */
async function getStaleBatches(days = config.batch.staleDays) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const active = [collectStore.BATCH_STATUS.LOCKED, collectStore.BATCH_STATUS.SUBMITTED];
  return (await collectStore.listBatches())
    .filter(b => active.includes(b.fields['状态']))
    .filter(b => (Number(b.fields['锁定时间']) || 0) > 0 && Number(b.fields['锁定时间']) < cutoff)
    .map(b => ({
      batchNo: String(b.fields['批次号'] || ''),
      project: String(b.fields['项目'] || ''),
      count: b.fields['张数'] || 0,
      amount: typeof b.fields['金额合计'] === 'number' ? b.fields['金额合计'] : (parseFloat(b.fields['金额合计']) || 0),
      status: b.fields['状态'],
      lockedAt: Number(b.fields['锁定时间']),
      taker: String(b.fields['接取人'] || ''),
    }))
    .sort((a, b) => a.lockedAt - b.lockedAt);
}

module.exports = {
  getPoolWithRecords,
  previewBatch,
  lockBatch,
  isSpecialItem,
  markBatch,
  regenerateBatchFiles,
  batchOverview,
  uploadBatchPdf,
  uploadBatchDocx,
  uploadBatchSpecialSheetPdf,
  uploadBatchSpecialSheetDocx,
  uploadBatchBom,
  uploadBatchMaterialList,
  uploadBatchDeliverySheet,
  uploadBatchScanSheetDocx,
  buildBatchQrImages,
  claimBatch,
  composeSummary,
  buildArchiveFolderName,
  fmtDateMs,
};
