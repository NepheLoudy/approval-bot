// 临时脚本：历史 QR 票抬头重刷（只补空不覆盖；OCR 增强后补抬头+开票内容；用完即删）
// 素材：识别通道=qrcode 的票（OCR 曾双前缀 404 全灭），下载原件跑 OCR→提取→补空列
process.env.FORM_ALERT_DISABLED = '1';
const collectStore = require('../src/services/collectStore');
const client = require('../src/feishu/client');
const invoiceParser = require('../src/services/invoiceParser');
const ocrService = require('../src/services/ocrService');
const { fieldText } = require('../src/utils/fields');

const DELAY_MS = 1500; // OCR 逐张间隔（限流礼貌）
const MAX_RETRY = 2;

(async () => {
  const collects = await collectStore.listCollect();
  const qrTickets = collects.filter(r => fieldText(r.fields['识别通道']) === 'qrcode');
  console.log('QR 票总数=' + qrTickets.length);

  let ok = 0, skip = 0, fail = 0, noFile = 0;
  const failList = [];
  for (let i = 0; i < qrTickets.length; i++) {
    const r = qrTickets[i];
    const f = r.fields;
    const no = fieldText(f['发票号码']);
    const att = (Array.isArray(f['发票图片']) && f['发票图片'][0]) || {};
    const ext = String(att.name || '').endsWith('.pdf') ? 'pdf' : 'img';

    // 只补空不覆盖
    const patch = {};
    if (!fieldText(f['购买方名称'])) patch.buyerName = true;
    if (!fieldText(f['购买方税号'])) patch.buyerTaxNo = true;
    if (!fieldText(f['销售方名称'])) patch.sellerName = true;
    if (!fieldText(f['销售方税号'])) patch.sellerTaxNo = true;
    if (!fieldText(f['开票内容'])) patch.invoiceContent = true;
    if (!Object.keys(patch).length) { skip++; continue; }
    if (!att.file_token && !att.url) { noFile++; failList.push(no + '(无附件)'); continue; }

    let done = false, lastErr = '';
    for (let t = 0; t < MAX_RETRY && !done; t++) {
      try {
        const buf = att.url ? await client.downloadMediaByUrl(att.url) : await client.downloadMedia(att.file_token);
        const hint = { fileName: att.name || '', msgType: ext === 'pdf' ? 'file' : 'image' };
        const r2 = await invoiceParser.recognizeInvoice(buf, hint, (b) => ocrService.recognizeBuffer(b));
        const fd = r2.fields || {};
        // 票号一致性防错位（写错表比不写更糟）
        if (fd.invoiceNo && fieldText(f['发票号码']) && fd.invoiceNo !== fieldText(f['发票号码'])) {
          failList.push(no + '(票号不匹配:' + fd.invoiceNo.slice(-6) + ')');
          done = true; fail++; break;
        }
        const update = {};
        if (patch.buyerName && fd.buyerName) update['购买方名称'] = fd.buyerName;
        if (patch.buyerTaxNo && fd.buyerTaxNo) update['购买方税号'] = fd.buyerTaxNo;
        if (patch.sellerName && fd.sellerName) update['销售方名称'] = fd.sellerName;
        if (patch.sellerTaxNo && fd.sellerTaxNo) update['销售方税号'] = fd.sellerTaxNo;
        if (patch.invoiceContent && fd.invoiceContent) update['开票内容'] = fd.invoiceContent;
        if (Object.keys(update).length) {
          await collectStore.updateCollect(r.record_id, update);
          ok++;
        } else {
          // OCR 也没提出来（原图空白/极度模糊），如实计入
          failList.push(no + '(OCR无字段)');
          fail++;
        }
        done = true;
      } catch (err) {
        lastErr = err.message;
        await new Promise(res => setTimeout(res, 3000));
      }
    }
    if (!done) { fail++; failList.push(no + '(' + String(lastErr).slice(0, 40) + ')'); }
    if ((i + 1) % 10 === 0) console.log('进度 ' + (i + 1) + '/' + qrTickets.length + ' ok=' + ok + ' skip=' + skip + ' fail=' + fail);
    await new Promise(res => setTimeout(res, DELAY_MS));
  }
  console.log('\n== 重刷完成 ==');
  console.log('补齐=' + ok + ' | 原本已齐(跳过)=' + skip + ' | 失败=' + fail + ' | 无附件=' + noFile);
  if (failList.length) console.log('失败明细:\n  ' + failList.join('\n  '));
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
