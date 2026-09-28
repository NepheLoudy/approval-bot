const crypto = require('crypto');

// ============================================================
// 管理端点鉴权（2026-09-13，gateway auth.js 同款模板）：
// 写/配置类 POST 端点需带 X-API-Token 头（API_TOKEN，.env 存储随 push 下发，
// 全工作区共享同一值；运维台代理自动带头）。fail-closed：未配置 = 端点锁定。
// /api/feishu/event 与 /api/chat/command 不挂本中间件（2026-09-13 原口径）——
// **2026-09-29 对抗审查 P1-2 推翻后半句**：command 是资金指令通道（lock/submit/
// paid/reject），调用方只有 hub（服务间转发，非用户直连），零鉴权+全开放 CORS
// 时本机进程/浏览器 CSRF 可伪造资金状态。已挂 requireApiToken，hub 转发同批补
// X-API-Token 头（先 hub 后 approval 部署，链路无断窗）；/api/feishu/event 仍不挂
// （网关侧有 verificationToken 校验，双链路各自把门）。
// ============================================================

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireApiToken(req, res, next) {
  const expected = process.env.API_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: '本服务未配置 API_TOKEN，管理端点已锁定（在 .env 配置后重启生效）' });
  }
  const provided = req.get('X-API-Token') || ''; // R10②：废除 ?token= 查询串传参（token 会进访问日志/代理日志）
  if (!safeEqual(provided, expected)) {
    return res.status(403).json({ error: '鉴权失败：X-API-Token 缺失或不匹配' });
  }
  next();
}

module.exports = { requireApiToken };
