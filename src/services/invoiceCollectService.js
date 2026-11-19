/**
 * 发票采集服务：私聊/催办回复交票 → 三通道识别 → 校验闸 → 金额归类匹配 → 落表 → 回执/打回。
 *
 * 口径铁律：
 * - 采集表为唯一真源；审批表「补交发票」栏只是财务可见的镜像（采集成功时回写附件，
 *   先读后 append + 按记录串行防并发丢图，duty-bot expressService 同款经验）；
 * - 「发票」与「补交发票」栏等价（hasInvoiceSubmitted 两栏任一有值即已交），本服务
 *   只写「补交发票」栏——「发票」栏是审批系统管理的 Url 形态，且修改审批仅一次机会；
 * - 队员交票后不会自行修改审批（曼波 2026-09-25 确认），镜像被覆盖的风险可忽略。
 */
const config = require('../config');
const client = require('../feishu/client');
const bot = require('../feishu/bot');
const bitableApi = require('../feishu/bitable');
const approvalService = require('./approvalService');
const collectStore = require('./collectStore');
const ocrService = require('./ocrService');
const invoiceParser = require('./invoiceParser');
const { issueDateToMs } = require('../utils/time');
const quietHours = require('../utils/quietHours');
// 延迟使用（函数体内 require）：formAlertService 顶部连着 batchService 重依赖
// （pdf-lib/exceljs/sharp），采集链路不常驻加载
let formAlertService = null;

// 查重/回写附件的按记录串行锁（附件字段整列覆盖，并发读改写会互相丢图）
// 完成后清理 entry（照 batchService.withLock 同款模式）：此前只增不删，长期运行缓慢爬升
const recordLocks = new Map();
async function withRecordLock(key, fn) {
  const prev = recordLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const wrapped = run.catch(() => {});
  recordLocks.set(key, wrapped);
  try {
    return await run;
  } finally {
    if (recordLocks.get(key) === wrapped) recordLocks.delete(key);
  }
}

const MISSING_LABELS = { invoiceNo: '发票号码', issueDate: '开票日期', totalAmount: '价税合计' };

/** 解析抬头配置（「名称|税号」逗号分隔）→ [{name, taxNo}] */
function parseAllowedBuyers() {
  return (config.invoiceCollect.allowedBuyers || []).map((raw) => {
    const [name, taxNo] = raw.split('|').map(s => (s || '').trim());
    return { name, taxNo };
  }).filter(x => x.name || x.taxNo);
}

/** 抬头校验：配置为空=不校验（通过）；购买方名称或税号命中任一套即通过 */
function checkBuyer(fields) {
  const allowed = parseAllowedBuyers();
  if (!allowed.length) return { status: null, note: '未配置抬头校验' };
  // 未识别 ≠ 不匹配（2026-09-29 曼波反馈强化）：名称/税号都空是「识别渠道没取到」
  //（纯 QR 通道补 OCR 仍失败），不是票面抬头问题——判「待人工」让财务核票面，
  // 「抬头存疑」只留给「识别出了抬头但确实不匹配」的票
  if (!fields.buyerName && !fields.buyerTaxNo) {
    return { status: '待人工', note: '未识别到购买方信息（识别渠道限制，非票面异常），请财务对照票面核对抬头' };
  }
  const hit = allowed.find(a =>
    (a.taxNo && fields.buyerTaxNo && fields.buyerTaxNo === a.taxNo) ||
    (a.name && fields.buyerName && fields.buyerName.includes(a.name)));
  return hit
    ? { status: null, note: null }
    : { status: '抬头存疑', note: `购买方「${fields.buyerName || '?'}${fields.buyerTaxNo ? '/' + fields.buyerTaxNo : ''}」不在报销抬头白名单` };
}

/**
 * 名下可归类记录（2026-11-20 多票求和制，曼波定）：已通过 + 活跃流程 + 两栏均未交票
 * + 采集台账**未收齐**（已收票金额之和 < 审批总金额 ±0.01——一个审批可分多张发票分批交，
 * 交过几张的审批只要没收齐仍保留候选；收齐的从候选消失，再交的票转待人工）。
 * 返回 [{record_id, applyNo, amount, collectedSum, collectedCount, material, project, senderName}]
 */
