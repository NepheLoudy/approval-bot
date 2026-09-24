/**
 * 发票采集服务：私聊/催办回复交票 → 三通道识别 → 校验闸 → 金额归类匹配 → 落表 → 回执/打回。
 *
 * 口径铁律：
 * - 采集表为唯一真源；审批表「补交发票」栏只是财务可见的镜像（采集成功时回写附件，
 *   先读后 append + 按记录串行防并发丢图，duty-bot expressService 同款经验）；
 * - 「发票」与「补交发票」栏等价（hasInvoiceSubmitted 两栏任一有值即已交），本服务
 *   只写「补交发票」栏——「发票」栏是审批系统管理的 Url 形态，且修改审批仅一次机会；
 * - 队员交票后不会自行修改审批（曼波 2026-09-25 确认），镜像被覆盖的风险可忽略。
 */
const config = require('../config');
const client = require('../feishu/client');
const bot = require('../feishu/bot');
const approvalService = require('./approvalService');
const collectStore = require('./collectStore');
const ocrService = require('./ocrService');
const invoiceParser = require('./invoiceParser');

// 查重/回写附件的按记录串行锁（附件字段整列覆盖，并发读改写会互相丢图）
const recordLocks = new Map();
async function withRecordLock(key, fn) {
  const prev = recordLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  recordLocks.set(key, run.catch(() => {}));
  return run;
}

const MISSING_LABELS = { invoiceNo: '发票号码', issueDate: '开票日期', totalAmount: '价税合计' };

/** 解析抬头配置（「名称|税号」逗号分隔）→ [{name, taxNo}] */
function parseAllowedBuyers() {
  return (config.invoiceCollect.allowedBuyers || []).map((raw) => {
    const [name, taxNo] = raw.split('|').map(s => (s || '').trim());
    return { name, taxNo };
  }).filter(x => x.name || x.taxNo);
}

/** 抬头校验：配置为空=不校验（通过）；购买方名称或税号命中任一套即通过 */
function checkBuyer(fields) {
  const allowed = parseAllowedBuyers();
  if (!allowed.length) return { status: null, note: '未配置抬头校验' };
  const hit = allowed.find(a =>
    (a.taxNo && fields.buyerTaxNo && fields.buyerTaxNo === a.taxNo) ||
    (a.name && fields.buyerName && fields.buyerName.includes(a.name)));
  return hit
    ? { status: null, note: null }
    : { status: '抬头存疑', note: `购买方「${fields.buyerName || '?'}${fields.buyerTaxNo ? '/' + fields.buyerTaxNo : ''}」不在报销抬头白名单` };
}

/**
 * 名下可归类记录：已通过 + 活跃流程 + 两栏均未交票 + 采集台账未收录
 * （「发票/补交发票/采集台账」三口径等价——同队员连续交多张票时，
 *   先交的已进台账，不再作为候选干扰后续归类）。
 * 返回 [{record_id, applyNo, amount, material, project, senderName}]
 */
async function listOpenRecordsByOpenId(openId) {
  const collectedNos = await approvalService.getCollectedApplyNoSet();
  const all = await approvalService.getAllApprovals();
  return all
    .map(r => ({ record_id: r.record_id, fields: r.fields || {} }))
    .filter(({ fields: f }) => {
      if (f['申请状态'] !== config.approvalStatus.APPROVED) return false;
      if (!approvalService.isActiveProcess(f)) return false;
      if (approvalService.hasInvoiceSubmitted(f)) return false;
      const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
      return applyNo && !collectedNos.has(applyNo);
    })
    .filter(({ fields: f }) =>
      Array.isArray(f['发起人']) && f['发起人'].some(u => u.id === openId))
    .map(({ record_id, fields: f }) => ({
      record_id,
      applyNo: f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : record_id,
      amount: typeof f['总金额'] === 'number' ? f['总金额'] : (parseFloat(f['总金额']) || null),
      material: f['购买物资名称'] || '',
      project: f['项目'] ? (f['项目'].name || String(f['项目'])) : '',
      senderName: (Array.isArray(f['发起人']) ? f['发起人'].find(u => u.id === openId) : null)?.name || '',
    }));
}

/**
 * 金额归类匹配（曼波：一名队员多种发票私聊提交时需自行核对金额归类）。
 * 金额精确匹配(±0.01)唯一 → 自动归类；名下仅一条待交票 → 直接归它（金额比对闸兜底标「金额不符」）；
 * 多候选/无候选 → 待人工（回执列候选，队员核对/找财务调整）。
 */
function matchRecord(invoiceAmount, openRecords) {
  if (!openRecords.length) return { match: null, status: '待人工', note: '名下没有待交票的已通过申请（可能都已交票，请找财务确认归类）' };
  const exact = openRecords.filter(r => r.amount !== null && Math.abs(r.amount - invoiceAmount) < 0.01);
  if (exact.length === 1) return { match: exact[0], status: null, note: null };
  if (exact.length > 1) {
    return { match: null, status: '待人工', note: `有 ${exact.length} 条同金额申请（${exact.map(r => r.applyNo).join('、')}），已转财务人工归类` };
  }
  if (openRecords.length === 1) {
    return { match: openRecords[0], status: null, note: null }; // 唯一候选直接归，金额出入由金额比对闸标记
  }
  return { match: null, status: '待人工', note: `金额与名下申请均不一致（名下待交票：${openRecords.map(r => `${r.applyNo} ¥${r.amount}`).join('、') || '无'}）` };
}

