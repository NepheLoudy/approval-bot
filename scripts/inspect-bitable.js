// 临时脚本：聚合审批表关键字段分布，梳理判断分支
const { requestAPI } = require('../src/feishu/client');
const config = require('../src/config');

function fmtUser(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(u => u.name || u.id).join(',');
  return v.name || String(v);
}

async function main() {
  const records = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (pageToken) q.set('page_token', pageToken);
    const res = await requestAPI('GET', `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.approvalTableId}/records?${q}`);
    if (res.code !== 0) throw new Error(res.msg);
    (res.data.items || []).forEach(r => records.push(r.fields));
    pageToken = res.data.has_more ? res.data.page_token : '';
  } while (pageToken);

  console.log('总记录数:', records.length);

  const count = (field) => {
    const m = {};
    for (const r of records) {
      const v = r[field];
      let key = '(空)';
      if (v !== null && v !== undefined) {
        if (Array.isArray(v)) key = v.map(u => u.name || u.id || u.text).join(',');
        else if (typeof v === 'object') key = v.name || v.text || JSON.stringify(v);
        else key = String(v);
      }
      m[key] = (m[key] || 0) + 1;
    }
    return m;
  };

  console.log('\n== 申请状态分布 =='); console.log(count('申请状态'));
  console.log('\n== 审批流程分布 =='); console.log(count('审批流程'));
  console.log('\n== 当前处理人分布 =='); console.log(count('当前处理人'));
  console.log('\n== 审批节点分布 =='); console.log(count('审批节点'));
  console.log('\n== 是否为提交发票 =='); console.log(count('是否为提交发票'));
  console.log('\n== 付款人分布 =='); console.log(count('付款人'));
  console.log('\n== 发起人部门 =='); console.log(count('发起人部门'));

  // 审批中记录详情（当前活跃审批）
  const pending = records.filter(r => r['申请状态'] === '审批中');
  console.log('\n== 当前"审批中"记录 ==', pending.length);
  for (const r of pending.slice(0, 10)) {
    console.log(JSON.stringify({
      编号: r['申请编号'],
      状态: r['申请状态'],
      流程: r['审批流程'],
      发起人: fmtUser(r['发起人']),
      当前处理人: fmtUser(r['当前处理人']),
      审批节点: r['审批节点'],
      物资: r['购买物资名称'],
      金额: r['总金额'],
      发起时间: r['发起时间'] ? new Date(r['发起时间']).toLocaleString('zh-CN') : null,
    }));
  }

  // 审批节点非空的记录
  const withNode = records.filter(r => r['审批节点']);
  console.log('\n== "审批节点"非空样例 ==', withNode.length);
  for (const r of withNode.slice(0, 5)) {
    console.log(JSON.stringify({
      编号: r['申请编号'], 状态: r['申请状态'], 流程: r['审批流程'],
      节点: r['审批节点'], 当前处理人: fmtUser(r['当前处理人']),
      完成时间: r['完成时间'] ? new Date(r['完成时间']).toLocaleString('zh-CN') : null,
    }));
  }
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
