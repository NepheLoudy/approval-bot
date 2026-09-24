/**
 * 发票图像 OCR 转录服务
 *
 * 引擎：飞书官方 OCR（免费，单租户 20 QPS，图片 <5MB）
 *   POST /open-apis/optical_char_recognition/v1/image/basic_recognize
 *   入参 {image: base64}，出参 data.text_list（按区域分段的文本列表，无坐标）。
 *   数据不出飞书体系：发票图下载自飞书消息、识别在飞书侧完成，不经第三方。
 *
 * 「某些区域转录」的实现：飞书 OCR 只返回分段文本无坐标，因此区域提取用
 * 可配置的字段规则（标签锚点 / 正则）在分段文本上完成；规则经定制窗口
 * （GET/POST /api/ocr/fields）热改，持久化见 ocrFieldsFile。
 *
 * 图片不落盘：消息图片下载为内存 Buffer → base64 → OCR，转录结果不持久化。
 */
const fs = require('fs');
const path = require('path');
const client = require('../feishu/client');
const config = require('../config');

const OCR_API_PATH = '/open-apis/optical_char_recognition/v1/image/basic_recognize';

// ============================================================
// 内置默认字段规则（增值税发票/数电票常见字段）。
// 真实票据 text_list 分段形态以实际识别结果为准，联调时可用
// /api/ocr/transcribe 返回的 segments 调整后经 /api/ocr/fields 热改。
// ============================================================
const DEFAULT_FIELD_RULES = [
  { key: 'invoice_no', label: '发票号码', type: 'anchor', keywords: ['发票号码', '发票号'], take: 'same_or_next' },
  { key: 'invoice_date', label: '开票日期', type: 'anchor', keywords: ['开票日期'], take: 'same_or_next' },
  { key: 'buyer_name', label: '购买方名称', type: 'anchor', keywords: ['购买方名称', '购买方'], take: 'same_or_next' },
  { key: 'buyer_tax_no', label: '购买方税号', type: 'anchor', keywords: ['统一社会信用代码', '纳税人识别号'], take: 'same_or_next', occurrence: 1 },
  { key: 'seller_name', label: '销售方名称', type: 'anchor', keywords: ['销售方名称', '销售方'], take: 'same_or_next' },
  { key: 'seller_tax_no', label: '销售方税号', type: 'anchor', keywords: ['统一社会信用代码', '纳税人识别号'], take: 'same_or_next', occurrence: 2 },
  { key: 'total_amount', label: '价税合计(小写)', type: 'regex', pattern: '(?:小写[)：):\\s]*)?[¥￥]\\s*([0-9,]+(?:\\.[0-9]+)?)' },
  { key: 'total_upper', label: '价税合计(大写)', type: 'anchor', keywords: ['大写'], take: 'same' },
];

const TAKE_MODES = ['same', 'next', 'same_or_next'];

// ---------- 规则校验（定制窗口写入口与持久化加载共用） ----------

function validateRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: '规则必须是数组' };
  if (rules.length > 100) return { ok: false, error: '规则数量不能超过 100 条' };
  const seenKeys = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') return { ok: false, error: '规则必须是对象' };
    if (typeof rule.key !== 'string' || !/^[a-zA-Z0-9_]{1,40}$/.test(rule.key)) {
      return { ok: false, error: `规则 key 非法（1-40 位字母数字下划线）: ${JSON.stringify(rule.key)}` };
    }
    if (seenKeys.has(rule.key)) return { ok: false, error: `规则 key 重复: ${rule.key}` };
    seenKeys.add(rule.key);
    if (typeof rule.label !== 'string' || !rule.label.trim()) {
      return { ok: false, error: `规则 ${rule.key} 缺少 label` };
    }
    if (rule.type === 'anchor') {
      if (!Array.isArray(rule.keywords) || rule.keywords.length === 0
        || !rule.keywords.every(k => typeof k === 'string' && k.trim())) {
        return { ok: false, error: `规则 ${rule.key}（anchor）缺少 keywords 字符串数组` };
      }
      if (rule.take !== undefined && !TAKE_MODES.includes(rule.take)) {
        return { ok: false, error: `规则 ${rule.key} take 只能是 ${TAKE_MODES.join('/')}` };
      }
      if (rule.occurrence !== undefined && (!Number.isInteger(rule.occurrence) || rule.occurrence < 1)) {
        return { ok: false, error: `规则 ${rule.key} occurrence 必须是正整数` };
      }
    } else if (rule.type === 'regex') {
      if (typeof rule.pattern !== 'string' || !rule.pattern) {
        return { ok: false, error: `规则 ${rule.key}（regex）缺少 pattern` };
      }
      try { new RegExp(rule.pattern); } catch (err) {
        return { ok: false, error: `规则 ${rule.key} 的 pattern 非法: ${err.message}` };
      }
    } else {
      return { ok: false, error: `规则 ${rule.key} 的 type 只能是 anchor/regex` };
    }
  }
  return { ok: true };
}

