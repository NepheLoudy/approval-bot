/**
 * 中文金额/序号格式化（纯函数，桩测试直接断言）。
 *
 * numToCnyUpper：人民币大写，投递底单「大写金额」用（如 237.04 → 贰佰叁拾柒圆零肆分）；
 * numToCnOrdinal：中文序号，摘要「第N笔」用（如 24 → 二十四）。
 * 覆盖 0 ~ 9999.99 万以内的实验报销常规区间；越界/非法输入返回空串（调用方留白人工补）。
 */

const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const CN_UNITS = ['', '拾', '佰', '仟'];
const CN_LO = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 0~9999 整数 → 中文（101 → 一百零一，110 → 一百一十，10 → 一十）；0 返回空 */
function sectionCn(num) {
  if (num <= 0) return '';
  const digits = String(num).split('').map(Number);
  let out = '';
  let pendingZero = false;
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    const unit = CN_UNITS[digits.length - 1 - i];
    if (d === 0) {
      pendingZero = Boolean(out);
    } else {
      out += (pendingZero ? '零' : '') + CN_DIGITS[d] + unit;
      pendingZero = false;
    }
  }
  return out;
}

/** n → 中文序号：1 → 一，10 → 十，11 → 十一，24 → 二十四，105 → 一百零五，111 → 一百一十一。
 *  n>999 返回空串（999 以上 CN_LO 溢位会拼出「第undefined百」垃圾值——复查 P2；
 *  调用方空串时回落「第N笔」数字兜底） */
function numToCnOrdinal(n) {
  n = Math.floor(Number(n));
  if (!(n >= 1) || n > 999) return '';
  const rest = n % 100;
  const hundreds = Math.floor(n / 100);
  let s = '';
  if (hundreds > 0) s += CN_LO[hundreds] + '百';
  if (rest === 0) return s;
  if (hundreds > 0 && rest < 10) return s + '零' + CN_LO[rest];
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  let t;
  if (tens === 0) t = CN_LO[ones];
  else if (tens === 1) t = (hundreds > 0 ? '一十' : '十') + (ones ? CN_LO[ones] : '');
  else t = CN_LO[tens] + '十' + (ones ? CN_LO[ones] : '');
  return s + t;
}

/** 金额 → 人民币大写（237.04 → 贰佰叁拾柒圆零肆分；60 → 陆拾圆整；0.5 → 伍角） */
function numToCnyUpper(n) {
  const amount = Math.round(Number(n) * 100) / 100;
  if (!isFinite(amount) || amount < 0 || amount >= 100000000) return '';
  let fen = Math.round(amount * 100);
  const yuanAll = Math.floor(fen / 100);
  fen %= 100;
  const jiao = Math.floor(fen / 10);
  const fenPart = fen % 10;

  const wanPart = Math.floor(yuanAll / 10000);
  const yuanPart = yuanAll % 10000;
  let s = '';
  if (wanPart > 0) s += sectionCn(wanPart) + '万';
  if (yuanPart > 0) {
    // 万段后有千以内的尾数需补零桥（12000 → 一万二仟圆? 口径：一万二千元 → 一万贰仟圆整，无零；
    // 10005 → 一万零五圆）
    s += (wanPart > 0 && yuanPart < 1000 ? '零' : '') + sectionCn(yuanPart);
  }
  s = s ? s + '圆' : '';
  if (!jiao && !fenPart) return (s || '零圆') + '整';
  if (jiao > 0) s += CN_DIGITS[jiao] + '角';
  else if (fenPart > 0 && s) s += '零';
  if (fenPart > 0) s += CN_DIGITS[fenPart] + '分';
  return s;
}

module.exports = { numToCnyUpper, numToCnOrdinal, sectionCn };
