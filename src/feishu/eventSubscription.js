const lark = require('@larksuiteoapi/node-sdk');
const config = require('../config');
const { requestAPI } = require('./client');
const approvalService = require('../services/approvalService');
const { processChatMessage } = require('../services/chatService');

let wsClient = null;

function startEventSubscription() {
  if (!config.feishuEvent.useLongConnection) {
    console.log('[事件订阅] 已配置为不使用长连接模式，跳过启动（需通过HTTP回调接收事件）');
    return null;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.warn('[事件订阅] 未配置飞书应用凭证（APP_ID/APP_SECRET），跳过事件订阅');
    return null;
  }

  const baseConfig = {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.FeiShu,
    loggerLevel: lark.LoggerLevel.info,
  };

  wsClient = new lark.WSClient(baseConfig);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        // 群隔离逻辑在 chatService 内部：仅目标群响应，其余群交给正常对话能力
        await processChatMessage(data);
      } catch (err) {
        console.error('[事件订阅] 处理消息事件失败:', err.message);
      }
    },
    // 多维表格记录变更事件（V2 事件，需先调用下方订阅云文档接口）
    'drive.file.bitable_record_changed_v1': async (data) => {
      try {
        const evt = data?.event || data;
        const tableId = evt?.table_id;

        if (config.bitable.approvalTableId && tableId !== config.bitable.approvalTableId) {
          return;
        }

        // 事件体结构：event.action_list[] 内含 { action, record_id, ... }
        // 注意：长连接事件可能被其他项目的连接抢走（随机分发），
        // 这里只做「快速触发」，漏掉的部分由轮询对账兜底
        const actionList = evt?.action_list || [];
        for (const item of actionList) {
          const recordId = item?.record_id;
          const action = item?.action;
          if (!recordId) continue;

          console.log(`[事件订阅] 审批表变更: record=${recordId}, action=${action}`);

          if (action === 'record_added' || action === 'record_edited') {
            await approvalService.scheduleSync('record', recordId);
          }
          // record_deleted 仅影响快照，交给全量对账清理
        }
      } catch (err) {
        console.error('[事件订阅] 处理多维表格事件失败:', err.message);
      }
    },
  });

  wsClient.start({
    eventDispatcher,
  });

  // 多维表格记录变更事件的前置条件：先订阅对应云文档（幂等，可重复调用）
  subscribeBitableEvents().catch(err => {
    console.error('[事件订阅] 订阅云文档事件异常:', err.message);
  });

  console.log('📡 飞书事件订阅（长连接模式）已启动');
  console.log('   监听事件: im.message.receive_v1, drive.file.bitable_record_changed_v1');
  console.log(`   目标群: ${config.bot.chatId || '(未配置 BOT_CHAT_ID)'}`);
  console.log(`   监听审批表: ${config.bitable.approvalTableId || '(未配置)'}`);

  return wsClient;
}

/**
 * 订阅云文档事件（bitable 记录变更事件的前置条件）
 */
async function subscribeBitableEvents() {
  const appToken = config.bitable.appToken;
  if (!appToken) {
    console.warn('[事件订阅] 未配置 BITABLE_APP_TOKEN，跳过订阅云文档事件');
    return;
  }

  const res = await requestAPI('POST', `/drive/v1/files/${appToken}/subscribe?file_type=bitable`);
  if (res.code === 0) {
    console.log('✓ 已订阅云文档事件（多维表格记录变更）');
  } else {
    // 已订阅等场景会返回非0，仅告警不阻断启动
    console.warn(`[事件订阅] 订阅云文档事件失败: ${res.msg} (code: ${res.code})`);
  }
}

function stopEventSubscription() {
  if (wsClient) {
    wsClient.stop();
    wsClient = null;
    console.log('📡 飞书事件订阅已停止');
  }
}

/**
 * 处理HTTP回调的多维表格事件（仅在未启用长连接时使用）
 * 事件结构与长连接 V2 事件对齐
 */
async function processBitableEvent(event) {
  const { table_id } = event;

  if (config.bitable.approvalTableId && table_id !== config.bitable.approvalTableId) {
    return;
  }

  const actionList = event?.action_list || [];
  for (const item of actionList) {
    const recordId = item?.record_id;
    const action = item?.action;
    if (!recordId) continue;

    if (action === 'record_added' || action === 'record_edited') {
      await approvalService.scheduleSync('record', recordId);
    }
  }
}

module.exports = {
  startEventSubscription,
  stopEventSubscription,
  processBitableEvent,
};