/** 打回回执文案 */
function buildRejectText(result) {
  const missingText = (result.missing || []).map(k => MISSING_LABELS[k] || k).join('、');
  const lines = ['❌ 发票未能收录，这张票先打回给你：'];
  if (result.reason === '识别要素不全' || missingText) {
    lines.push(`· 识别缺要素：${missingText || '未知'}`);
    lines.push('· 重发指引：拍照要包含完整票面（尤其左上角二维码），字迹清晰不反光；数电票建议直接转发 PDF 文件');
  } else if (result.reason === 'duplicate') {
    lines.push(`· ${result.detail}`);
    lines.push('· 若确认不是重复（如拼单各交各的），请联系财务在采集台账里人工处理');
  } else {
    lines.push(`· ${result.reason || '识别失败'}`);
    lines.push('· 可重发一次；仍失败请直接把票发给财务人工录入');
  }
  return lines.join('\n');
}

/**
 * 消息交票主入口。
 * @param {object} payload {openId, senderName, messageId, fileKey, msgType('image'|'file'), fileName, source('private'|'urge_reply'|'api')}
 * @returns {object} {ok, action:'collected'|'rejected'|'duplicated', ...} 供调用方（催办轮询等）消费
 */
async function collectFromMessage(payload) {
  const { openId, senderName, messageId, fileKey, msgType, fileName, source } = payload;
  if (!openId || !messageId || !fileKey) {
    throw new Error('缺少参数：openId/messageId/fileKey 必填');
  }

  // 1. 下载原件（图片走 image，文件(PDF)走 file）
  const buffer = await client.downloadMessageResource(messageId, fileKey, msgType === 'file' ? 'file' : 'image');

  // 2. 三通道识别（OCR 兜底注入）
  const result = await invoiceParser.recognizeInvoice(buffer, { msgType, fileName }, (buf) => ocrService.recognizeBuffer(buf));

  // 3. 非发票图静默忽略（私聊图可能是表情包/值日照片等；带发票特征但要素不全才打回）
  if (!result.ok && !result.looksLikeInvoice) {
    return { ok: false, action: 'ignored', reason: result.reason };
  }

  // 3b. 打回闸：识别不完整
  if (!result.ok) {
    const text = buildRejectText(result);
    await bot.sendTextToUser(openId, text).catch(() => {});
    return { ok: false, action: 'rejected', reason: result.reason, missing: result.missing };
  }

  const f = result.fields;

  // 4. 查重双闸
  const dupExact = await collectStore.findByInvoiceNo(f.invoiceNo);
  if (dupExact.length) {
    const first = dupExact[0].fields;
    const detail = `该发票号（尾号 ${String(f.invoiceNo).slice(-6)}）已由 ${first['提交人姓名'] || first['提交人'] || '其他队员'} 于 ${first['采集时间'] || '此前'} 提交过`;
    await bot.sendTextToUser(openId, `❌ 发票未能收录：疑似重复提交\n· ${detail}（关联申请 ${first['关联申请编号'] || '?'}）\n· 若确认不是重复（拼单各交各的），请联系财务人工处理`).catch(() => {});
    return { ok: false, action: 'duplicated', reason: 'duplicate', detail };
  }
  const dupSimilar = await collectStore.findBySimilarity({ issueDate: f.issueDate, totalAmount: f.totalAmount, sellerTaxNo: f.sellerTaxNo });
  if (dupSimilar.length) {
    await bot.sendTextToUser(openId, `❌ 发票未能收录：疑似重复提交\n· 存在开票日期与金额完全一致的已收发票（关联申请 ${(dupSimilar[0].fields['关联申请编号'] || '?')}），发票号尾号 ${String(f.invoiceNo).slice(-6)} vs ${String(dupSimilar[0].fields['发票号码'] || '?').slice(-6)}\n· 若确认不是重复，请联系财务人工处理`).catch(() => {});
    return { ok: false, action: 'duplicated', reason: 'duplicate', detail: '三元组近似命中' };
  }

  // 5. 金额归类匹配（senderName 缺失时从匹配到的审批记录发起人反查）
  const openRecords = await listOpenRecordsByOpenId(openId);
  const { match, status: matchStatus, note: matchNote } = matchRecord(f.totalAmount, openRecords);
  const resolvedName = senderName || (match && match.senderName) || '';

  // 6. 金额比对 + 抬头校验 → 校验状态（优先级：金额不符 > 抬头存疑 > 匹配状态 > 通过）
  let verifyStatus = matchStatus || '通过';
  const notes = [];
  if (match && match.amount !== null) {
    const diff = Math.round((f.totalAmount - match.amount) * 100) / 100;
    const tol = Math.max(Math.abs(match.amount) * config.invoiceCollect.amountToleranceRatio, config.invoiceCollect.amountToleranceFixed);
    if (Math.abs(diff) > tol) {
      verifyStatus = '金额不符';
      notes.push(`发票 ¥${f.totalAmount.toFixed(2)} vs 申请 ¥${match.amount.toFixed(2)}（差 ${diff.toFixed(2)}，超容忍 ±${tol.toFixed(2)}）`);
    }
  }
  const buyerCheck = checkBuyer(f);
  if (buyerCheck.status && verifyStatus !== '金额不符') verifyStatus = buyerCheck.status;
  if (buyerCheck.note) notes.push(buyerCheck.note);
  if (matchNote) notes.push(matchNote);

  // 7. 发票原件转存附件 + 落采集表（真源）
  const ext = msgType === 'file' ? 'pdf' : 'jpg';
  const fileToken = await client.uploadMediaToBitable(buffer, `invoice_${f.invoiceNo}.${ext}`).catch(() => null);
  const collectFields = {
    '发票号码': f.invoiceNo,
    ...(f.invoiceCode ? { '发票代码': f.invoiceCode } : {}),
    '票种': result.invoiceType || 'unknown',
    ...(f.issueDate ? { '开票日期': Math.floor(new Date(f.issueDate + 'T00:00:00+08:00').getTime()) } : {}),
    '价税合计': f.totalAmount,
    ...(f.buyerName ? { '购买方名称': f.buyerName } : {}),
    ...(f.buyerTaxNo ? { '购买方税号': f.buyerTaxNo } : {}),
    ...(f.sellerName ? { '销售方名称': f.sellerName } : {}),
    ...(f.sellerTaxNo ? { '销售方税号': f.sellerTaxNo } : {}),
    ...(f.checkCode ? { '校验码后6位': f.checkCode } : {}),
    '提交人': openId,
    ...(resolvedName ? { '提交人姓名': resolvedName } : {}),
    ...(match ? { '关联申请编号': match.applyNo, '申请金额': match.amount } : {}),
    '识别通道': result.source === 'qrcode+ocr' ? 'qrcode+ocr' : result.source,
    '校验状态': verifyStatus,
    ...(notes.length ? { '备注': notes.join('；') } : {}),
    ...(fileToken ? { '发票图片': [{ file_token: fileToken }] } : {}),
    '采集时间': Date.now(),
  };
  const created = await collectStore.createCollect(collectFields);

  // 8. 镜像回写审批表「补交发票」附件栏（按记录串行 + 先读后 append）
  let mirrored = false;
  if (match) {
    try {
      await withRecordLock(match.record_id, async () => {
        const record = await client.requestAPI('GET',
          `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.approvalTableId}/records/${match.record_id}`);
        const existing = (record.data?.record?.fields?.['补交发票'] || []);
        await client.requestAPI('PUT',
          `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.approvalTableId}/records/${match.record_id}`,
          { fields: { '补交发票': [...existing, ...(fileToken ? [{ file_token: fileToken }] : [])] } });
      });
      mirrored = true;
    } catch (err) {
      console.error(`[发票采集] 回写补交发票栏失败（${match.applyNo}）:`, err.message);
    }
  }

  // 9. 成功回执（队员自行核对金额归类的核对单）
  const amountText = `¥${f.totalAmount.toFixed(2)}`;
  const lines = [`✅ 发票已收录（${result.invoiceType || '发票'}，尾号 ${String(f.invoiceNo).slice(-6)}，${amountText}）`];
  if (match) {
    lines.push(`· 归类：申请 ${match.applyNo}（${match.material || '未填物资'}${match.project ? '/' + match.project : ''}，申请 ¥${match.amount ?? '?'}）`);
    if (verifyStatus === '金额不符') lines.push(`· ⚠️ ${notes[0] || '金额与申请有出入'}`);
    lines.push(mirrored ? '· 已同步到审批表补交发票栏' : '· ⚠️ 审批表镜像同步失败，已记录台账（财务可见），不影响收录');
  } else {
    lines.push(`· 归类：待财务人工归类——${matchNote || ''}`);
  }
  if (verifyStatus === '抬头存疑') lines.push(`· ⚠️ ${buyerCheck.note}`);
  lines.push('· 请核对上面的金额与归类，有误请尽快联系财务调整');
  await bot.sendTextToUser(openId, lines.join('\n')).catch(() => {});

  return {
    ok: true,
    action: 'collected',
    invoiceNo: f.invoiceNo,
    totalAmount: f.totalAmount,
    matchApplyNo: match ? match.applyNo : null,
    verifyStatus,
    mirrored,
    recordId: created.record_id,
    source: source || 'api',
  };
}

module.exports = {
  collectFromMessage,
  parseAllowedBuyers,
  checkBuyer,
  listOpenRecordsByOpenId,
  matchRecord,
  buildRejectText,
  withRecordLock,
};
