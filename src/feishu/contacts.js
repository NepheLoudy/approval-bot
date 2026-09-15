const { requestAPI } = require('./client');

// ============================================================
// 通讯录只读封装（催发票私聊前的人员有效性兜底，需应用具备通讯录只读权限）
//
// 全租户部门（自根 fetch_child）× 各部门成员 → 活跃成员 open_id 集合。
// 离职成员不在任何部门、停用成员 activated=false，均不入集合。
// 端点与 duty-bot src/feishu/contacts.js 同款（五机器人共用同一飞书应用，
// 权限已被 duty-bot 在生产验证），校验失败由调用方决定 fail-open。
// ============================================================

/** 活跃成员 open_id 集合（Set<open_id>；失败抛错） */
async function listActiveOpenIds() {
  const deptRes = await requestAPI('GET', '/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=50');
  if (deptRes.code !== 0) throw new Error(`拉取部门失败: ${deptRes.msg} (${deptRes.code})`);
  const deptIds = ['0', ...(deptRes.data?.items || []).map((d) => d.open_department_id)];

  const active = new Set();
  for (const deptId of deptIds) {
    let pageToken = '';
    do {
      const query = new URLSearchParams({ department_id: deptId, user_id_type: 'open_id', page_size: '50' }); // 该接口 page_size 上限 50
      if (pageToken) query.set('page_token', pageToken);
      const res = await requestAPI('GET', `/contact/v3/users/find_by_department?${query.toString()}`);
      if (res.code !== 0) throw new Error(`拉取部门成员失败: ${res.msg} (${res.code})`);
      for (const u of (res.data?.items || [])) {
        if (!u.open_id) continue;
        if (u.status && u.status.activated === false) continue; // 停用成员视为无效
        active.add(u.open_id);
      }
      pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
    } while (pageToken);
  }
  return active;
}

module.exports = { listActiveOpenIds };
