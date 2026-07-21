const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseArrayConfig(value) {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(v => v);
}

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
    useLongConnection: process.env.FEISHU_USE_LONG_CONNECTION !== 'false',
  },

  bot: {
    name: process.env.BOT_NAME || '审批机器人',
    webhookUrl: process.env.BOT_WEBHOOK_URL || '',
    chatId: process.env.BOT_CHAT_ID || '',
  },

  approvers: parseArrayConfig(process.env.APPROVERS),

  approvalStatus: {
    PENDING: '待审批',
    APPROVED: '已通过',
    REJECTED: '已驳回',
  },

  cron: {
    schedule: process.env.CRON_SCHEDULE || '0 0 18 * * *',
  },
};
