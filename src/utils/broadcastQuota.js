/**
 * 群播报当日量熔断（2026-09-30 曼波定）：自动化消息失控时保护财务群不被刷屏。
 *
 * 机制：bot.js 的群播出口（webhook 卡/文本、IM 卡/文本）发送前计数，同一类型
 * 当日超过 config.broadcast.dailyQuotaPerType（默认 3）张即拒发并在日志告警；
 * 当天第一次触发熔断时发一张独立的「🛑」告警卡（自身限额 1 张/天，不在各类型额度内）。
 *
 * 类型 key 取卡片标题去 emoji 后的前 10 字（「财务催办周报」「报销单已生成」等同源卡
 * 自然归并）；文本消息取正文前 10 字。计数按上海日历日滚动，JSON 持久化（pm2 重启不丢；
 * SFTP 部署清空可接受——重启清零只影响当天已计数，失控场景由日志告警兜底）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'broadcast-quota.json');

let stateFile = DEFAULT_FILE;
let state = { date: '', counts: {} };

function init(file) {
  if (file) stateFile = file;
  state = load();
  return module.exports;
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { date: parsed.date || '', counts: parsed.counts || {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[播报熔断] 状态读取失败（按空计数继续）: ${err.message}`);
    return { date: '', counts: {} };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmpFile = `${stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, stateFile);
  } catch (err) {
    console.warn(`[播报熔断] 状态写入失败: ${err.message}`);
  }
}

/** 标题/正文 → 类型 key（去 emoji 取前 10 字；同源卡自然归并） */
function keyOf(text) {
  const stripped = String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .trim();
  return stripped.slice(0, 10) || 'unknown';
}

/** 上海日历日 key（utils/time 同款 +8h 取 UTC） */
function todayKey() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 计数并判定是否放行。
 * @param {string} titleOrText 卡片标题或文本正文
 * @returns {{allowed: boolean, key: string, count: number, limit: number}}
 */
function checkAndCount(titleOrText) {
  const today = todayKey();
  if (state.date !== today) state = { date: today, counts: {} };
  const key = keyOf(titleOrText);
  const count = (state.counts[key] || 0) + 1;
  state.counts[key] = count;
  save();
  const limit = config.broadcast.dailyQuotaPerType;
  return { allowed: count <= limit, key, count, limit };
}

/** 熔断告警卡当天是否已发过（每类型只响一声） */
function alertAlreadySent(today) {
  return Boolean(state.alerts && state.alerts[today]);
}

function markAlertSent(today) {
  if (state.date !== today) state = { date: today, counts: {} };
  state.alerts = state.alerts || {};
  state.alerts[today] = true;
  save();
}

module.exports = {
  init,
  checkAndCount,
  keyOf,
  todayKey,
  alertAlreadySent,
  markAlertSent,
};
