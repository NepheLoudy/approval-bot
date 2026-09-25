/**
 * 发票识别解析器：三通道识别 + 字段抽取（纯函数为主，桩测试直接断言）
 *
 * 通道优先级（准确率从高到低，多通道互补）：
 *   1. pdfText  数电票/电子票 PDF 版式文件文本层直接抽取（最准）
 *   2. qrcode   发票左上角二维码解码（与重大财务系统小翼Plus 扫码同源，查验要素精确）
 *   3. ocr      OCR 全票面兜底（拍照/截图，复用 ocrService 的飞书免费 OCR）
 *
 * 完整性口径：查验三要素（发票号码/开票日期/价税合计）齐 = 可入库；
 * 购买方/销售方/校验码缺失只记 warning（小翼Plus 录入以三要素为主）。
 * 任一三要素缺失 = 打回（reason + missing 明细，供打回提醒链路引用）。
 */
const sharp = require('sharp');
const jsQR = require('jsqr');
// pdf-parse v2（2.4.x）改为类 API：new PDFParse({data}).getText()；v1 的函数调用形态已废弃
const { PDFParse } = require('pdf-parse');

// ---------- 文本字段抽取（PDF 文本与 OCR 分段拼接文本共用） ----------

const RE_INVOICE_NO_20 = /(?:发票号码|号码)\s*[:：]?\s*(\d{20})/;
const RE_INVOICE_CODE = /(?:发票代码|代码)\s*[:：]?\s*(\d{10,12})/;
const RE_INVOICE_NO_8 = /(?:发票号码|号码)\s*[:：]?\s*(\d{8})(?!\d)/;
const RE_ISSUE_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
// 价税合计(小写) 后的第一个金额；防止误抓「金额」「税额」列（不含税价）
const RE_TOTAL = /价税合计[\s\S]{0,40}?[（(]\s*小写\s*[)）]\s*[:：]?\s*[¥￥]?\s*([0-9,]+\.[0-9]{2})/;
const RE_TOTAL_LOOSE = /[¥￥]\s*([0-9,]+\.[0-9]{2})/;
const RE_CHECK_CODE = /(?:校验码|校验)\s*[:：]?\s*([0-9]{6,20})/;
const RE_TAX_NO = /(?:统一社会信用代码|纳税人识别号)\s*[\/／]?\s*[:：]?\s*([0-9A-Z]{15,20})/;

/**
 * 开票内容（票面货物名称行的星号分类，如「*电子元件*存储器」）。
 * 学校投递单「电子发票明细.开票内容」与校格式物料清单「项目」列同源；
 * 仅 PDF 文本层/OCR 通道可见（票面印刷信息，二维码里没有）。
 * 多行货物取第一行（与投递单一票一行「开票内容」口径一致）。
 */
function extractInvoiceContent(rawText) {
  const text = String(rawText || '').replace(/＊/g, '*');
  const m = text.match(/\*\s*([^*\n]{1,20}?)\s*\*\s*([^*\n]{1,80})/);
  if (!m) return null;
  // 列分隔截断：PDF 文本层列间多空格；行尾数量/金额（如「1 张」「3.97」）剥掉
  let name = m[2].split(/\s{2,}/)[0];
  name = name.replace(/\s*[0-9.]+\s*(张|个|台|件|只|枚|套|米|卷|次)?\s*$/, '').trim();
  if (!m[1].trim() || !name) return null;
  return `*${m[1].trim()}*${name}`;
}

/** 发票特征词（私聊转发图片的「是不是发票」前置判断：非发票图静默忽略不打回） */
function looksLikeInvoiceText(text) {
  return /(发票|价税合计|统一社会信用代码|纳税人识别号|增值税|机器编号|开票日期)/.test(String(text || ''));
}

