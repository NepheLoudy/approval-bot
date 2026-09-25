const express = require('express');
const { requireApiToken } = require('./auth');
const cors = require('cors');
const config = require('./config');
const { startEventSubscription } = require('./feishu/eventSubscription');
const { processChatMessage, executeCommand } = require('./services/chatService');
const approvalService = require('./services/approvalService');
const ocrService = require('./services/ocrService');
const invoiceCollectService = require('./services/invoiceCollectService');
const backfillService = require('./services/backfillService');
const bot = require('./feishu/bot');
const { startCronJobs, runBroadcast, runReminder, runInvoiceUrgeOnce, getCronStatus, getBroadcastHistory } = require('./cron');

const app = express();

app.use(cors());
// 网关会转发完整事件体（表格事件含 before/after 全量字段，可能超 100kb）+ OCR 转录
// 端点直传 base64 图片（5MB 图 base64 后约 6.7MB），放宽 body 限制到 10mb
app.use(express.json({ limit: '10mb' }));

// ---------- 健康检查 ----------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    botName: config.bot.name,
    targetChatId: config.bot.chatId || null,
  });
});

// ---------- 定制窗口（规则见顶层 AGENTS「机器人后端定制窗口」）：定制项全景只读 ----------

app.get('/api/approval/policy', (req, res) => {
  res.json({
    bot: { name: config.bot.name, chatId: config.bot.chatId },
    approvalProcesses: config.approvalProcesses,
    approvalStatus: config.approvalStatus,
    approvers: config.approvers,
    invoiceUrge: config.invoiceUrge,
    reminder: config.reminder,
    cron: config.cron,
    ocr: ocrService.getPolicySummary(),
  });
});

// ---------- 审批数据查询 ----------

