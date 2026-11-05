/**
 * 上海时区日期工具（对抗审查 P2-3：全项目统一 UTC+8 口径——
 * 此前台账日期/批次号 MMDD/播报日期各自用服务器本地时区，部署机 TZ≠Asia/Shanghai
 * 时跨日边界（上海 00:00–08:00）日期倒退一天）。
 * 算法同 quietHours：毫秒 + 8h 后按 UTC 取年月日。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 毫秒 → 'YYYY/M/D'（台账人工填写风格） */
function shanghaiYmdSlash(ms) {
  const d = new Date((ms || Date.now()) + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 毫秒 → 'M-D'（播报短日期） */
function shanghaiMdDash(ms) {
  const d = new Date((ms || Date.now()) + TZ_OFFSET_MS);
  return `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/** 毫秒 → 'YYYY-MM-DD'（卡片日期，0 填充；fmtTime 同格式随本批改走上海时区） */
function shanghaiYmdDash(ms) {
  const d = new Date((ms || Date.now()) + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 毫秒 → 'MMDD'（自动批次号用） */
function shanghaiMmdd(ms) {
  const d = new Date((ms || Date.now()) + TZ_OFFSET_MS);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 发票开票日期文本（'YYYY-MM-DD'）→ 上海时区当日零点毫秒；非法返回 null。
 *  两道闸（2026-11-03 审查 P2）：①解析 NaN（13 月等语法非法）→ null；
 *  ②回读比对——V8 对「语法合法但日历不存在」的日期（2026-02-30）不报错而是
 *  静默滚动到 2026-03-02，回读与原文不一致同样拒绝。落库前必须走本函数：
 *  NaN/滚动毫秒写进「开票日期」列要么整条报错、要么日期漂移，都会让三元组
 *  近似查重对该票失效。 */
function issueDateToMs(issueDate) {
  if (!issueDate) return null;
  const s = String(issueDate).trim();
  const ms = Math.floor(new Date(`${s}T00:00:00+08:00`).getTime());
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + TZ_OFFSET_MS);
  const round = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return round === s ? ms : null;
}

module.exports = { shanghaiYmdSlash, shanghaiMdDash, shanghaiYmdDash, shanghaiMmdd, issueDateToMs };
