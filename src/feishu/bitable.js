const config = require('../config');
const { requestAPI } = require('./client');

/**
 * 拉取多维表格指定表的全部记录（自动翻页）
 * @param {string} tableId 表 ID
 * @param {string} [filter] 过滤公式，如 CurrentValue.[申请状态] = "待审批"
 * @returns {Promise<Array<{record_id: string, fields: object}>>}
 */
async function listAllRecords(tableId, filter) {
  const appToken = config.bitable.appToken;
  if (!appToken || !tableId) {
    throw new Error('未配置多维表格 appToken 或 tableId');
  }

  const records = [];
  let pageToken = '';
  const pageSize = 100;

  do {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (filter) query.set('filter', filter);
    if (pageToken) query.set('page_token', pageToken);

    const res = await requestAPI(
      'GET',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query.toString()}`
    );

    if (res.code !== 0) {
      throw new Error(`拉取多维表格记录失败: ${res.msg} (code: ${res.code})`);
    }

    const items = res.data?.items || [];
    for (const item of items) {
      records.push({ record_id: item.record_id, fields: item.fields });
    }

    pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
  } while (pageToken);

  return records;
}

/**
 * 获取单条记录
 * @param {string} tableId 表 ID
 * @param {string} recordId 记录 ID
 */
async function getRecord(tableId, recordId) {
  const appToken = config.bitable.appToken;
  if (!appToken || !tableId || !recordId) {
    throw new Error('未配置多维表格 appToken/tableId 或 recordId');
  }

  const res = await requestAPI(
    'GET',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`
  );

  if (res.code !== 0) {
    throw new Error(`获取记录失败: ${res.msg} (code: ${res.code})`);
  }

  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 新建记录
 * @returns {Promise<{record_id: string, fields: object}>}
 */
async function createRecord(tableId, fields) {
  const appToken = config.bitable.appToken;
  const res = await requestAPI(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { fields }
  );
  if (res.code !== 0) {
    throw new Error(`写入多维表格记录失败: ${res.msg} (code: ${res.code})`);
  }
  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 更新记录（部分字段）
 * @returns {Promise<{record_id: string, fields: object}>}
 */
async function updateRecord(tableId, recordId, fields) {
  const appToken = config.bitable.appToken;
  const res = await requestAPI(
    'PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields }
  );
  if (res.code !== 0) {
    throw new Error(`更新多维表格记录失败: ${res.msg} (code: ${res.code})`);
  }
  return { record_id: res.data.record.record_id, fields: res.data.record.fields };
}

/**
 * 按表名查表（不存在返回 null）。建表脚本/采集表定位用。
 */
async function findTableByName(tableName) {
  const appToken = config.bitable.appToken;
  const res = await requestAPI('GET', `/bitable/v1/apps/${appToken}/tables?page_size=100`);
  if (res.code !== 0) {
    throw new Error(`拉取表清单失败: ${res.msg} (code: ${res.code})`);
  }
  const hit = (res.data.items || []).find(t => t.name === tableName);
  return hit ? { tableId: hit.table_id, name: hit.name } : null;
}

/**
 * 建表（已存在同名表则直接返回既有 table_id，幂等）
 */
async function ensureTable(tableName) {
  const existing = await findTableByName(tableName);
  if (existing) return existing;
  const appToken = config.bitable.appToken;
  const res = await requestAPI('POST', `/bitable/v1/apps/${appToken}/tables`, { table: { name: tableName } });
  if (res.code !== 0) {
    throw new Error(`建表失败: ${res.msg} (code: ${res.code})`);
  }
  return { tableId: res.data.table_id, name: tableName };
}

/**
 * 建字段（字段名已存在则跳过，幂等）。field 对象为飞书字段描述 {field_name, type, ui_type?, property?}
 */
async function ensureField(tableId, field) {
  const appToken = config.bitable.appToken;
  const list = await requestAPI('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
  if (list.code !== 0) {
    throw new Error(`拉取字段清单失败: ${list.msg} (code: ${list.code})`);
  }
  if ((list.data.items || []).some(f => f.field_name === field.field_name)) {
    return { created: false };
  }
  const res = await requestAPI('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field);
  if (res.code !== 0) {
    throw new Error(`建字段失败（${field.field_name}）: ${res.msg} (code: ${res.code})`);
  }
  return { created: true };
}

module.exports = {
  listAllRecords,
  getRecord,
  createRecord,
  updateRecord,
  findTableByName,
  ensureTable,
  ensureField,
};
