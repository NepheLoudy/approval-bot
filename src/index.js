const express = require('express');
const { requireApiToken } = require('./auth');
const cors = require('cors');
const config = require('./config');
const { startEventSubscription } = require('./feishu/eventSubscription');
const { processChatMessage, executeCommand } = require('./services/chatService');
const approvalService = require('./services/approvalService');
const { startCronJobs, runBroadcast, runReminder, runInvoiceUrgeOnce, getCronStatus, getBroadcastHistory } = require('./cron');

const app = express();

app.use(cors());
// 网关会转发完整事件体（表格事件含 before/after 全量字段，可能超 100kb），放宽 body 限制
app.use(express.json({ limit: '2mb' }));

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

    const reply = await executeCommand(command, args || []);
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
