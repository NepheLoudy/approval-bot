const express = require('express');
const cors = require('cors');
const config = require('./config');
const { startEventSubscription, processBitableEvent } = require('./feishu/eventSubscription');
const { processChatMessage } = require('./services/chatService');
const approvalService = require('./services/approvalService');
const { startCronJobs, runBroadcast, getCronStatus, getBroadcastHistory } = require('./cron');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    botName: config.bot.name,
  });
});

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

app.post('/api/bot/test-broadcast', async (req, res) => {
  try {
    const result = await runBroadcast();
    res.json({ success: true, result });
  } catch (err) {
    console.error('测试播报失败:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/cron-status', (req, res) => {
  res.json(getCronStatus());
});

app.get('/api/bot/history', (req, res) => {
  res.json(getBroadcastHistory());
});

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

  if (header?.event_type === 'bitable.record.create' || header?.event_type === 'bitable.record.update') {
    setImmediate(async () => {
      try {
        const tableId = event?.table_id;
        const recordId = event?.record?.record_id;
        const actionType = header?.event_type === 'bitable.record.create' ? 'create' : 'update';
        const fields = event?.record?.fields;

        if (tableId && recordId && fields) {
          const bitableEvent = {
            table_id: tableId,
            record_id: recordId,
            action_type: actionType,
            fields: fields,
          };
          await processBitableEvent(bitableEvent);
        }
      } catch (err) {
        console.error('处理飞书事件失败:', err);
      }
    });
  }

  if (header?.event_type === 'im.message.receive_v1') {
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

function startServer() {
  const server = app.listen(config.port, () => {
    console.log(`🚀 审批机器人运行在 http://localhost:${config.port}`);
    console.log(`📚 API 健康检查: http://localhost:${config.port}/api/health`);
    console.log(`🤖 机器人名称: ${config.bot.name}`);
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
