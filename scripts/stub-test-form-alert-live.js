// form_alert_live 冲刷执行器注册 stub 测试（2026-10-30 审查批 P1）：
// formAlertService.triggerAfterCollect 以 'form_alert_live' 落晚间静默积压，cron 侧必须
// 注册同名执行器——此前 quietTaskRunners 漏了该键，冲刷时 runners.get() 为 undefined，
// 夜间采集触发的自动锁定补跑必失败被丢弃（FORM_ALERT_SCHEDULE 留空组合下永久丢失）。
// 注册链 = cron 启动时遍历 quietTaskRunners 逐个 quietHours.registerTask，
// 故断言该表含键且可执行引用，即覆盖注册缺口。
const assert = require('assert');
const cron = require('../src/cron/index');
const quietHours = require('../src/utils/quietHours');

assert.ok(cron.quietTaskRunners, 'cron 应透出 quietTaskRunners 表');
assert.ok(cron.quietTaskRunners.form_alert_live, "quietTaskRunners 应含 'form_alert_live' 键（采集落库即时触发的冲刷执行器）");
assert.strictEqual(typeof cron.quietTaskRunners.form_alert_live, 'function', "'form_alert_live' 应为可调用 runner");
assert.ok(cron.quietTaskRunners.form_alert !== cron.quietTaskRunners.form_alert_live, '与每日兜底 form_alert 应为独立键（fireKey 按任务名隔离）');

// 2026-11-03 审查批 P2：抬头警报卡改走 gatePayload 静默闸（此前全仓唯一绕闸自动群播）——
// 落盘载荷必须有已注册补发处理器，否则冲刷时报「未注册补发处理器」整条丢弃
assert.ok(quietHours.payloadHandlers, 'quietHours 应透出 payloadHandlers 表');
assert.strictEqual(typeof quietHours.payloadHandlers.invoice_buyer_alert, 'function', "'invoice_buyer_alert'（非重大抬头发票警报卡）应有已注册补发处理器");

console.log('✅ form_alert_live 注册 stub：6 断言全过');
