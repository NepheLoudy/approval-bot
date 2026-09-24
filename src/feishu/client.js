const config = require('../config');

const BASE_URL = 'https://open.feishu.cn/open-apis';

// tenant_access_token 缓存，避免每次调用都重新获取
let tokenCache = { token: null, expiresAt: 0 };

/**
 * 获取飞书 tenant_access_token（带缓存，提前 60 秒过期）
 */
async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60 * 1000) {
    return tokenCache.token;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error('未配置飞书应用凭证 (APP_ID/APP_SECRET)');
  }

  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`);
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + data.expire * 1000,
  };
  return tokenCache.token;
}

/**
 * 调用飞书开放平台 API
 * @param {string} method HTTP 方法
 * @param {string} path 路径（以 / 开头，不含 host）
 * @param {object} body 请求体（GET 时传 null）
 * @param {object} [opts] 可选项：opts.timeoutMs 覆盖默认超时（OCR 等大请求体接口用）
 * @returns {Promise<object>} 飞书返回的完整 JSON（含 code/msg/data）
 */
async function requestAPI(method, path, body, opts = {}) {
  const token = await getTenantAccessToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    // 无超时的 fetch 挂起会拖死定时任务（如催发票互斥锁永不释放），15s 强制超时
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`飞书 API 返回非 JSON 响应 (HTTP ${res.status}): ${path}`);
  }
}

/**
 * 下载 IM 消息资源（图片/文件二进制）。需应用开通「获取与上传图片或资源」(im:resource) 权限。
 * 用户发送的图片不能用 GET /im/v1/images/{image_key}（该接口只能下载机器人
 * 自己上传的图片，飞书对用户图片报 234001），必须走消息资源接口：
 * GET /im/v1/messages/{message_id}/resources/{file_key}?type=image|file
 * （duty-bot v28 同款实现；发票采集下载队员回传的图片与 PDF 均走本函数）
 */
async function downloadMessageResource(messageId, fileKey, fileType = 'image') {
  if (!messageId) {
    throw new Error('下载资源失败: 缺少 message_id（消息资源接口必填）');
  }
  const token = await getTenantAccessToken();
  const res = await fetch(
    `${BASE_URL}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(fileType)}`,
    {
      method: 'GET',
      signal: AbortSignal.timeout(30000),
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || contentType.includes('application/json')) {
    // 出错时飞书返回 JSON 错误体（如权限未开通）
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = `${body.code || res.status}: ${body.msg || ''}`;
    } catch (err) { /* 非 JSON 错误体，保留 HTTP 状态 */ }
    throw new Error(`下载资源失败: ${msg}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new Error('下载资源失败: 空响应');
  }
  return buf;
}

// 兼容别名（v44 引入时的名字）
const downloadImage = (messageId, imageKey) => downloadMessageResource(messageId, imageKey, 'image');

/**
 * 上传媒体到多维表格，返回可直接写入附件字段的 file_token（duty-bot 同款）。
 * parent_type=bitable_file（附件字段），parent_node=多维表格 base 的 app_token。
 * 需应用开通 drive:file:upload（上传、下载文件到云空间）权限。
 */
async function uploadMediaToBitable(buffer, fileName) {
  const token = await getTenantAccessToken();
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', config.bitable.appToken);
  form.append('size', String(buffer.length));
  form.append('file', new Blob([buffer]), fileName);

  const res = await fetch(`${BASE_URL}/drive/v1/medias/upload_all`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!data || data.code !== 0 || !data.data || !data.data.file_token) {
    const msg = data ? `${data.code}: ${data.msg}` : `HTTP ${res.status} 非 JSON 响应`;
    throw new Error(`上传媒体到多维表格失败: ${msg}`);
  }
  return data.data.file_token;
}

/**
 * 下载云空间媒体（采集表/批次表附件字段的 file_token → 原文件二进制）。
 * 批次打印 PDF 排版时取回发票原件用。需 drive 读权限（与 uploadMediaToBitable 同域）。
 */
async function downloadMedia(fileToken) {
  const token = await getTenantAccessToken();
  const res = await fetch(`${BASE_URL}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
    method: 'GET',
    signal: AbortSignal.timeout(60000),
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = `${body.code || res.status}: ${body.msg || ''}`;
    } catch (err) { /* 非 JSON 错误体 */ }
    throw new Error(`下载媒体失败: ${msg}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载媒体失败: 空响应');
  return buf;
}

/**
 * 获取审批实例详情（存量发票回溯用）。form 为 JSON 字符串数组（每个控件一项），
 * 附件控件的 value 内含 file_id/file_code 引用。需审批只读权限。
 */
async function getApprovalInstance(instanceId) {
  return requestAPI('GET', `/approval/v4/instances/${encodeURIComponent(instanceId)}`);
}

/**
 * 下载审批附件（探测式：飞书各文档源对下载路径表述不一，依次尝试两个候选路径，
 * 全部失败抛出聚合错误。若路径有变，改这里的候选清单即可）。
 */
async function downloadApprovalFile(instanceId, fileId) {
  const token = await getTenantAccessToken();
  const candidates = [
    `${BASE_URL}/approval/v4/instances/${encodeURIComponent(instanceId)}/files/${encodeURIComponent(fileId)}?type=attachment`,
    `${BASE_URL}/approval/v4/files/${encodeURIComponent(fileId)}?instance_id=${encodeURIComponent(instanceId)}`,
  ];
  const errors = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(30000),
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || contentType.includes('application/json')) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          msg = `${body.code || res.status}: ${body.msg || ''}`;
        } catch (e) { /* 非 JSON */ }
        errors.push(`${url.replace(BASE_URL, '')} → ${msg}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        errors.push(`${url.replace(BASE_URL, '')} → 空响应`);
        continue;
      }
      return buf;
    } catch (err) {
      errors.push(`${url.replace(BASE_URL, '')} → ${err.message}`);
    }
  }
  throw new Error(`审批附件下载失败（候选路径均不可用）: ${errors.join(' | ')}`);
}

module.exports = {
  getTenantAccessToken,
  requestAPI,
  downloadImage,
  downloadMessageResource,
  uploadMediaToBitable,
  downloadMedia,
  getApprovalInstance,
  downloadApprovalFile,
};