/** 从一段含「购买方…销售方」或分段拼接的文本中按角色取名称/税号 */
function extractParty(text, role) {
  // 形态1：同段「购买方名称:XXX 统一社会信用代码:YYY」（OCR 拼接/PDF 文本）
  const namePatterns = [
    new RegExp(role + `名称\\s*[:：]\\s*([^\\n\\r,，;；（(]{2,60})`),
    new RegExp(role + `\\s*[:：]\\s*([^\\n\\r,，;；（(]{2,60})`),
  ];
  let name = null;
  for (const re of namePatterns) {
    const m = text.match(re);
    if (m) {
      // 同段混排（OCR 拼接常见）：名称截断到税号字段标签之前，避免吞进「纳税人识别号:…」
      name = m[1].split(/统一社会信用代码|纳税人识别号|销售方|购买方/)[0].replace(/[\s,，;；]+$/, '').trim();
      break;
    }
  }
  // 税号按角色分段截取后匹配（购买方在前销售方在后，第一个/第二个命中）
  const nth = role === '销售方' ? 2 : 1;
  let taxNo = null;
  const globalRe = new RegExp(RE_TAX_NO.source, 'g');
  let hit = 0, m;
  while ((m = globalRe.exec(text)) !== null) {
    hit++;
    if (hit === nth) { taxNo = m[1]; break; }
  }
  return { name, taxNo };
}

/**
 * 从发票文本抽取字段。输入文本（PDF 文本层或 OCR 分段用 \n 拼接）。
 */