async function listOpenRecordsByOpenId(openId) {
  const collectedSumMap = await collectStore.sumByApplyNo();
  const all = await approvalService.getAllApprovals();
  return all
    .map(r => ({ record_id: r.record_id, fields: r.fields || {} }))
    .filter(({ fields: f }) => {
      if (f['申请状态'] !== config.approvalStatus.APPROVED) return false;
      if (!approvalService.isActiveProcess(f)) return false;
      // 「发票/补交发票」两栏排除废止（2026-11-20 多票求和制）：自动采集每张票都镜像
      // append「补交发票」栏，多票场景第二张起该栏必非空——两栏口径会把多票打回待人工
      // （本需求病灶）。收齐判定统一走台账求和口径（见下）。
      const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : '';
      if (!applyNo) return false;
      // 求和制收齐判定：台账已收和 ≥ 审批总金额-0.01 → 交齐，不再候选
      const amount = typeof f['总金额'] === 'number' ? f['总金额'] : (parseFloat(f['总金额']) || null);
      const collected = collectedSumMap.get(applyNo);
      if (amount !== null && collected && collected.sum >= amount - 0.01) return false;
      return true;
    })
    .filter(({ fields: f }) =>
      Array.isArray(f['发起人']) && f['发起人'].some(u => u.id === openId))
    .map(({ record_id, fields: f }) => {
      const applyNo = f['申请编号'] ? (f['申请编号'].text || String(f['申请编号'])) : record_id;
      const collected = collectedSumMap.get(applyNo) || { sum: 0, count: 0 };
      return {
        record_id,
        applyNo,
        amount: typeof f['总金额'] === 'number' ? f['总金额'] : (parseFloat(f['总金额']) || null),
        collectedSum: Math.round((collected.sum || 0) * 100) / 100,
        collectedCount: collected.count || 0,
        material: f['购买物资名称'] || '',
        project: f['项目'] ? (f['项目'].name || String(f['项目'])) : '',
        senderName: (Array.isArray(f['发起人']) ? f['发起人'].find(u => u.id === openId) : null)?.name || '',
      };
    });
}

/**
 * 金额归类匹配（2026-11-20 多票求和制，曼波定：多张发票金额加起来=审批即可）。
 * 匹配口径改为「剩余额度」：remaining = 审批总金额 - 台账已收票金额和；
 * 发票金额 ≈ 剩余额度(±0.01) 唯一 → 自动归类；名下仅一条候选 → 直接归它（金额比对闸兜底标「金额不符」）；
 * 多候选/无候选 → 待人工（回执列候选与进度，队员核对/找财务调整）。
 */
function matchRecord(invoiceAmount, openRecords) {
  if (!openRecords.length) return { match: null, status: '待人工', note: '名下没有待交票的已通过申请（可能都已交票，请找财务确认归类）' };
  const remainingOf = (r) => (r.amount !== null ? Math.round((r.amount - (r.collectedSum || 0)) * 100) / 100 : null);
  const exact = openRecords.filter(r => remainingOf(r) !== null && Math.abs(remainingOf(r) - invoiceAmount) < 0.01);
  if (exact.length === 1) return { match: exact[0], status: null, note: null };
  if (exact.length > 1) {
    return { match: null, status: '待人工', note: `有 ${exact.length} 条同剩余额度的申请（${exact.map(r => r.applyNo).join('、')}），已转财务人工归类` };
  }
  if (openRecords.length === 1) {
    return { match: openRecords[0], status: null, note: null }; // 唯一候选直接归，金额出入由金额比对闸标记
  }
  return { match: null, status: '待人工', note: `金额与名下申请剩余额度均不一致（名下待交票：${openRecords.map((r) => `${r.applyNo} 已收${r.collectedCount}张¥${(r.collectedSum || 0).toFixed(2)}/共¥${r.amount}`).join('、') || '无'}）` };
}

