/**
 * 存量发票回溯（approval_code 驱动，2026-09-25 真机演练后重构）：
 *
 * 真机实测结论（演练 drill-online.js）：
 * - 审批表「SourceID」是飞书内部复合格式（解码为 <串>:<UUID>-<n>:<hash>:1），
 *   拿它调 GET /approval/v4/instances/:id 报 1390003 instance code not found——
 *   表格 SourceID 不是审批 OpenAPI 的 instance_id，此路不通；
 * - 正确链路：APPROVAL_CODE（审批定义 code，飞书审批管理后台 → 流程详情获取，一次性配置）
 *   → POST /approval/v4/instances/query 批量拉实例（instance.code + instance.serial_id）
 *   → GET /approval/v4/instances/:code 实例详情（form 附件引用 + user_id + start_time）
 *   → 下载附件识别 → 优先「serial_id == 表格申请编号」精确回填，
 *     未命中回落「发起人 + 发起时间±3天窗 + 发票金额 vs 申请金额精确」模糊匹配。
 *
 * 2026-10-17 枚举链校准（工单定义 code 实测，勿回退）：
 *   - 旧实现 GET /approval/v4/instances 读 `instance_ids` + 秒级 start/end——实测响应字段
 *     实为 instance_code_list、时间窗实为毫秒，三口径全错 → 枚举恒空，backfill 静默零处理；
 *   - 换 POST /instances/query 后实测：时间参数 instance_start_time_from/to 毫秒、
 *     单次跨度上限 30 天（31 天报 1390001）、分页 has_more + page_token、
 *     实例摘要含 serial_id（审批编号 == 表格「申请编号」，如 202610160001）。
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

/** 从实例详情 form 中抽取发票附件引用。
 *  实测结构（2026-10-17，采购流程实例 form 为控件数组 {id,name,type,ext,value}）：
 *  发票控件 type=attachmentV2、name=发票、value=[免登下载直链]（internal-api-drive-stream
 *  .../download/authcode?code=…，裸 GET 即得文件本体，实测 JPEG 313KB）；
 *  「示意图」为 image 类型控件（非 attachmentV2），不抓。
 *  旧假设的 file_id/file_code 对象结构保留为最末兜底（兼容其它流程/版本）。
 * @returns {Array<{url?: string, fileId?: string, name: string}>}
 */