function parseInvoiceText(rawText) {
  const text = String(rawText || '').replace(/\u00a0/g, ' ');
  const fields = { invoiceCode: null, invoiceNo: null, issueDate: null, totalAmount: null, checkCode: null, buyerName: null, buyerTaxNo: null, sellerName: null, sellerTaxNo: null, invoiceContent: null };
  const warnings = [];

  const m20 = text.match(RE_INVOICE_NO_20);
  if (m20) {
    fields.invoiceNo = m20[1];
  } else {
    const mCode = text.match(RE_INVOICE_CODE);
    const m8 = text.match(RE_INVOICE_NO_8);
    if (mCode) fields.invoiceCode = mCode[1];
    if (m8) fields.invoiceNo = m8[1];
    if (mCode && !m8) warnings.push('识别到发票代码但未识别到 8 位发票号码');
  }

  const mDate = text.match(RE_ISSUE_DATE);
  if (mDate) {
    const [, y, mRaw, dRaw] = mDate;
    const m = parseInt(mRaw, 10), d = parseInt(dRaw, 10);
    // 非法日期（OCR 噪声如 19 月）不落库：置空进 missing，防止 NaN/静默滚动（复查 P2-6）
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      fields.issueDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const mTotal = text.match(RE_TOTAL) || text.match(RE_TOTAL_LOOSE);
  if (mTotal) {
    fields.totalAmount = parseFloat(mTotal[1].replace(/,/g, ''));
  } else {
    warnings.push('未识别到「价税合计(小写)」金额');
  }

  const mCheck = text.match(RE_CHECK_CODE);
  if (mCheck) fields.checkCode = mCheck[1].slice(-6);

  const buyer = extractParty(text, '购买方');
  const seller = extractParty(text, '销售方');
  fields.buyerName = buyer.name;
  fields.buyerTaxNo = buyer.taxNo;
  fields.sellerName = seller.name;
  fields.sellerTaxNo = seller.taxNo;
  fields.invoiceContent = extractInvoiceContent(text);

  // 票种推断
  let invoiceType = 'unknown';
  if (fields.invoiceNo && fields.invoiceNo.length === 20) invoiceType = '全电发票';
  else if (fields.invoiceCode) invoiceType = '增值税发票';

  const missing = ['invoiceNo', 'issueDate', 'totalAmount'].filter(k => !fields[k]);
  return { fields, invoiceType, missing, warnings };
}

// ---------- 二维码通道（发票左上角 QR，与小翼Plus 扫码同源） ----------

/**
 * 解析发票二维码 payload。增值税票与数电票均为逗号分隔段，位置随票种有差异，
 * 这里按「数字长度启发式」容错解析；无法辨认的格式如实报 not recognized。
 * 已知形态：
 *   老票:  01,<10-12位发票代码>,<8位号码>,<金额>,<YYYYMMDD>,<校验码>[,...]
 *   数电票: 01,<20位号码>,<金额>,<YYYYMMDD>[,...]（或含 33 开头随机码段）
 * 返回带 invoiceShape：payload 是否形似发票 QR（区分「发票 QR 要素不全」与
 * 微信码/付款码等任意二维码——后者不得触发打回，复查 P1-3）。
 */
function parseQrPayload(payload) {
  const parts = String(payload || '').split(',').map(s => s.trim()).filter(s => s !== '');
  if (parts.length < 4) return { ok: false, reason: 'qr 格式段数不足', invoiceShape: false };

  const fields = { invoiceCode: null, invoiceNo: null, issueDate: null, totalAmount: null, checkCode: null };
  for (const seg of parts) {
    if (/^\d{20}$/.test(seg) && !fields.invoiceNo) fields.invoiceNo = seg;
    else if (/^\d{10,12}$/.test(seg) && !fields.invoiceCode) fields.invoiceCode = seg;
    else if (/^\d{8}$/.test(seg) && !fields.invoiceNo && fields.invoiceCode) fields.invoiceNo = seg;
    else if (/^\d{8}$/.test(seg) && !fields.issueDate && /^\d{4}[01]\d[0-3]\d$/.test(seg)) fields.issueDate = `${seg.slice(0, 4)}-${seg.slice(4, 6)}-${seg.slice(6, 8)}`;
    else if (/^[0-9]+\.[0-9]{2}$/.test(seg) && fields.totalAmount === null) fields.totalAmount = parseFloat(seg);
    else if (/^\d{6,20}$/.test(seg) && !fields.checkCode && fields.invoiceNo && seg !== fields.invoiceNo) fields.checkCode = seg.slice(-6);
  }

  const invoiceShape = Boolean(fields.invoiceNo || fields.invoiceCode);
  const missing = ['invoiceNo', 'issueDate', 'totalAmount'].filter(k => !fields[k]);
  if (missing.length) return { ok: false, reason: 'qr 可读但查验要素不全', missing, fields, invoiceShape };
  const invoiceType = fields.invoiceNo.length === 20 ? '全电发票' : '增值税发票';
  return { ok: true, fields, invoiceType, warnings: [], invoiceShape };
}

/** 图片 Buffer → 二维码解码 → parseQrPayload；无码/解码失败返回 null（调用方降级 OCR） */
async function tryQrChannel(buffer) {
  let raw;
  try {
    raw = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    return { result: null, error: `图片解码失败: ${err.message}` };
  }
  // 大图缩小到 1600px 宽以内再解码（jsQR 对超大图既慢又易失败）；截图发票普遍偏小，不影响
  let { data, info } = raw;
  if (info.width > 1600) {
    const scale = 1600 / info.width;
    const resized = await sharp(buffer).rotate().resize(Math.round(info.width * scale)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    data = resized.data;
    info = resized.info; // 用 sharp 实际输出尺寸，避免自行推算 ±1px 导致 jsQR 静默失败（复查 P2-11）
  }
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
  if (!found || !found.data) return { result: null, error: null };
  return { result: parseQrPayload(found.data), error: null };
}

// ---------- PDF 通道 ----------

async function tryPdfChannel(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  try {
    const parsed = await parser.getText();
    text = parsed.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
  if (!text.trim()) return { result: null, error: 'PDF 无文本层（可能是扫描件，请发图片）' };
  const parsedInvoice = parseInvoiceText(text);
  if (parsedInvoice.missing.length) {
    return { result: null, error: `PDF 文本层识别要素不全（缺 ${parsedInvoice.missing.join('/')}）`, parsedInvoice };
  }
  return { result: { ok: true, source: 'pdfText', ...parsedInvoice }, error: null };
}

// ---------- 统一入口 ----------

/**
 * 发票识别主入口。
 * @param {Buffer} buffer 文件内容
 * @param {object} hint {fileName, msgType} 文件名/消息类型提示
 * @param {Function} ocrFallback OCR 兜底函数 async (buffer) => string[]（分段文本），由调用方注入（ocrService.recognizeBuffer）
 */
async function recognizeInvoice(buffer, hint = {}, ocrFallback) {
  const isPdf = hint.msgType === 'file' || /\.pdf$/i.test(hint.fileName || '') ||
    (buffer.length > 4 && buffer.slice(0, 4).toString('latin1') === '%PDF');

  if (isPdf) {
    const { result, error } = await tryPdfChannel(buffer).catch(err => ({ result: null, error: err.message }));
    if (result) return result;
    // 文件消息按指引多为发票 PDF（无文本层扫描件/版式变体），失败一律打回不静默（复查 P1-2）
    return { ok: false, source: 'pdfText', reason: error || 'PDF 识别失败', fields: {}, missing: [], warnings: [], looksLikeInvoice: true };
  }

  // 图片：先二维码，后 OCR
  const { result: qrResult, error: qrError } = await tryQrChannel(buffer);
  if (qrResult && qrResult.ok) return { source: 'qrcode', ...qrResult };

  if (typeof ocrFallback === 'function') {
    try {
      const segments = await ocrFallback(buffer);
      const joinedText = segments.join('\n');
      const parsedInvoice = parseInvoiceText(joinedText);
      if (!parsedInvoice.missing.length) return { ok: true, source: 'ocr', ...parsedInvoice };
      const like = looksLikeInvoiceText(joinedText);
      // OCR 三要素也不全：若 QR 有部分要素则合并（QR 精确字段优先，OCR 补抬头）
      if (qrResult) {
        const merged = { ...parsedInvoice.fields };
        for (const k of Object.keys(qrResult.fields || {})) {
          if (qrResult.fields[k] && !merged[k]) merged[k] = qrResult.fields[k];
        }
        const stillMissing = ['invoiceNo', 'issueDate', 'totalAmount'].filter(k => !merged[k]);
        if (!stillMissing.length) return { ok: true, source: 'qrcode+ocr', fields: merged, missing: [], warnings: parsedInvoice.warnings, invoiceType: qrResult.invoiceType };
        return { ok: false, source: 'ocr', reason: '识别要素不全', fields: merged, missing: stillMissing, warnings: parsedInvoice.warnings, looksLikeInvoice: like || Boolean(qrResult.invoiceShape) };
      }
      return { ok: false, source: 'ocr', reason: '识别要素不全', fields: parsedInvoice.fields, missing: parsedInvoice.missing, warnings: parsedInvoice.warnings, looksLikeInvoice: like };
    } catch (err) {
      return { ok: false, source: 'ocr', reason: `OCR 失败: ${err.message}`, fields: {}, missing: ['invoiceNo', 'issueDate', 'totalAmount'], warnings: [], looksLikeInvoice: false };
    }
  }

  return {
    ok: false,
    source: qrError ? 'image' : 'qrcode',
    reason: qrError || '未识别到发票二维码且无 OCR 兜底',
    fields: {},
    missing: ['invoiceNo', 'issueDate', 'totalAmount'],
    warnings: [],
    // 仅当扫出的 QR 形似发票码才算发票特征——微信码/付款码等任意 QR 不得触发打回（复查 P1-3）
    looksLikeInvoice: Boolean(qrResult && qrResult.invoiceShape),
  };
}

module.exports = {
  parseInvoiceText,
  parseQrPayload,
  tryQrChannel,
  tryPdfChannel,
  looksLikeInvoiceText,
  recognizeInvoice,
  extractInvoiceContent,
};
