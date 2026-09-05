const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseArrayConfig(value) {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(v => v);
}

// ============================================================
// 与所有 qianli 项目共用同一个飞书应用（APP_ID 相同）。
// 事件由 feishu-gateway 唯一长连接接收并转发到 /api/feishu/event。
// 本项目仅服务审批群（BOT_CHAT_ID），播报为纯定时任务：
//   - 每周财务催办周报（催发票/催报销单/催转账 + 本周统计）
//   - 每日待审批提醒（有「审批中」记录才发送）
// 不做审批提交/审批结果的事件即时播报。
// ============================================================

module.exports = {
  port: process.env.PORT || 3002,

  feishu: {
    appId: process.env.APP_ID || '',
    appSecret: process.env.APP_SECRET || '',
  },

  bitable: {
    appToken: process.env.BITABLE_APP_TOKEN || '',
    approvalTableId: process.env.BITABLE_APPROVAL_TABLE_ID || '',
  },

  feishuEvent: {
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    // 安全默认必须为 false：本项目只做定时拉取与被动接收网关转发，
    // 自行开长连接会与 feishu-gateway 抢共用应用的事件（架构铁律）
    useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION === 'true',
  },

  bot: {
    name: process.env.BOT_NAME || '爆米花机-对话型',
    webhookUrl: process.env.BOT_WEBHOOK_URL || '',
    // 本项目唯一服务的群聊：指令与对话触发只在该群生效，
    // 其他群的消息一律不处理（与正常其他群的对话能力分离）
    chatId: process.env.BOT_CHAT_ID || '',
  },

  // 审批流程过滤：审批表里的记录可能来自多个审批流程定义（含历史/测试流程），
  // 只有当前活跃流程才触发播报；留空表示不过滤
  approvalProcesses: parseArrayConfig(process.env.APPROVAL_PROCESS_NAMES),

  // 申请状态（单选字段「申请状态」的实际取值，来自多维表格）
  approvalStatus: {
    PENDING: '审批中',
    APPROVED: '已通过',
    REJECTED: '已拒绝',
    // 终态但无需播报的状态（撤回/取消/终止/删除），仅更新快照
    SILENT_TERMINAL: ['已撤回', '已取消', '已终止', '已删除'],
  },

  // 催发票私聊：已通过且完成时间满 graceDays 天仍未交发票 → 私聊发起人催交
  // （私聊走应用 IM API sendTextToUser，链接用「申请编号」自带的审批实例链接）
  // 回复监听：私聊后轮询 p2p 会话消息列表（不经事件链路），
  //   回复「延期/推迟」→ deferDays 天内不催该批记录；
  //   回复「无法提交」→ 停止催该批记录，状态呈报周报给财务；
  //   同一记录私聊满 maxTimes 次 → 停止私聊，升级周报展示给财务。
  invoiceUrge: {
    // 留空 = 不启用（与每日提醒同款开关约定）
    schedule: process.env.INVOICE_URGE_SCHEDULE || '',
    graceDays: parseInt(process.env.INVOICE_URGE_GRACE_DAYS, 10) || 14,
    deferDays: parseInt(process.env.INVOICE_URGE_DEFER_DAYS, 10) || 3,
    maxTimes: parseInt(process.env.INVOICE_URGE_MAX_TIMES, 10) || 3,
    // 状态文件：NAS 的 SFTP 部署会清空项目目录，生产应配到项目目录之外
    stateFile: process.env.INVOICE_URGE_STATE_FILE || '',
  },

  // 每日待审批提醒（发票提醒）：@当前处理人，为空时回落到配置的审批人
  reminder: {
    schedule: process.env.DAILY_INVOICE_REMINDER_SCHEDULE || '',
    // 显式配置优先，否则回落到历史变量里的两位审批人
    mentionIds: parseArrayConfig(process.env.DAILY_REMINDER_MENTION_IDS).length > 0
      ? parseArrayConfig(process.env.DAILY_REMINDER_MENTION_IDS)
      : parseArrayConfig(
          [process.env.HE_YUNJIE_OPEN_ID, process.env.ZHANG_GUOHAO_OPEN_ID]
            .filter(Boolean)
            .join(',')
        ),
  },

  // 审批者配置（逗号分隔 open_id，用于提醒回落等场景）
  approvers: parseArrayConfig(process.env.APPROVERS),

  // 每周播报（默认环境变量为每周一 18:00）
  cron: {
    schedule: process.env.CRON_SCHEDULE || '0 0 18 * * 1',
  },
};
