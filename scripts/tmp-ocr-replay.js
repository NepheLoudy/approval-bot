// 临时诊断脚本：对真实票复现识别管线，逐字段验证提取效果（用完即删）
process.env.FORM_ALERT_DISABLED = '1';
const path = require('path');
const collectStore = require('../src/services/collectStore');
const client = require('../src/feishu/client');
const invoiceParser = require('../src/services/invoiceParser');
const ocrService = require('../src/services/ocrService');
const { fieldText } = require('../src/utils/fields');

(async () => {
  const collects = await collectStore.listCollect();
  // 选样：3 张 pdfText（不同日期跨度）+ 2 张 qrcode（图片票）
  const pdfSamples = collects.filter(r => fieldText(r.fields['识别通道']) === 'pdfText').slice(0, 3);
  const qrSamples = collects.filter(r => fieldText(r.fields['识别通道']) === 'qrcode').slice(0, 2);
  const samples = [...pdfSamples, ...qrSamples];

  for (const r of samples) {
    const f = r.fields;
    const no = fieldText(f['发票号码']);
    const att = (Array.isArray(f['发票图片']) && f['发票图片'][0]) || {};
    console.log('\n========== ' + no + '（' + fieldText(f['识别通道']) + ' / ' + (String(att.name || '').endsWith('.pdf') ? 'PDF' : '图片') + '）==========');
    let buf;
    try {
      buf = att.url ? await client.downloadMediaByUrl(att.url) : await client.downloadMedia(att.file_token);
    } catch (e) { console.log('下载失败: ' + e.message); continue; }
    const hint = { fileName: att.name || '', msgType: String(att.name || '').endsWith('.pdf') ? 'file' : 'image' };

    if (hint.msgType === 'file') {
      // 1) 文本层直接验
      try {
        const parser = new (require('pdf-parse').PDFParse)({ data: new Uint8Array(buf) });
        const parsed = await parser.getText();
        const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
        console.log('[文本层] 长度=' + text.length + ' 前300字=' + JSON.stringify(text.slice(0, 300)));
        await parser.destroy().catch(() => {});
      } catch (e) { console.log('[文本层] 提取失败: ' + e.message); }
    }
    // 2) 全管线复现（含真实 OCR 兜底）
    try {
      const r2 = await invoiceParser.recognizeInvoice(buf, hint, (b) => ocrService.recognizeBuffer(b));
      console.log('[管线结果] ok=' + r2.ok + ' source=' + r2.source + ' invoiceType=' + (r2.invoiceType || ''));
      const fd = r2.fields || {};
      console.log('[字段] 号=' + (fd.invoiceNo || '✗') + ' | 日期=' + (fd.issueDate || '✗') + ' | 金额=' + (fd.totalAmount ?? '✗'));
      console.log('[字段] 购方=' + (fd.buyerName || '✗') + '/' + (fd.buyerTaxNo || '✗') + ' | 销方=' + (fd.sellerName || '✗') + '/' + (fd.sellerTaxNo || '✗'));
      console.log('[字段] 开票内容=' + (fd.invoiceContent || '✗') + ' | 校验码=' + (fd.checkCode || '✗'));
      if (r2.warnings && r2.warnings.length) console.log('[warnings] ' + r2.warnings.join(' ; '));
      if (!r2.ok) console.log('[失败原因] ' + (r2.reason || '') + ' 缺=' + (r2.missing || []).join('/'));
    } catch (e) { console.log('管线异常: ' + e.message); }
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
