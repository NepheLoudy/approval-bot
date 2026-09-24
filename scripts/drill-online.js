/**
 * 在线真机演练（2026-09-25）：对部署目标 approval-bot 逐端点探测。
 * 需要 .env 配置完成且已部署。输出各端点真实响应（含 OCR 权限状态实测）。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.DRILL_TARGET || 'http://192.168.31.57:3002';
const TOKEN = process.env.API_TOKEN || '';

async function call(method, p, body, withToken = true) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (withToken) headers['X-API-Token'] = TOKEN;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = text;
  try { json = JSON.parse(text); } catch (e) { /* 原文 */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`演练目标: ${BASE}\n`);

  // 1. 健康
  const h = await call('GET', '/api/health', null, false);
  console.log(`1. health → ${h.status} ${JSON.stringify(h.json).slice(0, 80)}`);

  // 2. policy 的 ocr 段
  const pol = await call('GET', '/api/approval/policy', null, false);
  console.log(`2. policy.ocr → ${pol.status} ${JSON.stringify(pol.json.ocr || null).slice(0, 200)}`);

  // 3. 字段规则窗口
  const f = await call('GET', '/api/ocr/fields', null, false);
  console.log(`3. ocr/fields → ${f.status} 字段数=${(f.json.fields || []).length}`);

  // 4. 鉴权负例
  const noTok = await call('POST', '/api/ocr/transcribe', { imageBase64: 'aGk=' }, false);
  console.log(`4. transcribe 无 token → ${noTok.status}（预期 403）`);

  // 5. OCR 真调（合成中文发票样图 → 实测权限状态与识别效果）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
    <rect width="800" height="400" fill="white"/>
    <text x="40" y="80" font-size="36" fill="black" font-family="Microsoft YaHei">发票号码：24312000000123456789</text>
    <text x="40" y="160" font-size="36" fill="black" font-family="Microsoft YaHei">开票日期：2026年09月01日</text>
    <text x="40" y="240" font-size="36" fill="black" font-family="Microsoft YaHei">价税合计（小写）¥120.50</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(path.join(__dirname, '..', '.drill', 'ocr_test_input.png'), png);
  const t0 = Date.now();
  const tr = await call('POST', '/api/ocr/transcribe', { imageBase64: png.toString('base64') });
  console.log(`5. transcribe 真调 → ${tr.status} 耗时=${Date.now() - t0}ms`);
  console.log(`   响应: ${JSON.stringify(tr.json).slice(0, 300)}`);

  // 6. collect 缺参负例
  const c = await call('POST', '/api/invoice/collect', {});
  console.log(`6. collect 缺参 → ${c.status}（预期 400）`);

  // 7. backfill 实战（limit=1：验证审批附件下载探测路径，成功则真回填一条存量票）
  const b = await call('POST', '/api/invoice/backfill', { limit: 1 });
  console.log(`7. backfill limit=1 → ${b.status} ${JSON.stringify(b.json).slice(0, 400)}`);

  console.log('\n演练完成。');
}

main().catch(err => { console.error('演练异常:', err.message); process.exit(1); });