// ---------- 字段提取规则引擎（纯函数，桩测试直接断言） ----------

// 去掉取值文本前后的冒号（中英文）、空白与装饰符
function cleanValue(text) {
  if (!text) return '';
  return text.replace(/^[\s:：.、,，\-—)）]+|[\s:：]+$/g, '').trim();
}

// 本段内取关键词之后的文本（如「发票号码:24312」→「24312」）
function takeSame(segment, keyword) {
  const idx = segment.indexOf(keyword);
  if (idx === -1) return '';
  return cleanValue(segment.slice(idx + keyword.length));
}

// 命中分段之后第一个非空分段整段取值（买方名称与值分行时的形态）
function takeNext(segments, hitIndex) {
  for (let i = hitIndex + 1; i < segments.length; i++) {
    const value = cleanValue(segments[i]);
    if (value) return value;
  }
  return '';
}

/**
 * 按规则从 OCR 分段文本中提取字段
 * @param {string[]} segments OCR 返回的 text_list
 * @param {Array} rules 字段规则清单
 * @returns {object} {fields: {key: value|null}, misses: [key]}
 */
function extractFields(segments, rules) {
  const fields = {};
  const misses = [];
  const list = Array.isArray(segments) ? segments : [];

  for (const rule of rules) {
    let value = null;

    if (rule.type === 'anchor') {
      const nth = Math.max(1, rule.occurrence || 1);
      let hits = 0;
      for (let i = 0; i < list.length; i++) {
        const keyword = rule.keywords.find(k => list[i].includes(k));
        if (!keyword) continue;
        hits++;
        if (hits < nth) continue;
        const take = rule.take || 'same_or_next';
        if (take === 'next') {
          value = takeNext(list, i) || null;
        } else {
          const same = takeSame(list[i], keyword);
          if (same) {
            value = same;
          } else if (take === 'same_or_next') {
            value = takeNext(list, i) || null;
          }
          // take === 'same'：只认本段，本段无值即 null（不跨段回落）
        }
        break;
      }
    } else if (rule.type === 'regex') {
      const re = new RegExp(rule.pattern);
      for (const segment of list) {
        const match = segment.match(re);
        if (match) {
          value = (match[1] !== undefined ? match[1] : match[0]).trim();
          break;
        }
      }
    }

    fields[rule.key] = value;
    if (value === null || value === '') misses.push(rule.key);
  }

  return { fields, misses };
}

// ---------- 字段规则持久化与热改（定制窗口） ----------
// 规则文件与 INVOICE_URGE_STATE_FILE 同款考量：SFTP 部署会清空项目目录，
// 生产环境应把 OCR_FIELDS_FILE 配到项目目录之外；项目内的该文件已加入
// push.js 打包排除清单，不会被「本地种子」覆盖部署目标。

let fieldsCache = null;

function fieldsFilePath() {
  return path.isAbsolute(config.ocr.fieldsFile)
    ? config.ocr.fieldsFile
    : path.join(__dirname, '..', '..', config.ocr.fieldsFile);
}

