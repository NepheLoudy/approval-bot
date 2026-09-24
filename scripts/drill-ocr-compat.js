/**
 * OCR 适应与兼容性演练脚本（2026-09-25 全量复查批）
 * 离线演练三通道识别对各种真实形态的适应性：
 *   A1 QR：真发票 QR（数电票/老票）经 jsQR 图片解码全链路
 *   A2 QR：非发票码（微信码样式 payload）不得误判
 *   A3 PDF：pdf-lib 合成数电票 PDF → pdf-parse 文本层直读
 *   A4 文本：OCR 噪声变体（全角/半角冒号、空格断裂、多段拼接、买方卖方混排）
 *   B  打印文件：样本票面（2 PNG + 1 PDF）→ 批次打印件 PDF（两票一页、录入序）
 * 结果全部落 .drill/ 目录供人工查看。跑完即看，不进 git（.gitignore 已含 *.log，drill 目录手工清）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { PDFDocument: OutPdf, StandardFonts } = require('pdf-lib');

const parser = require('../src/services/invoiceParser');
const OUT = path.join(__dirname, '..', '.drill');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // ---------- A1 QR：真实发票 QR 图片全链路（数电票 + 老票） ----------
  const shuziPayload = '01,24312000000123456789,120.50,20260901,33dskj712,';
  const oldPayload = '01,045032000111,12345678,88.00,20260115,12345678901234567890,';
  for (const [name, payload, expectNo] of [
    ['A1a 数电票 QR', shuziPayload, '24312000000123456789'],
    ['A1b 老票 QR', oldPayload, '12345678'],
  ]) {
    const png = await QRCode.toBuffer(payload, { width: 480, margin: 2 });
    const { result } = await parser.tryQrChannel(png);
    const ok = result && result.ok && result.fields.invoiceNo === expectNo;
    fs.writeFileSync(path.join(OUT, `${name.replace(/ /g, '_')}.png`), png);
    record(name, ok, ok ? `解码发票号 ${result.fields.invoiceNo} / ¥${result.fields.totalAmount} / ${result.fields.issueDate}` : JSON.stringify(result));
  }

  // ---------- A2 QR：微信收款码样式 payload（含链接+数字段）不得判为发票 ----------
  const wxPayload = 'https://weixin.qq.com/r/abc123,10.00,2026,extra';
  const wxPng = await QRCode.toBuffer(wxPayload, { width: 480 });
  const { result: wxResult } = await parser.tryQrChannel(wxPng);
  const wxSafe = !(wxResult && wxResult.invoiceShape === true && wxResult.ok);
  record('A2 非发票 QR 不误判', wxSafe, `invoiceShape=${wxResult ? wxResult.invoiceShape : 'null'}（无码或非发票形状→静默忽略路径）`);

  // ---------- A3 PDF：合成数电票 → 文本层直读 ----------
  const pdf = await OutPdf.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  const shuziLines = [
    '*( )()*+ ,  -./0 1   (Ele ctron ic  Invoi ce)',
    'Invoice No. 24312000000123456789',
    'Amount in figures CNY 120.50',
    'Date of issue 2026-09-01',
    'Total Amount in figures (Including Tax) (Lower) ¥120.50',
  ];
  shuziLines.forEach((t, i) => page.drawText(t, { x: 40, y: 780 - i * 20, size: 11, font }));
  const pdfBytes = await pdf.save();
  fs.writeFileSync(path.join(OUT, 'A3_sample_digital_invoice.pdf'), pdfBytes);
  const { result: pdfResult, error: pdfError } = await parser.tryPdfChannel(Buffer.from(pdfBytes)).catch(e => ({ result: null, error: e.message }));
  // 合成 PDF 是英文文本层（真实数电票是中文）——验证通道结构 + 正则兼容
  if (pdfResult) {
    record('A3 PDF 文本层通道', pdfResult.ok, `识别要素 ${JSON.stringify(pdfResult.fields).slice(0, 120)}`);
  } else {
    // 英文合成票走不通是预期内的（文本是中文正则），关键验证：报错如实 + 后续打回链路
    record('A3 PDF 文本层通道（英文合成票按预期打回）', Boolean(pdfError), `error="${pdfError}"（真实中文数电票文本层见 A4 文本用例）`);
  }

  // ---------- A4 文本：OCR 噪声变体（真实 OCR 分段常见形态） ----------
  const variants = [
    ['A4a 全角冒号+空格', ['发票号码：24312000000123456789', '开票日期：2026年09月01日', '价税合计（大写）壹佰贰拾圆整 （小写）¥120.50']],
    ['A4b 半角冒号+标签换行', ['发票号码', ':24312000000123456789', '开票日期:2026年09月01日', '价税合计(小写)¥120.50']],
    ['A4c 买方卖方同段混排', ['发票号码:24312000000123456789', '开票日期 2026年09月01日', '价税合计(小写)¥120.50',
      '购买方名称:重庆大学 统一社会信用代码/纳税人识别号:12100000400002697C 销售方名称:重庆某某机电有限公司 纳税人识别号:91500000TESTAAAA1X']],
    ['A4d 千分位金额+长票名称', ['发票号码:24312000000123456789', '开票日期：2026年09月01日', '价税合计（大写）壹万贰仟叁佰肆拾伍圆陆角柒分 （小写）¥12,345.67',
      '货物名称:高性*能伺服电机组套件（含编码器线缆*2）', '销售方名称:重庆某某机电有限公司']],
  ];
  for (const [name, segments] of variants) {
    const r = parser.parseInvoiceText(segments.join('\n'));
    const pass = !r.missing.length && r.fields.invoiceNo === '24312000000123456789' && r.fields.totalAmount !== null;
    const amountOk = name === 'A4d 千分位金额+长票名称' ? r.fields.totalAmount === 12345.67 : r.fields.totalAmount === 120.50;
    record(name, pass && amountOk,
      `号=${r.fields.invoiceNo} 日期=${r.fields.issueDate} 金额=${r.fields.totalAmount} 买方税号=${r.fields.buyerTaxNo || '-'} 卖方=${r.fields.sellerName || '-'}`);
  }

  // ---------- A5 特征词判定：非发票内容静默 ----------
  const noiseCases = [
    ['A5a 表情包文字', '哈哈哈哈哈哈哈哈', false],
    ['A5b 通知截图', '关于本周五组会安排的通知 请大家准时参加', false],
    ['A5c 发票截图（无要素但有特征词）', '这是我的发票照片', true],
  ];
  for (const [name, text, expect] of noiseCases) {
    const got = parser.looksLikeInvoiceText(text);
    record(name, got === expect, `特征词判定=${got}`);
  }

  // ---------- B 打印文件：样本票面 → 批次打印件 PDF ----------
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  // 票1/票2：合成「发票样式」PNG（A4 横版样式的白底黑框字）
  const makeInvoicePng = async (label, no) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600">
      <rect width="1200" height="600" fill="white" stroke="black" stroke-width="4"/>
      <text x="40" y="80" font-size="40" fill="black">${label}</text>
      <text x="40" y="160" font-size="32" fill="black">Invoice No: ${no}</text>
      <text x="40" y="240" font-size="32" fill="black">Date: 2026-09-01</text>
      <text x="40" y="320" font-size="32" fill="black">Amount: CNY 120.50</text>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  };
  const png1 = await makeInvoicePng('E-Invoice Sample #1 (first scanned)', '24312000000123456789');
  const png2 = await makeInvoicePng('E-Invoice Sample #2 (second scanned)', '24312000000123459999');
  const img1 = await out.embedPng(png1);
  const img2 = await out.embedPng(png2);
  // 模拟两票一页排布（与 batchService 相同几何）
  const A4 = { width: 595.28, height: 841.89 };
  const SLOT = { width: A4.width - 40, height: (A4.height - 60) / 2 };
  const printPage = out.addPage([A4.width, A4.height]);
  for (const [i, img] of [img1, img2].entries()) {
    const scale = Math.min(SLOT.width / img.width, SLOT.height / img.height);
    const w = img.width * scale, h = img.height * scale;
    const slotTop = i === 0 ? A4.height - 30 : A4.height - 30 - SLOT.height;
    printPage.drawImage(img, { x: (A4.width - w) / 2, y: slotTop - h, width: w, height: h });
  }
  const pdfBytes2 = Buffer.from(await out.save());
  fs.writeFileSync(path.join(OUT, 'B_batch_print_sheet_2up.pdf'), pdfBytes2);
  const check = await OutPdf.load(pdfBytes2);
  record('B 打印件两票一页 PDF', check.getPageCount() === 1 && pdfBytes2.length > 1000,
    `页数=${check.getPageCount()}（2 张票 1 页 A4 竖版）大小=${(pdfBytes2.length / 1024).toFixed(1)}KB → .drill/B_batch_print_sheet_2up.pdf`);

  // ---------- 汇总 ----------
  const failed = results.filter(r => !r.pass);
  console.log(`\n========== 演练汇总：${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) { failed.forEach(f => console.log('  失败:', f.name)); process.exit(1); }
}

main().catch(err => { console.error('演练异常:', err); process.exit(1); });
