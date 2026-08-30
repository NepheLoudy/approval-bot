const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseArrayConfig(value) {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(v => v);
}

// ============================================================
// 与所有 qianli 项目共用同一个飞书应用（APP_ID 相同）。
// 飞书对同一应用的多个长连接是「随机分发」事件，每个事件只会投递给
// 其中一条连接（PMR / ticket-bot / 本项目互相竞争），因此：
//   1. 本项目的指令与对话只处理「目标群」，其余群一律跳过，
//      留给正常的群对话能力（爆米花机）处理；
//   2. 多维表格播报不能只依赖事件推送，必须由轮询对账兜底
//      （见 services/approvalService.js 的快照同步）。
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
    // 对账轮询间隔（分钟）。事件被其他项目的长连接抢走时，靠它补上漏掉的变更
    pollIntervalMinutes: Math.max(parseInt(process.env.BITABLE_POLL_MINUTES || '5', 10) || 5, 1),
  },

  feishuEvent: {
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== 'false',
  },

  bot: {
    name: process.env.BOT_NAME || '审批机器人',
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