function loadFieldRules() {
  if (fieldsCache) return fieldsCache;
  const file = fieldsFilePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const check = validateRules(parsed);
    if (!check.ok) throw new Error(check.error);
    fieldsCache = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[ocr] 字段规则文件加载失败（${err.message}），回退内置默认规则`);
    }
    fieldsCache = JSON.parse(JSON.stringify(DEFAULT_FIELD_RULES));
    saveFieldRules(fieldsCache); // 首次落盘种子，方便在文件上直接改
  }
  return fieldsCache;
}

function saveFieldRules(rules) {
  const file = fieldsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rules, null, 2), 'utf8');
}

function getFieldRules() {
  return JSON.parse(JSON.stringify(loadFieldRules()));
}

// 整表替换（POST /api/ocr/fields {action:'set', rules}），校验不过抛错
function setFieldRules(rules) {
  const check = validateRules(rules);
  if (!check.ok) {
    const err = new Error(check.error);
    err.statusCode = 400;
    throw err;
  }
  fieldsCache = JSON.parse(JSON.stringify(rules));
  saveFieldRules(fieldsCache);
  return getFieldRules();
}

function resetFieldRules() {
  return setFieldRules(JSON.parse(JSON.stringify(DEFAULT_FIELD_RULES)));
}

// ---------- OCR 识别 ----------

/**
 * 图片 Buffer → 飞书 OCR 分段文本
 */
async function recognizeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('OCR 失败: 图片内容为空');
  }
  if (buffer.length > config.ocr.maxImageBytes) {
    throw new Error(`OCR 失败: 图片 ${(buffer.length / 1024 / 1024).toFixed(2)}MB 超过上限 `
      + `${(config.ocr.maxImageBytes / 1024 / 1024).toFixed(0)}MB（飞书 OCR 限制 5MB）`);
  }

  const data = await client.requestAPI('POST', OCR_API_PATH, { image: buffer.toString('base64') }, {
    timeoutMs: config.ocr.timeoutMs,
  });
  if (data.code !== 0) {
    // 常见：权限未开通（99991672/99991661 为租户权限类错误）、图片格式不支持
    throw new Error(`飞书 OCR 失败: ${data.msg} (code: ${data.code})`);
  }
  const textList = Array.isArray(data.data?.text_list) ? data.data.text_list : [];
  if (!textList.length) {
    throw new Error('飞书 OCR 未识别出文字（图片可能不是票据/清晰度不足）');
  }
  return textList;
}

/**
 * 统一转录入口
 * @param {object} payload {messageId, imageKey}（从飞书消息下载）或 {imageBase64}
 * @returns {object} {segments, fullText, fields, misses, meta}
 */
async function transcribe(payload = {}) {
  const startedAt = Date.now();
  const useBase64 = Boolean(payload.imageBase64);

  let buffer;
  let source;
  if (useBase64) {
    buffer = Buffer.from(payload.imageBase64, 'base64');
    source = 'base64';
  } else {
    if (!payload.messageId || !payload.imageKey) {
      throw new Error('缺少参数：需提供 {messageId, imageKey} 或 {imageBase64}');
    }
    buffer = await client.downloadImage(payload.messageId, payload.imageKey);
    source = 'message';
  }

  const segments = await recognizeBuffer(buffer);
  const rules = getFieldRules();
  const { fields, misses } = extractFields(segments, rules);

  return {
    segments,
    fullText: segments.join('\n'),
    fields,
    misses,
    meta: {
      source,
      bytes: buffer.length,
      durationMs: Date.now() - startedAt,
      segmentCount: segments.length,
      charCount: segments.join('').length,
    },
  };
}

function getPolicySummary() {
  const rules = getFieldRules();
  return {
    engine: 'feishu_ocr_basic_recognize',
    enabled: config.ocr.enabled,
    maxImageBytes: config.ocr.maxImageBytes,
    fieldsFile: config.ocr.fieldsFile,
    fieldCount: rules.length,
    fields: rules.map(r => ({ key: r.key, label: r.label, type: r.type })),
  };
}

module.exports = {
  DEFAULT_FIELD_RULES,
  OCR_API_PATH,
  validateRules,
  extractFields,
  recognizeBuffer,
  transcribe,
  getFieldRules,
  setFieldRules,
  resetFieldRules,
  getPolicySummary,
};
