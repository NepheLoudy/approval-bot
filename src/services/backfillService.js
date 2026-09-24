/**
 * 存量发票回溯：审批表已交票（「发票」Url/「补交发票」附件）→ 审批实例接口下载原件 →
 * 三通道识别 → 回填采集表。存量 98+ 张已交票一次回溯，不必等队员重发。
 *
 * 口径：
 * - 审批记录报销单栏已有值 → 采集表「批次」同步该值（历史批次只记录不重建状态机，
 *   报销批次表只管机器人锁定之后的新批次）；
 * - 回溯票提交人=审批发起人；校验状态按常规闸（查重/金额比对），抬头配置空则跳过；
 * - 审批附件下载接口为探测式实现（client.downloadApprovalFile），首次运行即验证，
 *   路径有变改 client.js 候选清单。
 */
const config = require('../config');
const client = require('../feishu/client');
const approvalService = require('./approvalService');
const collectStore = require('./collectStore');
const ocrService = require('./ocrService');
const invoiceParser = require('./invoiceParser');

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

/**
 * 回溯执行。
 * @param {object} [options] {limit} 单次最多处理条数（默认 20，控制时长与限流）
 * @returns {object} {scanned, collected, skipped, failed, errors[]}
 */
async function backfillCollect(options = {}) {
  const limit = Math.min(parseInt(options.limit, 10) || 20, 100);
  const all = await approvalService.getAllApprovals();
  const collected = await collectStore.listCollect();
  const collectedApplyNos = new Set(collected.map(r => String(r.fields['关联申请编号'] || '')));

  // 候选：已通过 + 活跃流程 + 名下两栏有票 + 采集表无记录
  const candidates = all.filter((r) => {
    const f = r.fields || {};
    if (f['申请状态'] !== config.approvalStatus.APPROVED) return false;
    if (!approvalService.isActiveProcess(f)) return false;
    if (!approvalService.hasInvoiceSubmitted(f)) return false;
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    return applyNo && !collectedApplyNos.has(applyNo);
  });

  const result = { scanned: 0, collected: 0, skipped: 0, failed: 0, errors: [] };

  for (const record of candidates.slice(0, limit)) {
    const f = record.fields || {};
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : record.record_id;
    result.scanned++;

    const instanceId = String(f['SourceID'] || '');
    if (!instanceId) {
      result.skipped++;
      result.errors.push(`${applyNo}: 无 SourceID，无法定位审批实例`);
      continue;
    }

    try {
      const inst = await client.getApprovalInstance(instanceId);
      if (inst.code !== 0) throw new Error(`实例详情失败: ${inst.msg} (code: ${inst.code})`);
      let forms = inst.data?.form;
      if (typeof forms === 'string') {
        try { forms = JSON.parse(forms); } catch (e) { forms = []; }
      }
      const attachments = extractAttachmentRefs(forms);
      if (!attachments.length) {
        result.skipped++;
        result.errors.push(`${applyNo}: 实例表单未解析出附件引用`);
        continue;
      }

      // 逐附件识别，识别出第一张完整票即收录（一记录多票：其余票留待人工/后续补采）
      let matched = false;
      for (const att of attachments.slice(0, 3)) {
        let buffer;
        try {
          buffer = await client.downloadApprovalFile(instanceId, att.fileId);
        } catch (err) {
          result.errors.push(`${applyNo}: 附件下载失败 - ${err.message.slice(0, 120)}`);
          continue;
        }

        const parsed = await invoiceParser.recognizeInvoice(buffer, {}, (buf) => ocrService.recognizeBuffer(buf));
        if (!parsed.ok) {
          result.errors.push(`${applyNo}: 识别不完整（${parsed.reason}）`);
          continue;
        }
        if (matched) {
          result.errors.push(`${applyNo}: 多附件均含完整票面，仅收录第一张，其余请人工处理`);
          break;
        }

        const fields = parsed.fields;
        const dup = await collectStore.findByInvoiceNo(fields.invoiceNo);
        if (dup.length) {
          result.skipped++;
          result.errors.push(`${applyNo}: 发票号与采集表已有记录重复（尾号 ${String(fields.invoiceNo).slice(-6)}）`);
          matched = true; // 已有登记，不再尝试其余附件
          continue;
        }

        // 历史批次同步：审批记录「报销单」栏已有值 → 采集表批次=该值（不建批次表记录）
        const historyBatch = f['报销单'] ? String(f['报销单']) : '';
        // 金额比对（与 collectFromMessage 同口径）：超容差标「金额不符」，不恒写「通过」（复查 P2-3）
        let verifyStatus = '通过';
        const applyAmount = typeof f['总金额'] === 'number' ? f['总金额'] : null;
        const amountDiff = applyAmount !== null ? Math.round((fields.totalAmount - applyAmount) * 100) / 100 : null;
        if (applyAmount !== null) {
          const tol = Math.max(Math.abs(applyAmount) * config.invoiceCollect.amountToleranceRatio, config.invoiceCollect.amountToleranceFixed);
          if (Math.abs(amountDiff) > tol) verifyStatus = '金额不符';
        }
        const fileToken = await client.uploadMediaToBitable(buffer, `invoice_${fields.invoiceNo}.${buffer.slice(0, 4).toString('latin1') === '%PDF' ? 'pdf' : 'jpg'}`).catch(() => null);
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
          '提交人': (Array.isArray(f['发起人']) && f['发起人'][0]?.id) || 'backfill',
          ...(Array.isArray(f['发起人']) && f['发起人'][0]?.name ? { '提交人姓名': f['发起人'][0].name } : {}),
          '关联申请编号': applyNo,
          ...(applyAmount !== null ? { '申请金额': applyAmount } : {}),
          ...(amountDiff !== null ? { '金额差': amountDiff } : {}),
          '识别通道': parsed.source === 'qrcode+ocr' ? 'qrcode+ocr' : parsed.source,
          '校验状态': verifyStatus,
          ...(historyBatch ? { '批次': historyBatch } : {}),
          ...(fileToken ? { '发票图片': [{ file_token: fileToken }] } : {}),
          '采集时间': Date.now(),
          '备注': '存量回溯',
        });
        result.collected++;
        matched = true;
      }
      if (!matched) {
        result.skipped++;
      }
    } catch (err) {
      result.failed++;
      result.errors.push(`${applyNo}: ${err.message.slice(0, 160)}`);
    }
  }

  return result;
}

module.exports = { backfillCollect, extractAttachmentRefs };
