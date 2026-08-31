/**
 * 多维表格字段值 → 展示文本
 * 兼容：字符串、数字、富文本分段数组（[{type,text},...]）、公式/选项对象（{text}|{name}|{value}|{link}）
 * 避免对象直接拼进模板字符串变成 [object Object]
 */
function fieldText(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((seg) => (seg && typeof seg === 'object' ? fieldText(seg, '') : String(seg)))
      .join('');
    return joined || fallback;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.name === 'string') return value.name;
    if (typeof value.value === 'string') return value.value;
    if (value.link) {
      if (typeof value.link === 'string') return value.link;
      return String(value.link.url || '');
    }
    if (typeof value.url === 'string') return value.url;
  }
  return String(value);
}

module.exports = { fieldText };
