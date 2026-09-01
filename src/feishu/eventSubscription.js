const lark = require('@larksuiteoapi/node-sdk');
const config = require('../config');
const { processChatMessage } = require('../services/chatService');

// ============================================================
// 事件订阅
// 生产环境事件由 feishu-gateway 唯一长连接接收并通过 HTTP 转发到
// /api/feishu/event（FEISHU_USE_LONG_CONNECTION=false），本模块仅在
// 独立长连接模式下启用。播报为纯定时任务，这里只处理消息事件。
// ============================================================

let wsClient = null;

function startEventSubscription() {
  if (!config.feishuEvent.useLongConnection) {
    console.log('[事件订阅] 已配置为不使用长连接模式，跳过启动（事件由 feishu-gateway 转发）');
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
  });

  wsClient.start({
    eventDispatcher,
  });

  console.log('📡 飞书事件订阅（长连接模式）已启动');
  console.log('   监听事件: im.message.receive_v1');
  console.log(`   目标群: ${config.bot.chatId || '(未配置 BOT_CHAT_ID)'}`);

  return wsClient;
}

function stopEventSubscription() {
  if (wsClient) {
    wsClient.stop();
    wsClient = null;
    console.log('📡 飞书事件订阅已停止');
  }
}

module.exports = {
  startEventSubscription,
  stopEventSubscription,
};
