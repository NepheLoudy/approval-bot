// 临时脚本：dry-run 验证催发票私聊——只构建私聊文案，不发送
const { runInvoiceUrge } = require('../src/services/invoiceUrgeService');

async function main() {
  const result = await runInvoiceUrge({ dryRun: true });
  console.log(`超期未交发票 ${result.overdueCount} 条，涉及 ${result.users} 位发起人\n`);

  for (const p of result.previews) {
    console.log(`===== 收件人: ${p.name} (${p.openId}) =====`);
    console.log(p.text);
    console.log('');
  }
}

main().catch(err => { console.error('失败:', err); process.exit(1); });