app.get('/api/approvals', async (req, res) => {
  try {
    const approvals = await approvalService.getAllApprovals();
    res.json(approvals);
  } catch (err) {
    console.error('获取审批列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/approvals/pending', async (req, res) => {
  try {
    const approvals = await approvalService.getPendingApprovals();
    res.json(approvals);
  } catch (err) {
    console.error('获取待审批列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/approvals/stats', async (req, res) => {
  try {
    const { stats } = await approvalService.getApprovalStats();
    res.json(stats);
  } catch (err) {
    console.error('获取审批统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/approvals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const approval = await approvalService.getApprovalById(id);
    if (!approval) {
      return res.status(404).json({ error: '审批记录不存在' });
    }
    res.json(approval);
  } catch (err) {
    console.error('获取审批详情失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 机器人管理接口 ----------

// 手动触发一次周播报；body 传 { "dryRun": true } 时只构建卡片不发送（预览用）
app.post('/api/bot/test-broadcast', requireApiToken, async (req, res) => {
  try {
    const result = await runBroadcast({ dryRun: !!req.body?.dryRun });
    res.json({ success: true, result });
  } catch (err) {
    console.error('测试播报失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-reminder', requireApiToken, async (req, res) => {
  try {
    const result = await runReminder();
    res.json({ success: true, result });
  } catch (err) {
    console.error('测试提醒失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 手动触发一次催发票私聊；body 传 { "dryRun": true } 时只构建私聊文案不发送（预览用）
app.post('/api/bot/test-invoice-urge', requireApiToken, async (req, res) => {
  try {
    const result = await runInvoiceUrgeOnce({ dryRun: !!req.body?.dryRun });
    res.json({ success: true, result });
  } catch (err) {
    console.error('测试催发票失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/cron-status', (req, res) => {
  res.json(getCronStatus());
});

app.get('/api/bot/history', (req, res) => {
  res.json(getBroadcastHistory());
});

// ---------- 发票 OCR 转录（飞书官方 OCR，免费） ----------
// 图片侧接入（消息入口）待定，本期只暴露服务端能力；调用方传
// {messageId, imageKey}（机器人可读的飞书消息）或 {imageBase64}。

// 触发动作类端点（调 OCR API），按全局工程规则挂 X-API-Token
app.post('/api/ocr/transcribe', requireApiToken, async (req, res) => {
  if (!config.ocr.enabled) {
    return res.status(503).json({ error: 'OCR 功能未启用（.env 配 OCR_ENABLED=false 关闭中）' });
  }
  try {
    const result = await ocrService.transcribe(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('发票 OCR 转录失败:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// 字段提取规则定制窗口：只读全景
app.get('/api/ocr/fields', (req, res) => {
  res.json({ fields: ocrService.getFieldRules() });
});

// 字段提取规则热改：{action: 'set', rules: [...]} 整表替换 或 {action: 'reset'} 恢复内置默认
app.post('/api/ocr/fields', requireApiToken, (req, res) => {
  const { action, rules } = req.body || {};
  try {
    if (action === 'set') {
      res.json({ success: true, fields: ocrService.setFieldRules(rules) });
    } else if (action === 'reset') {
      res.json({ success: true, fields: ocrService.resetFieldRules() });
    } else {
      res.status(400).json({ error: "action 只支持 'set'（带 rules 整表替换）或 'reset'（恢复内置默认）" });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------- 发票采集（hub 转发 p2p 图片/文件消息，duty observe 同款契约） ----------
// body: {type:'invoice_image', openId, senderName?, messageId, fileKey, msgType('image'|'file'), fileName?}
// 写端点挂 X-API-Token（hub 转发带头，同运维台代理）

app.post('/api/invoice/collect', requireApiToken, async (req, res) => {
  // 注意：采集主通道是二维码/PDF 文本直读，不依赖 OCR——这里不做 OCR_ENABLED 一刀切，
  // OCR 兜底不可用只影响拍照件（会走识别失败打回链路，队员可改发 PDF/二维码截图）
  const { openId, senderName, messageId, fileKey, msgType, fileName, type } = req.body || {};
  if (type && type !== 'invoice_image') {
    return res.status(400).json({ error: `未知转发类型: ${type}` });
  }
  if (!openId || !messageId || !fileKey) {
    return res.status(400).json({ error: '缺少参数：openId/messageId/fileKey 必填' });
  }
  try {
    const result = await invoiceCollectService.collectFromMessage({
      openId, senderName, messageId, fileKey,
      msgType: msgType || 'image', fileName: fileName || '', source: 'private',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('发票采集失败:', err);
    // 服务端失败时队员侧必须有感知（hub 是 fire-and-forget 不会转达）
    await bot.sendTextToUser(openId, `⚠️ 发票接收失败：${err.message}\n请重发一次；仍失败请直接联系财务人工登记。`).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// 存量发票回溯（管理端点）：APPROVAL_CODE 驱动——批量拉审批实例→下载附件→识别回填采集表。
// body 传 {"limit": 20, "sinceDays": 200}；未配置 APPROVAL_CODE 时返回 400 与配置指引
app.post('/api/invoice/backfill', requireApiToken, async (req, res) => {
  try {
    const result = await backfillService.backfillCollect(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('存量发票回溯失败:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------- 指令转发端点（bambu 同款契约） ----------
// 共用飞书应用的长连接事件是随机分发的，指令消息可能不会到达本服务。
// 爆米花机（project-management-robot）可在 chatService 中把 /approval-*
// 指令转发到这里：POST http://localhost:3002/api/chat/command {command, args}

app.post('/api/chat/command', async (req, res) => {
  try {
    const { command, args } = req.body;

    if (!command) {
      return res.status(400).json({ error: '指令不能为空' });
    }

    const reply = await executeCommand(command, args || [], {
      senderName: req.body.senderName || '',
      senderId: req.body.senderId || '',
    });
    if (reply === null) {
      return res.json({ reply: `❌ 未知指令：${command}\n本群仅支持财务指令，发送 /help 查看可用指令` });
    }

    res.json({ reply });
  } catch (err) {
    console.error('处理转发指令失败:', err);
    res.json({ reply: `❌ 指令执行失败：${err.message}` });
  }
});

// ---------- 飞书事件接收（feishu-gateway 转发 / 独立长连接 HTTP 回调） ----------

app.post('/api/feishu/event', async (req, res) => {
  const { type, challenge, token, header, event } = req.body;

  if (config.feishuEvent.verificationToken && token !== config.feishuEvent.verificationToken) {
    return res.status(403).json({ error: 'Invalid verification token' });
  }

  // fail-closed（2026-09-24 安全复查批，同 ticket-bot 口径）：token 未配置时旧实现整段跳过校验
  // （fail-open），伪造的消息帧可直达调试用消息处理。未配置 token 一律 403 拒绝消息事件帧；
  // url_verification 握手不受影响
  if (!config.feishuEvent.verificationToken && header?.event_type === 'im.message.receive_v1') {
    console.error(`[HTTP回调] 未配置 FEISHU_VERIFICATION_TOKEN，拒绝 ${header?.event_type} 事件帧（fail-closed）`);
    return res.status(403).json({ error: 'Verification token not configured; event frames rejected' });
  }

  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  if (config.feishuEvent.useLongConnection) {
    console.log('[HTTP回调] 已启用长连接模式，跳过HTTP回调事件处理');
    res.json({ code: 0, msg: 'success' });
    return;
  }

  const eventType = header?.event_type;

  // 播报为纯定时任务，这里只处理消息事件（指令与对话触发）
  if (eventType === 'im.message.receive_v1') {
    setImmediate(async () => {
      try {
        await processChatMessage(event);
      } catch (err) {
        console.error('处理消息事件失败:', err);
      }
    });
  }

  res.json({ code: 0, msg: 'success' });
});

// ---------- 启动 ----------

function startServer() {
  const server = app.listen(config.port, () => {
    console.log(`🚀 审批机器人运行在 http://localhost:${config.port}`);
    console.log(`📚 API 健康检查: http://localhost:${config.port}/api/health`);
    console.log(`🤖 机器人名称: ${config.bot.name}`);
    console.log(`🎯 目标群: ${config.bot.chatId || '(未配置 BOT_CHAT_ID!)'}`);
  });

  startCronJobs();
  startEventSubscription();

  process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = app;
