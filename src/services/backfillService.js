/**
 * 存量发票回溯（approval_code 驱动，2026-09-25 真机演练后重构）：
 *
 * 真机实测结论（演练 drill-online.js）：
 * - 审批表「SourceID」是飞书内部复合格式（解码为 <串>:<UUID>-<n>:<hash>:1），
 *   拿它调 GET /approval/v4/instances/:id 报 1390003 instance code not found——
 *   表格 SourceID 不是审批 OpenAPI 的 instance_id，此路不通；
 * - 正确链路：APPROVAL_CODE（审批定义 code，飞书审批管理后台 → 流程详情获取，一次性配置）
 *   → GET /approval/v4/instances?approval_code&start_time&end_time 批量拉 instance_id
 *   → GET /approval/v4/instances/:id 实例详情（form 附件引用 + user_id + create_time）
 *   → 下载附件识别 → 「发起人 + 发起时间±3天窗 + 发票金额 vs 申请金额精确」匹配表格记录回填。
 *
 * 未配置 APPROVAL_CODE 时 backfill 返回清晰指引，不做任何写入。
 */
const config = require('../config');
const client = require('../feishu/client');
const approvalService = require('./approvalService');
const collectStore = require('./collectStore');
const ocrService = require('./ocrService');
const invoiceParser = require('./invoiceParser');
// 复用实时采集的按发票号串行锁（复查 P2：backfill 与 hub 实时采集并发时两边都要过同一把锁）
const { withRecordLock } = require('./invoiceCollectService');

const DAY_MS = 24 * 3600 * 1000;

