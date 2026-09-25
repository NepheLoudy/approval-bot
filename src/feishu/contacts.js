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
  const users = await listActiveUsers();
  return new Set(users.keys());
}

/**
 * 活跃成员映射（Map<open_id, 姓名>；失败抛错）。
 * 5 分钟进程内缓存：接取/submit/paid 等指令链的「open_id 反查实名」防冒名用，
 * 全租户部门×成员扫描成本不低，不缓存会对每条资金指令打一轮通讯录。
 */
let userCache = { map: null, expiresAt: 0 };
async function listActiveUsers() {
  const now = Date.now();
  if (userCache.map && now < userCache.expiresAt) return userCache.map;

  // 部门列表也要翻页（has_more/page_token）：组织超 50 个部门时单页拉取会漏人，
  // 漏掉的部门成员被误判「离职」持久化停催且无法自动恢复（2026-09-20 审查发现）
  const deptIds = ['0'];
  let deptToken = '';
  do {
    const deptQuery = new URLSearchParams({ department_id_type: 'open_department_id', fetch_child: 'true', page_size: '50' });
    if (deptToken) deptQuery.set('page_token', deptToken);
    const deptRes = await requestAPI('GET', `/contact/v3/departments/0/children?${deptQuery.toString()}`);
    if (deptRes.code !== 0) throw new Error(`拉取部门失败: ${deptRes.msg} (${deptRes.code})`);
    for (const d of (deptRes.data?.items || [])) deptIds.push(d.open_department_id);
    deptToken = deptRes.data?.has_more ? (deptRes.data.page_token || '') : '';
  } while (deptToken);

  const users = new Map();
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
        users.set(u.open_id, u.name || '');
      }
      pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
    } while (pageToken);
  }
  userCache = { map: users, expiresAt: now + 5 * 60 * 1000 };
  return users;
}

module.exports = { listActiveOpenIds, listActiveUsers };
