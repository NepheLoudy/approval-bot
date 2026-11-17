// 临时只读脚本 v2：修正字段读法的 OCR 素材盘点（用完即删）
process.env.FORM_ALERT_DISABLED = '1';
const collectStore = require('../src/services/collectStore');
const { fieldText } = require('../src/utils/fields');

(async () => {
  const collects = await collectStore.listCollect();
  console.log('采集表总数=' + collects.length);

  const dist = { ch: {}, st: {}, weak: [] };
  for (const r of collects) {
    const f = r.fields;
    const ch = fieldText(f['识别通道']) || '(空)';
    dist.ch[ch] = (dist.ch[ch] || 0) + 1;
    const st = fieldText(f['校验状态']) || '(空)';
    dist.st[st] = (dist.st[st] || 0) + 1;
    // 票面字段用 fieldText 读（兼容富文本段数组）
    const missing = [];
    if (!fieldText(f['购买方名称'])) missing.push('购方名');
    if (!fieldText(f['购买方税号'])) missing.push('购方税号');
    if (!fieldText(f['销售方名称'])) missing.push('销方名');
    if (!fieldText(f['销售方税号'])) missing.push('销方税号');
    if (!fieldText(f['开票内容'])) missing.push('开票内容');
    if (!fieldText(f['校验码后6位'])) missing.push('校验码');
    if (missing.length) {
      dist.weak.push({
        no: String(fieldText(f['发票号码']) || '').slice(-8),
        ch, st,
        amt: fieldText(f['价税合计']),
        missing: missing.join('+'),
        rec: r.record_id,
        ext: (Array.isArray(f['发票图片']) && f['发票图片'][0] && String(f['发票图片'][0].name || '')).endsWith('.pdf') ? 'pdf' : 'img',
      });
    }
  }

  console.log('\n== 识别通道分布 ==');
  for (const [k, v] of Object.entries(dist.ch).sort((a, b) => b[1] - a[1])) console.log('  ' + k + ': ' + v);
  console.log('\n== 校验状态分布 ==');
  for (const [k, v] of Object.entries(dist.st).sort((a, b) => b[1] - a[1])) console.log('  ' + k + ': ' + v);

  console.log('\n== 票面字段缺失票 == ' + dist.weak.length + ' 张');
  const byCh = {};
  for (const w of dist.weak) byCh[w.ch] = (byCh[w.ch] || 0) + 1;
  console.log('按通道=' + JSON.stringify(byCh));
  const byMissing = {};
  for (const w of dist.weak) byMissing[w.missing] = (byMissing[w.missing] || 0) + 1;
  console.log('缺失形态 Top8:');
  for (const [k, v] of Object.entries(byMissing).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  缺[' + k + ']: ' + v + ' 张');

  console.log('\n样例前 15 张:');
  for (const w of dist.weak.slice(0, 15)) console.log('  ' + w.no + ' | ' + w.ch + ' | ¥' + w.amt + ' | ' + w.st + ' | 缺[' + w.missing + '] | ' + w.ext);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