function extractAttachmentRefs(formValue) {
  const found = [];
  let items = formValue;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (e) { items = []; }
  }

  // 1) 发票附件控件直链（name/标题含「发票」）
  if (Array.isArray(items)) {
    for (const ctl of items) {
      if (!ctl || typeof ctl !== 'object') continue;
      const name = String(ctl.name || ctl.title || '');
      if (String(ctl.type) === 'attachmentV2' && /发票/.test(name) && Array.isArray(ctl.value)) {
        for (const u of ctl.value) {
          if (typeof u === 'string' && /^https?:\/\//.test(u)) found.push({ url: u, name });
        }
      }
    }
  }
  if (found.length) return found;

  // 2) 宽松兜底：任意 attachmentV2 控件的直链（name 未命中「发票」时；image 控件不抓）
  if (Array.isArray(items)) {
    for (const ctl of items) {
      if (ctl && String(ctl.type) === 'attachmentV2' && Array.isArray(ctl.value)) {
        for (const u of ctl.value) {
          if (typeof u === 'string' && /^https?:\/\//.test(u)) found.push({ url: u, name: String(ctl.name || '') });
        }
      }
    }
  }
  if (found.length) return found;

  // 3) file_id/file_code 对象递归（旧结构兜底）
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
  visit(items);
  return found;
}

/** 附件直链下载（attachmentV2 value 的 authcode 免登直链，裸 GET 即得文件本体；20s 超时） */
async function downloadByUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    let msg = ct;
    try {
      const b = await res.json();
      msg = `${b.code || res.status}: ${b.msg || ''}`;
    } catch (e) { /* 非 JSON */ }
    throw new Error(`直链返回 JSON（疑似失效/受限）: ${msg}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 批量拉取审批实例（code + 申请编号 serial_id）：毫秒时间窗 30 天分片、片内翻页。
 *  接口口径见文件头「2026-10-17 枚举链校准」注释。 */
async function listInstances(approvalCode, sinceMs) {
  const out = [];
  const CHUNK = 30 * DAY_MS; // 接口硬限制：单次查询跨度不得超过 30 天（1390001）
  const now = Date.now();
  let start = sinceMs;
  while (start < now) {
    const end = Math.min(start + CHUNK, now);
    let pageToken = '';
    do {
      // page_token 必须走 query string（2026-10-17 实测：放 body 被忽略 → 恒返回第 1 页
      // 且 has_more 恒 true，翻页死循环）
      const res = await client.requestAPI(
        'POST',
        `/approval/v4/instances/query${pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ''}`,
        {
          approval_code: approvalCode,
          instance_start_time_from: start,
          instance_start_time_to: end,
          page_size: 100,
        }
      );
      if (res.code === 1390002) throw new Error('approval code not found（APPROVAL_CODE 配置有误）');
      if (res.code !== 0) throw new Error(`批量获取审批实例失败: ${res.msg} (code: ${res.code})`);
      for (const item of res.data?.instance_list || []) {
        const inst = item.instance || {};
        if (inst.code) out.push({ code: String(inst.code), serialId: String(inst.serial_id || ''), status: inst.status || '' });
      }
      pageToken = res.data?.has_more ? res.data.page_token : '';
    } while (pageToken);
    start = end;
  }
  return out;
}

/**
 * 回溯执行（APPROVAL_CODE 未配置时直接报错并给指引）。
 * @param {object} [options] {limit, sinceDays} 单次最多处理实例数（默认 20）、回溯天数（默认 200）
 * @returns {object} {scanned, collected, skipped, failed, errors[]}
 */
let backfillRunning = false; // 重入闸（对抗审查 P3-4）：并发触发会重复跑 OCR/下载白烧配额
async function backfillCollect(options = {}) {
  if (backfillRunning) {
    const err = new Error('上一轮回溯仍在执行中，请稍后再试（防并发重复跑 OCR/下载）');
    err.statusCode = 429;
    throw err;
  }
  backfillRunning = true;
  try {
    return await doBackfillCollect(options);
  } finally {
    backfillRunning = false;
  }
}

async function doBackfillCollect(options = {}) {
  const approvalCode = process.env.APPROVAL_CODE || '';
  if (!approvalCode) {
    const err = new Error('未配置 APPROVAL_CODE（审批定义 code）：请在飞书审批管理后台打开「采购申请/发票提交」流程详情获取，配入 .env 后重试');
    err.statusCode = 400;
    throw err;
  }

  const limit = Math.min(parseInt(options.limit, 10) || 20, 100);
  const sinceDays = Math.min(parseInt(options.sinceDays, 10) || 200, 365);
  // 定向补采（2026-10-17，制单金额线锁定前用）：只处理指定项目的候选记录
  const onlyProjects = Array.isArray(options.onlyProjects) && options.onlyProjects.length
    ? new Set(options.onlyProjects) : null;
  // 按发起人定向补采（2026-10-27 分组维度改人名）：匹配审批记录「发起人」第一人姓名
  const onlyPersons = Array.isArray(options.onlyPersons) && options.onlyPersons.length
    ? new Set(options.onlyPersons) : null;
  // 指定申请补收（2026-10-20 漏票修复用）：允许「已采集过」的申请重新参与候选——
  // 一申请多张票时此前只收到部分，补收时按发票号查重跳过已收，只补缺失附件
  const includeApplyNos = new Set(Array.isArray(options.includeApplyNos) ? options.includeApplyNos : []);

  // 表格侧候选：已通过 + 活跃流程 + 已交票 + 采集表无记录（与旧骨架一致）
  const all = await approvalService.getAllApprovals();
  const collected = await collectStore.listCollect();
  const collectedApplyNos = new Set(collected.map(r => String(r.fields['关联申请编号'] || '')));
  const candidates = all.filter((r) => {
    const f = r.fields || {};
    if (f['申请状态'] !== config.approvalStatus.APPROVED) return false;
    if (!approvalService.isActiveProcess(f)) return false;
    if (!approvalService.hasInvoiceSubmitted(f)) return false;
    if (onlyProjects) {
      const project = f['项目'] ? (f['项目'].name || String(f['项目'])) : '未归类';
      if (!onlyProjects.has(project)) return false;
    }
    if (onlyPersons) {
      const person = (Array.isArray(f['发起人']) && f['发起人'][0]?.name) || '';
      if (!person || !onlyPersons.has(person)) return false;
    }
    const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
    return applyNo && (!collectedApplyNos.has(applyNo) || includeApplyNos.has(applyNo));
  });
  if (!candidates.length) return { scanned: 0, collected: 0, skipped: 0, failed: 0, errors: ['没有待回填的表格记录'] };

  const instances = await listInstances(approvalCode, Date.now() - sinceDays * DAY_MS);
  // serial_id（= 表格「申请编号」）→ 候选记录：编号精确匹配索引（2026-10-17 校准升级；
  // 旧「同人 + 发起时间±3天窗 + 金额精确」保留为 fallback，兜 serial 缺失的实例）
  const candByApplyNo = new Map();
  for (const r of candidates) {
    const applyNo = r.fields['申请编号'] ? (r.fields['申请编号'].text || String(r.fields['申请编号'])) : '';
    if (applyNo) candByApplyNo.set(applyNo, r);
  }
  // 报销单号 → 批次映射（2026-10-20 迟到票归属）：以批次表「报销单号」列为准
  const formNoToBatch = new Map();
  try {
    for (const b of await collectStore.listBatches()) {
      const no = String((b.fields || {})['报销单号'] || '');
      if (no) formNoToBatch.set(no, { batchNo: String(b.fields['批次号'] || ''), confirmed: Number(b.fields['交付确认时间'] || 0) > 0 });
    }
  } catch (mapErr) {
    console.warn('[回溯] 批次表报销单号映射读取失败（迟到票按历史标签处理）:', mapErr.message);
  }
  const result = { scanned: 0, collected: 0, skipped: 0, failed: 0, errors: [], totalInstances: instances.length };

  for (const inst of instances) {
    const instanceId = inst.code;
    if (result.collected >= limit) break;
    // 快速跳过：serial 已分配但不在候选（已采集/不在待办名单）的实例不拉详情——省配额
    if (inst.serialId && !candByApplyNo.has(inst.serialId)) continue;
    result.scanned++;

    let detail;
    try {
      detail = await client.getApprovalInstance(instanceId);
      if (detail.code !== 0) throw new Error(`${detail.msg} (code: ${detail.code})`);
    } catch (err) {
      result.failed++;
      result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: ${err.message.slice(0, 120)}`);
      continue;
    }

    const userId = detail.data?.user_id || '';
    const createTimeMs = (parseInt(detail.data?.start_time, 10) || 0) * 1000;
    let forms = detail.data?.form;
    if (typeof forms === 'string') {
      try { forms = JSON.parse(forms); } catch (err) { forms = []; }
    }
    const attachments = extractAttachmentRefs(forms);
    if (!attachments.length) continue;

    // 匹配表格记录（2026-10-17 校准升级）：优先 serial_id（审批编号 == 表格「申请编号」）
    // 精确命中；未命中再回落旧链「同人 + 发起时间 ±3 天窗」模糊匹配。
    // 时间缺失不放宽为「同人全量」（复查 P2-11：宽匹配会把票错配到同人其他申请）——
    // serial 未命中且任一侧时间缺失即跳过该实例转人工，绝不盲配
    const serialHit = inst.serialId ? candByApplyNo.get(inst.serialId) : null;
    let window;
    if (serialHit) {
      window = [serialHit];
    } else {
      if (!createTimeMs) {
        console.warn(`[回溯] 实例 ${String(instanceId).slice(0, 16)}…: 实例缺发起时间，跳过转人工`);
        continue;
      }
      window = candidates.filter((r) => {
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
    }

    // 逐附件识别 → 发票金额在窗口内精确匹配唯一记录 → 回填（复用金额匹配语义）
    let matchedAny = false;
    // 全量附件（2026-10-20 实案：一申请挂 8 张发票，原 slice(0,3) 只处理前 3 个 → 漏票；
    // 重装 1017 四申请共 11 张只收 4 张）。上限 20 防异常大附件列表。
    for (const att of attachments.slice(0, 20)) {
      if (result.collected >= limit) break;
      let buffer;
      try {
        buffer = att.url
          ? await downloadByUrl(att.url) // attachmentV2 免登直链（URL 随取随用，无过期顾虑）
          : await client.downloadApprovalFile(instanceId, att.fileId);
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
      let hit;
      if (serialHit) {
        // serial 精确命中：编号唯一即锚定，不要求票面金额与申请金额相等
        // （差额经「金额差」字段入表可见，校验状态按容差判定）
        hit = serialHit;
      } else {
        // 模糊链唯一匹配断言（对抗审查 P1-1：原 find 永取第一条，同人同额多申请会静默错配，
        // 票随批次错报销）——命中数 ≠1 一律转人工，与 ledger ambiguous 口径对齐
        const hits = window.filter((r) => {
          const amt = typeof r.fields['总金额'] === 'number' ? r.fields['总金额'] : parseFloat(r.fields['总金额']);
          return amt !== null && !Number.isNaN(amt) && Math.abs(amt - fields.totalAmount) < 0.01;
        });
        if (hits.length > 1) {
          result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 发票 ¥${fields.totalAmount} 在同人时间窗内命中 ${hits.length} 条同额申请（ambiguous），转人工`);
          continue;
        }
        hit = hits[0];
        if (!hit) {
          result.errors.push(`实例 ${String(instanceId).slice(0, 16)}…: 发票 ¥${fields.totalAmount} 在同人时间窗内无金额精确匹配的记录，转人工`);
          continue;
        }
      }

      // 查重双闸 + 落表整体按发票号加锁（复查 P2：与实时采集同双闸——backfill 与 hub
      // 实时采集并发时，各自通过查重后再各自落一条重复票；三元组近似闸同 invoiceCollectService）
      const hf = hit.fields || {};
      const applyNo = hf['申请编号'] ? (hf['申请编号'].text || String(hf['申请编号'])) : hit.record_id;
      const applyAmount = typeof hf['总金额'] === 'number' ? hf['总金额'] : (parseFloat(hf['总金额']) || null);
      const amountDiff = applyAmount !== null ? Math.round((fields.totalAmount - applyAmount) * 100) / 100 : null;
      // 迟到票归属（2026-10-20）：报销单值命中批次表「报销单号」→ 机器人批次——
      // 未确认批次（交付件未生成，可安全追加）批次列直接写批次号并入该批；
      // 已确认批次 → 批次留空进池走下一批；人工历史标签 → 保持原值（历史批次标记=出池）
      const historyBatchRaw = hf['报销单'] ? String(hf['报销单']) : '';
      let historyBatch = historyBatchRaw;
      if (historyBatchRaw) {
        const mapped = formNoToBatch.get(historyBatchRaw);
        if (mapped) historyBatch = mapped.confirmed ? '' : mapped.batchNo;
      }
      const outcome = await withRecordLock(`inv_${fields.invoiceNo}`, async () => {
        const dupExact = await collectStore.findByInvoiceNo(fields.invoiceNo);
        if (dupExact.length) return { kind: 'dup_exact' };
        const dupSimilar = await collectStore.findBySimilarity({ issueDate: fields.issueDate, totalAmount: fields.totalAmount, sellerTaxNo: fields.sellerTaxNo });
        if (dupSimilar.length) return { kind: 'dup_similar' };
        const magic = buffer.slice(0, 4);
        const ext = magic.toString('latin1') === '%PDF' ? 'pdf' : (magic[0] === 0x89 && magic[1] === 0x50 ? 'png' : 'jpg');
        const fileToken = await client.uploadMediaToBitable(buffer, `invoice_${fields.invoiceNo}.${ext}`).catch(() => null);
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
          // 二维码原文（扫码清单重生成同源；qrcode/渲染通道识别时携带）——与实时采集同口径
          ...(parsed.qrPayload ? { '二维码内容': String(parsed.qrPayload) } : {}),
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
      // 从候选与编号索引移除已回填记录（防同一记录被多个实例/多附件重复回填）
      const idx = candidates.indexOf(hit);
      if (idx >= 0) candidates.splice(idx, 1);
      if (inst.serialId) candByApplyNo.delete(inst.serialId);
    }
    // 多票同申请聚合校验（2026-10-20 实案：一申请挂 8 张票，单票 vs 申请金额必「金额不符」）：
    // 该实例全部附件处理完后，按「该申请下采集票票面合计 vs 申请金额」统一回写校验状态
    if (matchedAny && serialHit) {
      const hf2 = serialHit.fields || {};
      const applyNo2 = hf2['申请编号'] ? (hf2['申请编号'].text || String(hf2['申请编号'])) : String(inst.serialId || '');
      const applyAmount2 = typeof hf2['总金额'] === 'number' ? hf2['总金额'] : (parseFloat(String(hf2['总金额'] ?? '').replace(/,/g, '')) || null);
      try {
        await reconcileApplyAmount(applyNo2, applyAmount2);
      } catch (aggErr) {
        console.warn(`[回溯] 多票聚合校验失败（${applyNo2}）:`, aggErr.message);
      }
    }
    if (!matchedAny) result.skipped++;
  }

  // 回溯落表后即时触发制单金额线检查（同采集钩子口径：过静默闸、夜间顺延补跑；
  // 测试环境 FORM_ALERT_DISABLED=1 自跳过）——回溯后无需干等次日 10:35 兜底。
  // noFormAlert：制单金额线「锁定前补采」调用时置位——防 checkAndBroadcast→补采→触发 递归
  if (result.collected > 0 && !options.noFormAlert) {
    try {
      // 延迟 require：formAlertService 顶部连着 batchService 重依赖（同 invoiceCollectService 口径）
      const formAlertService = require('./formAlertService');
      formAlertService.triggerAfterCollect();
    } catch (err) {
      console.warn('[回溯] 制单金额线即时检查触发失败（不影响回溯结果）:', err.message);
    }
  }

  return result;
}

/** 多票同申请聚合校验：该申请下全部采集票票面合计在容差内 → 各票校验状态=通过
 *  （否则金额不符）。一申请多张票时单票金额必然 ≠ 申请金额，逐票判定会全部误标异常
 *  （2026-10-20 实案：202610050001 挂 8 张票合计 188.82，单票 53.43 被判金额不符）。 */
async function reconcileApplyAmount(applyNo, applyAmount) {
  if (!applyNo || applyAmount === null || applyAmount === undefined || Number.isNaN(applyAmount)) return;
  const list = await collectStore.listCollect();
  const rows = list.filter(r => String(r.fields['关联申请编号'] || '') === String(applyNo));
  if (rows.length < 2) return; // 单票申请走落表时点判定
  let sum = 0;
  for (const r of rows) {
    const v = parseFloat(String(r.fields['价税合计'] ?? '').replace(/,/g, ''));
    if (!Number.isNaN(v)) sum += v;
  }
  const status = verifyStatusFor(sum, applyAmount);
  for (const r of rows) {
    if (String(r.fields['校验状态'] || '') !== status) {
      await collectStore.updateCollect(r.record_id, { '校验状态': status });
    }
  }
}

function verifyStatusFor(invoiceAmount, applyAmount) {
  if (applyAmount === null) return '待人工';
  const diff = Math.abs(invoiceAmount - applyAmount);
  const tol = Math.max(Math.abs(applyAmount) * config.invoiceCollect.amountToleranceRatio, config.invoiceCollect.amountToleranceFixed);
  return diff > tol ? '金额不符' : '通过';
}

module.exports = { backfillCollect, extractAttachmentRefs, listInstances };
