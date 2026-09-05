const fs = require('fs');
const path = require('path');

// ============================================================
// 催发票私聊状态持久化
//
// 记录维度（record_id → 状态）：
//   urgeCount    私聊已触发次数（满 maxTimes 升级财务，停止私聊）
//   snoozeUntil  延期截止毫秒时间戳（申请延期后 N 天内不再私聊）
//   status       none | deferred(延期中) | cannot_submit(无法提交) | escalated(已催满)
//   lastUrgeAt   最近一次私聊时间
// 用户维度（open_id → 会话）：
//   chatId             p2p 会话 ID（发私聊时从响应取，用于轮询回复）
//   lastUrgeRecordIds  最近一次私聊涉及的记录（回复「延期/无法提交」按批次生效）
//   lastReadTime       已读取到该会话的最早未读位置（毫秒）
//
// 持久化为 JSON 文件：pm2 重启不丢；NAS 的 SFTP 部署会清空项目目录，
// 生产路径应配到项目目录之外（INVOICE_URGE_STATE_FILE）。
// ============================================================

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'urge-state.json');

let stateFile = DEFAULT_FILE;
let state = { records: {}, users: {} };

function init(file) {
  if (file) stateFile = file;
  state = load();
  return module.exports; // 返回模块本身，支持 .init(path).allRecords() 链式取快照
}

function load() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      records: parsed.records || {},
      users: parsed.users || {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[催发票状态] 读取失败（使用空状态继续）: ${err.message}`);
    }
    return { records: {}, users: {} };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[催发票状态] 写入失败: ${err.message}`);
  }
}

function getRecord(recordId) {
  return state.records[recordId] || null;
}

function updateRecord(recordId, patch) {
  const cur = state.records[recordId] || {
    urgeCount: 0,
    snoozeUntil: 0,
    status: 'none',
    lastUrgeAt: 0,
    statusNote: '',
  };
  state.records[recordId] = Object.assign(cur, patch, { updatedAt: Date.now() });
  save();
  return state.records[recordId];
}

function getUser(openId) {
  return state.users[openId] || null;
}

function updateUser(openId, patch) {
  const cur = state.users[openId] || { chatId: '', lastUrgeRecordIds: [], lastReadTime: 0 };
  state.users[openId] = Object.assign(cur, patch);
  save();
  return state.users[openId];
}

/** 清理已不在超期名单里的记录（已交票/记录失效），返回清理条数 */
function prune(validRecordIds) {
  const valid = new Set(validRecordIds);
  let removed = 0;
  for (const id of Object.keys(state.records)) {
    if (!valid.has(id)) {
      delete state.records[id];
      removed++;
    }
  }
  for (const u of Object.values(state.users)) {
    if (Array.isArray(u.lastUrgeRecordIds)) {
      u.lastUrgeRecordIds = u.lastUrgeRecordIds.filter((id) => valid.has(id));
    }
  }
  if (removed > 0) save();
  return removed;
}

/** 全量快照（周报状态徽标、调试用）：{ record_id: state } */
function allRecords() {
  return state.records;
}

/** 全量用户会话快照（回复轮询遍历用）：{ open_id: {chatId, lastUrgeRecordIds, lastReadTime} } */
function allUsers() {
  return state.users;
}

module.exports = {
  init,
  getRecord,
  updateRecord,
  getUser,
  updateUser,
  prune,
  allRecords,
  allUsers,
};