/** 从实例详情 form 中递归抽取附件引用 [{file_id, name}]（控件 value 结构随版本有差异，宽容解析） */
function extractAttachmentRefs(formValue) {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const fileId = node.file_id || node.fileId || node.file_code || node.fileCode;
    if (fileId && typeof fileId === 'string') {
      found.push({ fileId, name: node.name || '' });
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(formValue);
  return found;
}

/** 批量拉取审批实例 ID（时间窗自动分片翻页；接口要求 start/end 为秒且跨度受限） */
async function listInstanceIds(approvalCode, sinceMs) {
  const ids = [];
  const CHUNK = 30 * DAY_MS / 1000; // 30 天一片（飞书限单次跨度）
  let start = Math.floor(sinceMs / 1000);
  const now = Math.floor(Date.now() / 1000);
  while (start < now) {
    const end = Math.min(start + CHUNK, now);
    let pageToken = '';
    do {
      const q = new URLSearchParams({
        approval_code: approvalCode,
        start_time: String(start),
        end_time: String(end),
        page_size: '100',
      });
      if (pageToken) q.set('page_token', pageToken);
      const res = await client.requestAPI('GET', `/approval/v4/instances?${q.toString()}`);
      if (res.code === 1390002) throw new Error('approval code not found（APPROVAL_CODE 配置有误）');
      if (res.code !== 0) throw new Error(`批量获取实例 ID 失败: ${res.msg} (code: ${res.code})`);
      ids.push(...(res.data?.instance_ids || []));
      pageToken = res.data?.has_more ? res.data.page_token : '';
    } while (pageToken);
    start = end;
  }
  return ids;
}

/**
 * 回溯执行（APPROVAL_CODE 未配置时直接报错并给指引）。
 * @param {object} [options] {limit, sinceDays} 单次最多处理实例数（默认 20）、回溯天数（默认 200）
 * @returns {object} {scanned, collected, skipped, failed, errors[]}
 */
async function backfillCollect(options = {}) {
  const approvalCode = process.env.APPROVAL_CODE || '';
  if (!approvalCode) {
    const err = new Error('未配置 APPROVAL_CODE（审批定义 code）：请在飞书审批管理后台打开「采购申请/发票提交」流程详情获取，配入 .env 后重试');
    err.statusCode = 400;
    throw err;
  }

  const limit = Math.min(parseInt(options.limit, 10) || 20, 100);
  const sinceDays = Math.min(parseInt(options.sinceDays, 10) || 200, 365);

  // 表格侧候选：已通过 + 活跃流程 + 已交票 + 采集表无记录（与旧骨架一致）
  const all = await approvalService.getAllApprovals();
  const collected = await collectStore.listCollect();
  const collectedApplyNos = new Set(collected.map(r => String(r.fields['关联申请编号'] || '')));
  const candidates = all.filter((r) => {
    const f = r.fields || {};
    if (f['申请状态'] !== config.approvalStatus.APPROVED) return false;
    if (!approvalService.isActiveProcess(f)) return false;
    if (!approvalService.hasInvoiceSubmitted(f)) return false;
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    return applyNo && !collectedApplyNos.has(applyNo);
  });
  if (!candidates.length) return { scanned: 0, collected: 0, skipped: 0, failed: 0, errors: ['没有待回填的表格记录'] };

  const instanceIds = await listInstanceIds(approvalCode, Date.now() - sinceDays * DAY_MS);
  const result = { scanned: 0, collected: 0, skipped: 0, failed: 0, errors: [], totalInstances: instanceIds.length };

  for (const instanceId of instanceIds) {
    if (result.collected >= limit) break;
    result.scanned++;

    let inst;
    try {
      inst = await client.getApprovalInstance(instanceId);
      if (inst.code !== 0) throw new Error(`${inst.msg} (code: ${inst.code})`);
    } catch (err) {
      result.failed++;
      result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: ${err.message.slice(0, 120)}`);
      continue;
    }

    const userId = inst.data?.user_id || '';
    const createTimeMs = (parseInt(inst.data?.start_time, 10) || 0) * 1000;
    let forms = inst.data?.form;
    if (typeof forms === 'string') {
      try { forms = JSON.parse(forms); } catch (err) { forms = []; }
    }
    const attachments = extractAttachmentRefs(forms);
    if (!attachments.length) continue;

    // 匹配表格记录：同一发起人 + 发起时间 ±3 天窗内（实例 start_time vs 表格「发起时间」）。
    // 时间缺失不再放宽为「同人全量」（复查 P2-11：宽匹配会把票错配到同人其他申请）——
    // 任一侧时间缺失即跳过该实例转人工，绝不盲配
    if (!createTimeMs) {
      console.warn(`[回溯] 实例 ${String(instanceId).slice(0, 16)}…: 实例缺发起时间，跳过转人工`);
      continue;
    }
    const window = candidates.filter((r) => {
      const f = r.fields || {};
      const uid = Array.isArray(f['发起人']) ? f['发起人'][0]?.id : '';
      if (userId && uid && uid !== userId) return false;
      const launch = typeof f['发起时间'] === 'number' ? f['发起时间'] : parseInt(f['发起时间'], 10);
      if (!launch) {
        console.warn(`[回溯] 实例 ${String(instanceId).slice(0, 16)}…: 候选记录 ${r.record_id} 缺「发起时间」，不参与匹配（转人工）`);
        return false;
      }
      return Math.abs(launch - createTimeMs) <= 3 * DAY_MS;
    });
    if (!window.length) continue;

    // 逐附件识别 → 发票金额在窗口内精确匹配唯一记录 → 回填（复用金额匹配语义）
    let matchedAny = false;
    for (const att of attachments.slice(0, 3)) {
      if (result.collected >= limit) break;
      let buffer;
      try {
        buffer = await client.downloadApprovalFile(instanceId, att.fileId);
      } catch (err) {
        result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 附件下载失败 - ${err.message.slice(0, 100)}`);
        continue;
      }
      const parsed = await invoiceParser.recognizeInvoice(buffer, {}, (buf) => ocrService.recognizeBuffer(buf));
      if (!parsed.ok || !parsed.fields.invoiceNo) {
        result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 识别不完整（${parsed.reason || '未知'}）`);
        continue;
      }
      const fields = parsed.fields;
      const hit = window.find((r) => {
        const amt = typeof r.fields['总金额'] === 'number' ? r.fields['总金额'] : parseFloat(r.fields['总金额']);
        return amt !== null && !Number.isNaN(amt) && Math.abs(amt - fields.totalAmount) < 0.01;
      });
      if (!hit) {
        result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 发票 ¥${fields.totalAmount} 在同人时间窗内无金额精确匹配的记录，转人工`);
        continue;
      }

      // 查重双闸 + 落表整体按发票号加锁（复查 P2：与实时采集同双闸——backfill 与 hub
      // 实时采集并发时，各自通过查重后再各自落一条重复票；三元组近似闸同 invoiceCollectService）
      const hf = hit.fields || {};
      const applyNo = hf['申请编号'] ? (hf['申请编号'].text || String(hf['申请编号'])) : hit.record_id;
      const applyAmount = typeof hf['总金额'] === 'number' ? hf['总金额'] : (parseFloat(hf['总金额']) || null);
      const amountDiff = applyAmount !== null ? Math.round((fields.totalAmount - applyAmount) * 100) / 100 : null;
      const historyBatch = hf['报销单'] ? String(hf['报销单']) : '';
      const outcome = await withRecordLock(`inv_${fields.invoiceNo}`, async () => {
        const dupExact = await collectStore.findByInvoiceNo(fields.invoiceNo);
        if (dupExact.length) return { kind: 'dup_exact' };
        const dupSimilar = await collectStore.findBySimilarity({ issueDate: fields.issueDate, totalAmount: fields.totalAmount, sellerTaxNo: fields.sellerTaxNo });
        if (dupSimilar.length) return { kind: 'dup_similar' };
        const fileToken = await client.uploadMediaToBitable(buffer, `invoice_${fields.invoiceNo}.pdf`).catch(() => null);
        await collectStore.createCollect({
          '发票号码': fields.invoiceNo,
          ...(fields.invoiceCode ? { '发票代码': fields.invoiceCode } : {}),
          '票种': parsed.invoiceType || 'unknown',
          ...(fields.issueDate ? { '开票日期': Math.floor(new Date(fields.issueDate + 'T00:00:00+08:00').getTime()) } : {}),
          '价税合计': fields.totalAmount,
          ...(fields.buyerName ? { '购买方名称': fields.buyerName } : {}),
          ...(fields.buyerTaxNo ? { '购买方税号': fields.buyerTaxNo } : {}),
          ...(fields.sellerName ? { '销售方名称': fields.sellerName } : {}),
          ...(fields.sellerTaxNo ? { '销售方税号': fields.sellerTaxNo } : {}),
          ...(fields.checkCode ? { '校验码后6位': fields.checkCode } : {}),
          '提交人': (Array.isArray(hf['发起人']) && hf['发起人'][0]?.id) || userId || 'backfill',
          ...(Array.isArray(hf['发起人']) && hf['发起人'][0]?.name ? { '提交人姓名': hf['发起人'][0].name } : {}),
          '关联申请编号': applyNo,
          ...(applyAmount !== null ? { '申请金额': applyAmount } : {}),
          ...(amountDiff !== null ? { '金额差': amountDiff } : {}),
          '识别通道': parsed.source === 'qrcode+ocr' ? 'qrcode+ocr' : parsed.source,
          '校验状态': verifyStatusFor(fields.totalAmount, applyAmount),
          ...(historyBatch ? { '批次': historyBatch } : {}),
          ...(fileToken ? { '发票图片': [{ file_token: fileToken }] } : {}),
          '采集时间': Date.now(),
          '备注': '存量回溯',
        });
        return { kind: 'created' };
      });
      if (outcome.kind === 'dup_exact') { matchedAny = true; continue; }
      if (outcome.kind === 'dup_similar') {
        result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 发票尾号 ${String(fields.invoiceNo).slice(-6)} 三元组近似命中已收发票（疑似重复/发票号错位），转人工`);
        matchedAny = true;
        continue;
      }
      result.collected++;
      matchedAny = true;
      // 从候选中移除已回填记录（防同一记录被多个实例重复回填）
      const idx = candidates.indexOf(hit);
      if (idx >= 0) candidates.splice(idx, 1);
    }
    if (!matchedAny) result.skipped++;
  }

  return result;
}

function verifyStatusFor(invoiceAmount, applyAmount) {
  if (applyAmount === null) return '待人工';
  const diff = Math.abs(invoiceAmount - applyAmount);
  const tol = Math.max(Math.abs(applyAmount) * config.invoiceCollect.amountToleranceRatio, config.invoiceCollect.amountToleranceFixed);
  return diff > tol ? '金额不符' : '通过';
}

module.exports = { backfillCollect, extractAttachmentRefs, listInstanceIds };