/** 打回回执文案 */
function buildRejectText(result) {
  const missingText = (result.missing || []).map(k => MISSING_LABELS[k] || k).join('、');
  const lines = ['❌ 发票未能收录，这张票先打回给你：'];
  if (result.reason === '识别要素不全' || missingText) {
    lines.push(`· 识别缺要素：${missingText || '未知'}`);
    lines.push('· 重发指引：拍照要包含完整票面（尤其左上角二维码），字迹清晰不反光；数电票建议直接转发 PDF 文件');
  } else if (result.reason === 'duplicate') {
    lines.push(`· ${result.detail}`);
    lines.push('· 若确认不是重复（如拼单各交各的），请联系财务在采集台账里人工处理');
  } else {
    lines.push(`· ${result.reason || '识别失败'}`);
    lines.push('· 可重发一次；仍失败请直接把票发给财务人工录入');
  }
  return lines.join('\n');
}

/**
 * 消息交票主入口。
 * @param {object} payload {openId, senderName, messageId, fileKey, msgType('image'|'file'), fileName, source('private'|'urge_reply'|'api')}
 * @returns {object} {ok, action:'collected'|'rejected'|'duplicated', ...} 供调用方（催办轮询等）消费
 */
async function collectFromMessage(payload) {
  const { openId, senderName, messageId, fileKey, msgType, fileName, source } = payload;
  if (!openId || !messageId || !fileKey) {
    throw new Error('缺少参数：openId/messageId/fileKey 必填');
  }

  // 1. 下载原件（图片走 image，文件(PDF)走 file）
  const buffer = await client.downloadMessageResource(messageId, fileKey, msgType === 'file' ? 'file' : 'image');

  // 2. 三通道识别（OCR 兜底注入）
  const result = await invoiceParser.recognizeInvoice(buffer, { msgType, fileName }, (buf) => ocrService.recognizeBuffer(buf));

  // 3. 非发票图静默忽略（私聊图可能是表情包/值日照片等；带发票特征但要素不全才打回）
  if (!result.ok && !result.looksLikeInvoice) {
    return { ok: false, action: 'ignored', reason: result.reason };
  }

  // 3b. 打回闸：识别不完整
  if (!result.ok) {
    const text = buildRejectText(result);
    // 打回回执失败要留痕（2026-11-03 审查 P3：纯静默 catch——队员不知道票被拒、日志无痕）
    await bot.sendTextToUser(openId, text).catch((err) => console.error('[发票采集] 打回回执发送失败:', err.message));
    return { ok: false, action: 'rejected', reason: result.reason, missing: result.missing };
  }

  const f = result.fields;

  // 4. 查重双闸 + 落表整体按发票号加锁（并发两条入口同票时串行化，第二遍会命中查重——复查 P1-6）
  const dupGuard = await withRecordLock(`inv_${f.invoiceNo}`, async () => {
    const dupExact = await collectStore.findByInvoiceNo(f.invoiceNo);
    if (dupExact.length) {
      const first = dupExact[0].fields;
      const collectedAt = Number(first['采集时间']) || 0;
      const mine = first['提交人'] === openId && Date.now() - collectedAt < 24 * 3600 * 1000;
      const when = collectedAt ? new Date(collectedAt).toLocaleString('zh-CN') : '此前';
      const detail = `该发票号（尾号 ${String(f.invoiceNo).slice(-6)}）已由 ${first['提交人姓名'] || first['提交人'] || '其他队员'} 于 ${when} 提交过`;
      // 本人 24h 内重复提交（hub 实时采集 + 催办轮询双入口会先后碰到同一条消息）→ 静默，不再发吓人的重复回执（复查 P2-2）
      if (mine) return { ok: false, action: 'already_collected', reason: 'duplicate', detail, silent: true };
      await bot.sendTextToUser(openId, `❌ 发票未能收录：疑似重复提交\n· ${detail}（关联申请 ${first['关联申请编号'] || '?'}）\n· 若确认不是重复（拼单各交各的），请联系财务人工处理`).catch(() => {});
      return { ok: false, action: 'duplicated', reason: 'duplicate', detail };
    }
    const dupSimilar = await collectStore.findBySimilarity({ issueDate: f.issueDate, totalAmount: f.totalAmount, sellerTaxNo: f.sellerTaxNo });
    if (dupSimilar.length) {
      await bot.sendTextToUser(openId, `❌ 发票未能收录：疑似重复提交\n· 存在开票日期与金额完全一致的已收发票（关联申请 ${(dupSimilar[0].fields['关联申请编号'] || '?')}），发票号尾号 ${String(f.invoiceNo).slice(-6)} vs ${String(dupSimilar[0].fields['发票号码'] || '?').slice(-6)}\n· 若确认不是重复，请联系财务人工处理`).catch(() => {});
      return { ok: false, action: 'duplicated', reason: 'duplicate', detail: '三元组近似命中' };
    }

    // 5. 金额归类匹配（senderName 缺失时从匹配到的审批记录发起人反查）
    const openRecords = await listOpenRecordsByOpenId(openId);
    const { match, status: matchStatus, note: matchNote } = matchRecord(f.totalAmount, openRecords);
    const resolvedName = senderName || (match && match.senderName) || '';

    // 6. 金额比对（多票求和制单侧闸，2026-11-20 曼波定「金额加起来=审批即可」）：
    //    基准=剩余额度 remaining=审批总额-台账已收和；**只拦「超剩余额度」**（amountDiff > 容忍）——
    //    票 < 剩余额度是多票分批交的合法中间态（队员还会再交），不标金额不符；
    //    「金额差」字段照写负差（还差多少，财务收齐核对用）。抬头校验同前。
    let verifyStatus = matchStatus || '通过';
    const notes = [];
    let amountDiff = null;
    let remainingNote = '';
    if (match && match.amount !== null) {
      const remaining = Math.round((match.amount - (match.collectedSum || 0)) * 100) / 100;
      amountDiff = Math.round((f.totalAmount - remaining) * 100) / 100;
      const tol = Math.max(Math.abs(remaining) * config.invoiceCollect.amountToleranceRatio, config.invoiceCollect.amountToleranceFixed);
      if (amountDiff > tol) {
        verifyStatus = '金额不符';
        const progress = match.collectedCount
          ? `该申请已收 ${match.collectedCount} 张 ¥${(match.collectedSum || 0).toFixed(2)}/共 ¥${match.amount.toFixed(2)}，剩余额度 ¥${remaining.toFixed(2)}；`
          : '';
        notes.push(`发票 ¥${f.totalAmount.toFixed(2)} vs 剩余额度 ¥${remaining.toFixed(2)}（超 ${amountDiff.toFixed(2)}，容忍 ±${tol.toFixed(2)}）。${progress}多张发票金额加起来等于申请金额即可`);
      } else if (match.collectedCount) {
        remainingNote = `该申请已收 ${match.collectedCount} 张 ¥${(match.collectedSum || 0).toFixed(2)}，本张后累计 ¥${(match.collectedSum + f.totalAmount).toFixed(2)}/共 ¥${match.amount.toFixed(2)}`;
      }
    }
    const buyerCheck = checkBuyer(f);
    if (buyerCheck.status && verifyStatus !== '金额不符') verifyStatus = buyerCheck.status;
    if (buyerCheck.note) notes.push(buyerCheck.note);
    if (matchNote) notes.push(matchNote);

    // 7. 发票原件转存附件 + 落采集表（真源）
    const ext = msgType === 'file' ? 'pdf' : 'jpg';
    const fileToken = await client.uploadMediaToBitable(buffer, `invoice_${f.invoiceNo}.${ext}`).catch((err) => {
      console.error(`[发票采集] 发票原件上传失败（尾号 ${String(f.invoiceNo).slice(-6)}，将落无附件记录）: ${err.message}`);
      return null;
    });
    const collectFields = {
      '发票号码': f.invoiceNo,
      ...(f.invoiceCode ? { '发票代码': f.invoiceCode } : {}),
      '票种': result.invoiceType || 'unknown',
      // NaN 安全（2026-11-03 审查 P2）：非法日期（2/30、13 月等）返回 null 不写该列，
      // 防「开票日期」空列让三元组查重对这条票永久失效
      ...(f.issueDate ? { '开票日期': issueDateToMs(f.issueDate) } : {}),
      '价税合计': f.totalAmount,
      ...(f.buyerName ? { '购买方名称': f.buyerName } : {}),
      ...(f.buyerTaxNo ? { '购买方税号': f.buyerTaxNo } : {}),
      ...(f.sellerName ? { '销售方名称': f.sellerName } : {}),
      ...(f.sellerTaxNo ? { '销售方税号': f.sellerTaxNo } : {}),
      ...(f.invoiceContent ? { '开票内容': f.invoiceContent } : {}),
      ...(f.checkCode ? { '校验码后6位': f.checkCode } : {}),
      '提交人': openId,
      ...(resolvedName ? { '提交人姓名': resolvedName } : {}),
      ...(match ? { '关联申请编号': match.applyNo, '申请金额': match.amount } : {}),
      ...(match && match.amount !== null ? { '金额差': amountDiff } : {}),
      '识别通道': result.source === 'qrcode+ocr' ? 'qrcode+ocr' : result.source,
      '校验状态': verifyStatus,
      // qrPayload 挂识别结果顶层（invoiceParser 各通道统一），不在 fields 里——
      // 对抗审查 P1-1：此前读 f.qrPayload（fields）恒 undefined，「二维码内容」列从未写入
      ...(result.qrPayload ? { '二维码内容': result.qrPayload } : {}),
      ...(notes.length ? { '备注': notes.join('；') } : {}),
      ...(fileToken ? { '发票图片': [{ file_token: fileToken }] } : {}),
      '采集时间': Date.now(),
    };
    const created = await collectStore.createCollect(collectFields);
    return { created, match, verifyStatus, notes, matchNote, resolvedName, buyerCheck, fileToken, remainingNote };
  });

  if (dupGuard && dupGuard.action) return dupGuard; // 查重拦截（含静默 already_collected）
  const { match, verifyStatus, notes, matchNote, buyerCheck, fileToken, created, remainingNote } = dupGuard;

  // 8. 镜像回写审批表「补交发票」附件栏（按记录串行 + 先读后 append；GET 走带 code 校验的
  //    getRecord——裸 requestAPI 不抛错会把读失败当空列，PUT 整列覆盖清掉已有附件，复查 P1-4）
  let mirrored = false;
  if (match) {
    try {
      await withRecordLock(match.record_id, async () => {
        const record = await bitableApi.getRecord(config.bitable.approvalTableId, match.record_id);
        const existing = (record.fields['补交发票'] || []);
        await bitableApi.updateRecord(config.bitable.approvalTableId, match.record_id, {
          '补交发票': [...existing, ...(fileToken ? [{ file_token: fileToken }] : [])],
        });
      });
      mirrored = true;
    } catch (err) {
      console.error(`[发票采集] 回写补交发票栏失败（${match.applyNo}）:`, err.message);
    }
  }

  // 9. 成功回执（队员自行核对金额归类的核对单）
  const amountText = `¥${f.totalAmount.toFixed(2)}`;
  const lines = [`✅ 发票已收录（${result.invoiceType || '发票'}，尾号 ${String(f.invoiceNo).slice(-6)}，${amountText}）`];
  if (match) {
    lines.push(`· 归类：申请 ${match.applyNo}（${match.material || '未填物资'}${match.project ? '/' + match.project : ''}，申请 ¥${match.amount ?? '?'}）`);
    if (verifyStatus === '金额不符') lines.push(`· ⚠️ ${notes[0] || '金额与申请有出入'}`);
    // 多票求和制进度行（2026-11-20）：已收张数/金额+本张后累计，队员自己知道还差多少
    if (match.collectedCount && verifyStatus !== '金额不符') lines.push(`· 🧮 ${remainingNote}`);
    lines.push(mirrored ? '· 已同步到审批表补交发票栏' : '· ⚠️ 审批表镜像同步失败，已记录台账（财务可见），不影响收录');
  } else {
    lines.push(`· 归类：待财务人工归类——${matchNote || ''}`);
  }
  if (verifyStatus === '抬头存疑') lines.push(`· ⚠️ ${buyerCheck.note}`);
  lines.push('· 请核对上面的金额与归类，有误请尽快联系财务调整');
  await bot.sendTextToUser(openId, lines.join('\n')).catch(() => {});

  // 9b. 抬头警报（2026-09-29 曼波定：只认重庆大学抬头，其他一律拦截+群警报）——
  // 除打回提交人外审批群同步响一声，财务不用从队员转述里才知道有人交错票。
  // 触发看 buyerCheck 本身（对抗审查 P3-5：金额不符优先级压过抬头存疑时也要响——
  // 错误抬头+金额不符的票不能只躺在队员回执里）
  if (buyerCheck.status === '抬头存疑' && f.buyerName) {
    // 抬头/姓名来自外部（发票票面 OCR/队员），卡片 markdown 统一走 stripCardInjection
    //（对抗审查 P2-2：esc 只滤换行不滤 md 语法，钓鱼链接可穿透）
    const esc = (s) => bot.stripCardInjection(String(s)).replace(/[\r\n]/g, ' ').slice(0, 60);
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'red', title: { tag: 'plain_text', content: '🚨 非重大抬头发票已拦截' } },
      elements: [{
        tag: 'markdown',
        content: [
          `· 提交人：${esc(resolvedName || openId)}`,
          `· 发票：尾号 ${esc(String(f.invoiceNo).slice(-6))} ¥${f.totalAmount.toFixed(2)}（${esc(result.invoiceType || '发票')}）`,
          `· 识别抬头：${esc(f.buyerName)}`,
          `· 已打回提交人核实换票；如属特殊情况请财务在采集表人工登记`,
        ].join('\n'),
      }],
    };
    // 静默闸（2026-11-03 审查 P2：此前全仓唯一绕闸的自动群播——夜间队员交错票，
    // 凌晨红色警报直达财务群）。窗口内落盘积压，09:00 原样补发（一次性事件通知
    // 语义）；补发处理器在 cron 装配时注册（invoice_buyer_alert）
    if (quietHours.gatePayload('invoice_buyer_alert', card, '非重大抬头发票警报')) {
      // 已积压顺延，不直接发送
    } else {
      try {
        await bot.sendMessage(card);
      } catch (err) {
        console.error('[发票采集] 抬头警报群播失败:', err.message);
      }
    }
  }

  // 10. 制单金额线即时检查（2026-09-29 曼波定）：新票落库可能让所属项目「已开发票且
  //     未制单」金额满阈值 → 群播报提醒锁定批次。异步不阻塞回执；过晚间静默闸，
  //     失败仅日志（formAlertService 内部已兜，不向采集链路抛）
  setImmediate(() => {
    try {
      formAlertService = formAlertService || require('./formAlertService');
      formAlertService.triggerAfterCollect();
    } catch (err) {
      console.error('[发票采集] 制单金额线即时检查调度失败:', err.message);
    }
  });

  return {
    ok: true,
    action: 'collected',
    invoiceNo: f.invoiceNo,
    totalAmount: f.totalAmount,
    matchApplyNo: match ? match.applyNo : null,
    verifyStatus,
    mirrored,
    recordId: created.record_id,
    source: source || 'api',
  };
}

module.exports = {
  collectFromMessage,
  parseAllowedBuyers,
  checkBuyer,
  listOpenRecordsByOpenId,
  matchRecord,
  buildRejectText,
  withRecordLock,
};
