// 临时脚本：验证催发票状态链路（延期/无法提交/已催满 的过滤 + 周报徽标 + 单号超链接 + 回复解析）
// 只做 dry-run 与本地状态文件，不发送任何真实消息
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const approvalService = require('../src/services/approvalService');
const urgeStateStore = require('../src/services/urgeStateStore');
const { parseReply, runInvoiceUrge } = require('../src/services/invoiceUrgeService');
const { runWeeklyBroadcast } = require('../src/services/broadcastService');

const LOCAL_STATE = path.join(__dirname, '..', 'data', 'urge-state.json');

async function main() {
  // 0) 回复解析单测
  const cases = [
    ['申请延期两天', 'deferred'],
    ['推迟一下', 'deferred'],
    ['无法提交', 'cannot_submit'],
    ['发票开不出来，交不了', 'cannot_submit'],
    ['你好', null],
    ['好的我马上交', null],
  ];
  for (const [text, want] of cases) {
    const got = parseReply(text);
    console.log(`${got === want ? '✓' : '✗'} parseReply("${text}") = ${got}（期望 ${want}）`);
  }

  // 锁定本地默认状态文件（防止 .env 里的 NAS 路径把内存状态指向别处）
  config.invoiceUrge.stateFile = '';

  // 1) 造状态：取真实超期名单前 3 条，分别标记 延期/无法提交/已催满
  urgeStateStore.init(''); // 用默认 data/urge-state.json
  const overdue = await approvalService.getOverdueInvoices();
  console.log(`\n真实超期名单 ${overdue.length} 条`);
  const [a, b, c, ...rest] = overdue;
  if (a) urgeStateStore.updateRecord(a.record_id, { status: 'deferred', snoozeUntil: Date.now() + 2 * 86400000, statusNote: '测试延期' });
  if (b) urgeStateStore.updateRecord(b.record_id, { status: 'cannot_submit', statusNote: '测试无法提交' });
  if (c) urgeStateStore.updateRecord(c.record_id, { status: 'escalated', urgeCount: 3, statusNote: '测试已催满' });

  // 2) dry-run 私聊：3 条应被过滤，其余照常
  const urge = await runInvoiceUrge({ dryRun: true });
  console.log(`\n[dry-run 私聊] 超期 ${urge.overdueCount} 条 → 本次应私聊 ${urge.urgeCount} 条（期望 ${overdue.length - 3}）`);
  console.log('   状态过滤:', JSON.stringify(urge.statusCounts), '（期望 deferred:1 / cannotSubmit:1 / escalated:1）');

  // 3) 周报卡片：未交票行应有状态徽标 + 单号超链接
  const weekly = await runWeeklyBroadcast({ dryRun: true });
  const lines = [];
  for (const el of weekly.card.elements) {
    if (el.tag === 'markdown' && el.content.includes('未交发票')) lines.push(el.content);
  }
  console.log('\n[周报未交发票段渲染]');
  console.log(lines.join('\n').split('\n').slice(0, 8).join('\n'));
  const hasLink = lines.join('').includes('](https://applink.feishu.cn/');
  const badges = ['[无法提交]', '[已延期至', '[已催满3次]'].filter((b) => lines.join('').includes(b));
  console.log(`\n单号超链接: ${hasLink ? '✓' : '✗'} | 状态徽标命中: ${badges.join(' , ') || '无'}`);
  console.log('周报统计项目分布仍在:', lines.join('').length > 0 && weekly.card.elements.some(el => el.tag === 'markdown' && el.content.includes('项目分布')) ? '✓' : '✗');

  // 4) 清理测试状态
  fs.rmSync(path.dirname(LOCAL_STATE), { recursive: true, force: true });
  console.log('\n已清理本地测试状态文件');
}

main().catch(err => { console.error('失败:', err); process.exit(1); });
