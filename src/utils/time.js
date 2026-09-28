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

/** 毫秒 → 'MMDD'（自动批次号用） */
function shanghaiMmdd(ms) {
  const d = new Date((ms || Date.now()) + TZ_OFFSET_MS);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

module.exports = { shanghaiYmdSlash, shanghaiMdDash, shanghaiMmdd };
