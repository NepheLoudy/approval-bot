/**
 * 打开审批 base 的链接分享（组织内获得链接的人可阅读），幂等可重复跑。
 *
 * 背景（2026-09-30 曼波反馈）：详情卡/交付卡里的「报销批次表」链接打不开——
 * 表虽建在审批 base 下（财务日常在用），但 base 链接分享默认关闭，机器人（应用身份）
 * 之外的人点直链会被权限墙拦住。
 *
 * 跑通后 base 内所有表（审批表/发票采集/报销批次）对组织内持链接者可读，
 * 不改变任何人已有的协作权限。需机器人具备 base 权限管理 scope（应用是 base 创建者）。
 */
const config = require('../src/config');
const { requestAPI } = require('../src/feishu/client');

async function main() {
  const appToken = config.bitable.appToken;
  if (!appToken) throw new Error('未配置 BITABLE_APP_TOKEN');

  // 读当前公开分享设置
  let current = null;
  try {
    current = await requestAPI('GET', `/drive/v2/permissions/${appToken}/public?type=bitable`);
    console.log('当前链接分享设置:', JSON.stringify(current.data || current, null, 2).slice(0, 300));
  } catch (err) {
    console.warn('读取当前设置失败（继续尝试写入）:', err.message);
  }

  // 设为「组织内获得链接的人可阅读」（v1 语义枚举 tenant_readable）
  const r = await requestAPI('PATCH', `/drive/v2/permissions/${appToken}/public?type=bitable`, {
    external_access: false,          // 不放开组织外
    link_share_entity: 'tenant_readable',
    share_entity: 'tenant',          // 分享范围：仅组织内
  });
  if (r.code !== 0) {
    throw new Error(`设置失败: ${r.msg} (code: ${r.code})——若 403 为应用缺 base 权限管理 scope，请在 base 界面手动开：右上角「…」→ 更多 → 权限设置 → 链接分享 → 组织内可阅读`);
  }
  console.log('✅ 已设置：组织内获得链接的人可阅读');
  console.log('验证链接:', `${config.feishu.tenantBaseUrl}/base/${appToken}?table=${config.bitable.batchTableId}`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
