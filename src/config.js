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
    // 发票采集/报销批次表（机器人自建自写，先跑 scripts/create-collect-tables.js 再把 table_id 配进来）
    collectTableId: process.env.BITABLE_COLLECT_TABLE_ID || '',
    batchTableId: process.env.BITABLE_BATCH_TABLE_ID || '',
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
  // （私聊走应用 IM API sendPostToUser，链接用「申请编号」自带的审批实例链接）
  // 节奏：定时任务每天跑（回复轮询每日不漏），同一记录距上次私聊不满 intervalDays 天不重复催；
  // 回复监听：回复「延期/推迟」→ deferDays 天内不催该批记录（回复可带时长，如「延期 7 天」「延期一周」）；
  //   回复「无法提交」→ 停止催该批记录，状态呈报周报给财务；
  //   同一记录私聊满 maxTimes 次 → 停止私聊，升级周报展示给财务。
  invoiceUrge: {
    // 留空 = 不启用（与每日提醒同款开关约定）
    schedule: process.env.INVOICE_URGE_SCHEDULE || '',
    graceDays: parseInt(process.env.INVOICE_URGE_GRACE_DAYS, 10) || 14,
    intervalDays: parseInt(process.env.INVOICE_URGE_INTERVAL_DAYS, 10) || 2,
    deferDays: parseInt(process.env.INVOICE_URGE_DEFER_DAYS, 10) || 3,
    maxTimes: parseInt(process.env.INVOICE_URGE_MAX_TIMES, 10) || 5,
    // 状态文件：部署目标的 SFTP 部署会清空项目目录，生产应配到项目目录之外
    stateFile: process.env.INVOICE_URGE_STATE_FILE || '',
  },

  // 每日待审批提醒（发票提醒）：@当前处理人，为空时回落到配置的审批人
  reminder: {
    schedule: process.env.DAILY_INVOICE_REMINDER_SCHEDULE || '',
    // 显式配置优先，否则回落到历史变量里的两位审批人
    mentionIds: parseArrayConfig(process.env.DAILY_REMINDER_MENTION_IDS).length > 0
      ? parseArrayConfig(process.env.DAILY_REMINDER_MENTION_IDS)
      : parseArrayConfig(
          [process.env.REMINDER_FALLBACK_OPEN_ID_1, process.env.REMINDER_FALLBACK_OPEN_ID_2]
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

  // 发票图像 OCR 转录（飞书官方 OCR，免费，识别结果按区域分段返回）
  ocr: {
    // 默认开启；未开通飞书「图片识别」权限前调用会报错，可用 OCR_ENABLED=false 关闭
    enabled: process.env.OCR_ENABLED !== 'false',
    // OCR 请求超时（base64 大图比普通 API 慢，长于默认 15s）
    timeoutMs: parseInt(process.env.OCR_TIMEOUT_MS, 10) || 30000,
    maxImageBytes: parseInt(process.env.OCR_MAX_IMAGE_BYTES, 10) || 5 * 1024 * 1024,
    // 字段提取规则文件（JSON）。部署目标的 SFTP 部署会清空项目目录，
    // 生产应配到项目目录之外（同 INVOICE_URGE_STATE_FILE 口径）
    fieldsFile: process.env.OCR_FIELDS_FILE || '.ocr-fields.local.json',
  },

  // 发票采集（私聊/催办回复交票 → 识别 → 采集表）
  invoiceCollect: {
    // 报销抬头校验（可选，逗号分隔多套「名称|税号」；不配则只记录不校验）。
    // 名称与税号命中其一即放行，都不匹配 → 校验状态=抬头存疑（打回提醒）
    allowedBuyers: parseArrayConfig(process.env.INVOICE_ALLOWED_BUYERS),
    // 金额比对阈值：发票价税合计 vs 审批「总金额」，绝对差超过 max(比例, 固定) 即标记金额不符
    amountToleranceRatio: parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE_RATIO) || 0.05,
    amountToleranceFixed: parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE_FIXED) || 10,
  },

  // 报销交付包（锁定批次后自动生成：校格式物料清单 + 投递底单，照学校「智能财务服务大厅
  // 投递单」与财务《物料清单》模板口径；敏感信息（卡号）只存 .env，不进 git）
  batch: {
    // 摘要拼装：`${summaryPrefix}-${season}-${项目}-${用途}-${feeType}-第N笔`
    // 模板实例：机甲大师实验室-27赛季-对抗赛-飞镖机器人-材料费-第二十四笔
    summaryPrefix: process.env.BATCH_SUMMARY_PREFIX || '机甲大师实验室',
    season: process.env.BATCH_SEASON || '',
    feeType: process.env.BATCH_FEE_TYPE || '材料费',
    // 投递单「费用项」与物料清单「采购类型」默认值（锁定时可用 费用项=/采购类型= 覆盖）
    feeItem: process.env.BATCH_FEE_ITEM || '实验室用品',
    purchaseType: process.env.BATCH_PURCHASE_TYPE || '机器人零件',
    // 物料清单「制单人」（留空回落报销人姓名）
    preparer: process.env.BATCH_PREPARER_NAME || '',
    // 报销人（投递单抬头；工号/电话缺失底单标黄）
    reporterStuId: process.env.CQ_REPORTER_STU_ID || '',
    reporterName: process.env.CQ_REPORTER_NAME || '',
    reporterPhone: process.env.CQ_REPORTER_PHONE || '',
    // 项目归属（学校经费卡）
    projectCode: process.env.CQ_PROJECT_CODE || '',
    projectName: process.env.CQ_PROJECT_NAME || '',
    projectDept: process.env.CQ_PROJECT_DEPT || '',
    projectLeader: process.env.CQ_PROJECT_LEADER || '',
    // 转卡收款账户（敏感：只存 .env）
    bankCardNo: process.env.CQ_BANK_CARD_NO || '',
    bankName: process.env.CQ_BANK_NAME || '',
  },

  // 报销台账电子表格同步（submit 追加行 / paid·reject 回填状态；空 token = 关闭）
  ledger: {
    // 《2027年千里团队报销台账》
    spreadsheetToken: process.env.LEDGER_SPREADSHEET_TOKEN || '',
    // 工作表 sheet_id（留空 = 取第一个工作表）
    sheetId: process.env.LEDGER_SHEET_ID || '',
  },
};
