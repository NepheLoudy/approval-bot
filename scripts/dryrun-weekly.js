// 临时脚本：dry-run 验证财务催办三分支与周播报卡片
const approvalService = require('../src/services/approvalService');
const { runWeeklyBroadcast } = require('../src/services/broadcastService');

async function main() {
  // 1. 催办三分支
  const fu = await approvalService.getFinanceFollowUp();
  console.log('=== 催办分支统计 ===');
  console.log('未交发票:', fu.missingInvoice.length);
  console.log('未制单:', fu.missingForm.length);
  console.log('未转账(完成超3个月):', fu.missingTransfer.length);

  const show = (list, n = 5) => list.slice(0, n).map(r => {
    const f = r.fields || {};
    return `  ${f['申请编号'] || r.record_id} | 发起人=${f['发起人']?.[0]?.name || '?'} | 发票=${JSON.stringify(f['发票'])?.slice(0, 30) || 'null'} | 报销单=${f['报销单'] ?? 'null'} | 是否转账=${f['是否转账'] ?? 'null'} | 完成=${f['完成时间'] ? new Date(f['完成时间']).toLocaleDateString('zh-CN') : '无'}`;
  }).join('\n');

  console.log('\n--- 未交发票样例 ---'); console.log(show(fu.missingInvoice));
  console.log('\n--- 未制单样例 ---'); console.log(show(fu.missingForm));
  console.log('\n--- 未转账样例 ---'); console.log(show(fu.missingTransfer));

  // 2. dry-run 周播报卡片
  const result = await runWeeklyBroadcast({ dryRun: true });
  console.log('\n=== dry-run 结果 ===');
  console.log(JSON.stringify(result.counts), JSON.stringify(result.stats));

  const card = result.card;
  console.log('\n=== 卡片渲染预览 ===');
  console.log('Header:', card.header.title.content, '(template:', card.header.template + ')');
  for (const el of card.elements) {
    if (el.tag === 'markdown') console.log(el.content.replace(/\n/g, ' ⏎ '));
    else if (el.tag === 'hr') console.log('---');
  }
}

main().catch(err => { console.error('失败:', err); process.exit(1); });
