/**
 * 公用卡收支明细同步（2026-11-06 曼波定）。
 *
 * 台账电子表格《2027年千里团队报销台账》某行「入账日期」列（L 列）被填
 * （机器人 paid 回填，或财务直接手填表格）→ 把该行转换追加进 wiki「公用卡收支明细」
 * 多维表格的「数据表27」（27 赛季活跃账本）。格式照财务既有手搬先例统一：
 *   - 购买物资名称 = 台账「摘要」全文（与 wiki 既有行同源，可对得上）
 *   - 来源/去向 = 「学校」；收/支 = 「收入」；金额 = 台账报销金额（D 列）
 *   - 日期 = 台账入账日期（L 列 'YYYY/M/D' → 北京时区当日零点 ms，固定 +08 折算与部署机 TZ 无关）
 *   - 上一笔余额 = 写入前的链尾余额（本地递推：链尾 = wiki 现有最晚日期行的「余额」，
 *     无则 0；每写一行 prev=当前链尾、新链尾=round2(prev+金额)，收入加向）
 *
 * 触发：paid 指令即时（triggerAfterPaid）+ 每小时轮询兜底（cron 在别处接，手填的
 * 入账日期也能被扫到）；running 互斥防即时与轮询并发双写。
 *
 * 幂等三层（防同一行重复追加进 wiki）：
 *   1. 状态文件（data/card-flow-sync-state.json，可配 CARD_FLOW_SYNC_STATE_FILE 挪出
 *      项目目录防 SFTP 部署清空）：已同步摘要集合 state.synced，pm2 重启不丢；
 *   2. 收编扫描：状态丢失/新环境起步时，wiki 已有同名「购买物资名称」的行直接收编
 *      进状态不再追加（人工手搬过的历史行也能对上）；
 *   3. 整批成功才写状态：batch_create 失败一行都不记 synced，下一轮整体重试
 *      （不会出现「记了状态但行没写进去」的静默丢行）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const client = require('../feishu/client');
const ledgerSheetService = require('./ledgerSheetService');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'card-flow-sync-state.json');

let stateFile = DEFAULT_FILE;
let state = { synced: {} }; // { [摘要]: 入账日期 ms }——已追加进 wiki 的台账行

// 运行互斥：paid 即时触发与每小时轮询并发时串行化，防 batch_create 双写
let running = null;

// wiki node_token → bitable obj_token（app_token）解析缓存（node 元信息不变，进程内复用）
let appTokenCache = null;

function init(file) {
  if (file) stateFile = file;
  state = load();
  return module.exports;
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && parsed.synced && typeof parsed.synced === 'object') {
      return { synced: parsed.synced, baselined: !!parsed.baselined };
    }
  } catch (err) { /* 不存在/损坏都重建（收编扫描兜底，不会重复写入） */ }
  return { synced: {} };
}

function save() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    // 原子写（同 formAlertService/urgeStateStore 口径）：先写临时文件再 rename，防半截 JSON
    const tmpFile = `${stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, stateFile);
  } catch (err) {
    console.error('[收支明细同步] 状态落盘失败:', err.message);
  }
}

function ledgerEnabled() {
  return !!(config.cardFlow.nodeToken && config.cardFlow.tableId);
}

/** 台账 L 列 'YYYY/M/D' → 北京时区当日零点 ms；不匹配（空/异格式）返回 0。
 *  固定 +08 折算（Date.UTC - 8h），与部署机时区无关。 */
function parseLedgerDateMs(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s ?? ''));
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 8 * 3600 * 1000;
}

/** 读台账数据区（跳前两行标题）：C 列摘要 / D 列金额 / L 列入账日期。
 *  摘要空行（财务留白/尾部空行）跳过；返回 [{row(1基), summary, amount, entryDateMs}]。 */
async function readLedgerRows() {
  const { sheetId, rowCount } = await ledgerSheetService.resolveSheet();
  const grid = await ledgerSheetService.readGrid(sheetId, rowCount);
  const rows = [];
  for (let i = 2; i < grid.length; i++) { // 数据自第 3 行起（首两行标题）
    const row = grid[i] || [];
    const summary = String(row[2] ?? '').trim();
    if (!summary) continue;
    rows.push({
      row: i + 1,
      summary,
      amount: Number(row[3]) || 0,
      entryDateMs: parseLedgerDateMs(row[11]),
    });
  }
  return rows;
}

/** wiki 节点 token → bitable app_token（obj_token），进程内缓存；
 *  节点不存在/不是多维表格 → 抛错（文案带实际类型，防 node token 配错指向普通文档）。 */
async function resolveAppToken() {
  if (appTokenCache) return appTokenCache;
  const r = await client.requestAPI('GET', '/wiki/v2/spaces/get_node?token=' + encodeURIComponent(config.cardFlow.nodeToken));
  if (r.code !== 0) throw new Error(`wiki 节点解析失败: ${r.msg} (code: ${r.code})`);
  const node = r.data && r.data.node;
  if (!node || node.obj_type !== 'bitable') {
    throw new Error(`wiki 节点不是多维表格（实际类型: ${node ? node.obj_type : '节点不存在'}），请检查 WIKI_CARD_FLOW_NODE_TOKEN`);
  }
  appTokenCache = node.obj_token;
  return appTokenCache;
}

/** 读「数据表27」全部记录：datedRows=有日期行按日期升序（取链尾余额），
 *  existing=已有「购买物资名称」集合（收编扫描幂等用）。
 *  翻页（2026-11-09 审查 P1）：search 单页上限 500——账本超 500 行后无翻页会
 *  ①收编扫描漏掉旧页同名行 → 已同步行重复追加（幂等第 2 层失效）；
 *  ②datedRows 缺旧页 → 链尾余额读到旧值 → 余额递推错账。page_token 走 query
 *  string（instances/query 同款实测坑：放 body 被忽略，恒返回第 1 页）。 */
async function readWikiTable(appToken, tableId) {
  const datedRows = [];
  const existing = new Set();
  let pageToken = '';
  do {
    const r = await client.requestAPI('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search?page_token=${encodeURIComponent(pageToken)}`, {
      page_size: 500,
      sort: [{ field_name: '日期', desc: true }],
    });
    if (r.code !== 0) throw new Error(`公用卡收支明细读取失败: ${r.msg} (code: ${r.code})`);
    const items = (r.data && r.data.items) || [];
    for (const item of items) {
      const fields = (item && item.fields) || {};
      // 购买物资名称：文本字段读出来是富文本段数组 [{text}]，拼接为纯文本再比对
      const rawMaterial = fields['购买物资名称'];
      const material = Array.isArray(rawMaterial)
        ? rawMaterial.map(x => (x && x.text) || '').join('')
        : String(rawMaterial ?? '');
      if (material) existing.add(material);
      // 余额：可能被接口包装成 {value:[n]} 对象，否则按裸数字处理；
      // round2 与递推同口径（公式列浮点读数尾差如 10272.529999… 归一到分）
      const rawBalance = fields['余额'];
      const balance = (rawBalance && typeof rawBalance === 'object' && Array.isArray(rawBalance.value))
        ? round2(Number(rawBalance.value[0]) || 0)
        : round2(Number(rawBalance) || 0);
      const dateMs = Number(fields['日期']) || 0;
      // 余额缺失（null/undefined/空串）的行不进链：人工行填了日期漏填余额时，
      // Number()||0 会把链尾拉成 0，下一笔递推与真实余额脱节（2026-11-09 审查 P3）；
      // 「余额」列是公式列，正常行都有值——缺失即视为人工残行，不作为链尾依据
      const balanceMissing = rawBalance === null || rawBalance === undefined
        || (typeof rawBalance === 'string' && rawBalance.trim() === '');
      if (dateMs > 0 && !balanceMissing) datedRows.push({ material, balance, dateMs });
    }
    pageToken = (r.data && r.data.has_more) ? (r.data.page_token || '') : '';
  } while (pageToken);
  datedRows.sort((a, b) => a.dateMs - b.dateMs); // 升序，末位即链尾
  return { datedRows, existing };
}

/** 金额两位舍入（余额链递推口径，防浮点尾差越滚越大） */
const round2 = n => Math.round(n * 100) / 100;

/** 同步一轮：台账已入账且未同步的行 → 追加进 wiki 数据表27。
 *  互斥：进行中再触发返回 already_running（paid 即时与每小时轮询并发时丢后到者，
 *  下一轮轮询自然兜住，不排队防链尾余额基于过期 wiki 快照递推）。 */
function syncOnce(opts = {}) {
  const { trigger = 'cron', dryRun = false } = opts;
  if (!ledgerEnabled()) return Promise.resolve({ action: 'disabled' });
  if (running) return Promise.resolve({ action: 'already_running' });
  running = doSync({ trigger, dryRun })
    .catch(err => { running = null; throw err; })
    .then(v => { running = null; return v; });
  return running;
}

async function doSync({ trigger = 'cron', dryRun = false } = {}) {
  const appToken = await resolveAppToken();
  const ledgerRows = await readLedgerRows();
  // 待同步 = 入账日期已填 且 未记入状态的行（入账日期空 = 学校还没打款，不进账本）
  const pending = ledgerRows.filter(r => r.entryDateMs > 0 && !state.synced[r.summary]);
  const result = { checked: ledgerRows.length, pending: pending.length, appended: [], adopted: [], failed: [] };

  const wiki = await readWikiTable(appToken, config.cardFlow.tableId);

  // 基线快照（首航防历史洪水，2026-11-07 dryRun 实案）：功能上线时台账已有大量历史入账行，
  // 其中很多在 wiki 里是以聚合「报销款」行记账的（无逐笔摘要）——整批回灌会双重记账。
  // 首航把当前所有待同步行只记基线不建行，此后只同步**新填**入账日期的行（paid 回填/手填）。
  if (!state.baselined) {
    if (dryRun) {
      result.baselineWarning = `首航基线未建：实跑首航会把存量 ${pending.length} 行入账行记为基线（不建行），此后只同步新填入账的行`;
      result.preview = [];
      return result;
    }
    for (const r of pending) state.synced[r.summary] = r.entryDateMs;
    state.baselined = true;
    save();
    console.log(`[收支明细同步] 基线快照：存量 ${pending.length} 行入账行已记基线（不回灌历史），此后只同步新填入账的行`);
    result.baselined = pending.length;
    return result;
  }

  // 收编扫描（幂等第 2 层）：wiki 已有同名物资行（此前写过/状态文件丢失/人工手搬）→
  // 视作已同步不再追加；dryRun 只报不记状态（只查不写原则）
  for (const r of pending) {
    if (wiki.existing.has(r.summary)) {
      result.adopted.push(r.summary);
      if (!dryRun) state.synced[r.summary] = r.entryDateMs;
    }
  }
  if (!dryRun && result.adopted.length) save();

  const toAppend = pending.filter(r => !state.synced[r.summary] && !wiki.existing.has(r.summary));
  if (!toAppend.length) {
    console.log(`[收支明细同步] 无待追加行（${trigger}）：台账 ${result.checked} 行 / 待同步 ${result.pending} / 收编 ${result.adopted.length}`);
    return result;
  }

  // 链尾余额 = wiki 现有最晚日期行的「余额」（无日期行则 0），逐行递推新链尾
  const lastBalance = wiki.datedRows.length ? wiki.datedRows[wiki.datedRows.length - 1].balance : 0;
  let runningBalance = lastBalance;
  const chain = [];
  for (const r of toAppend) {
    const prev = runningBalance;
    runningBalance = round2(prev + r.amount); // 收入加向
    chain.push({ summary: r.summary, amount: r.amount, entryDateMs: r.entryDateMs, prev });
  }

  // dryRun：只算不写不存（预演链式递推结果）
  if (dryRun) {
    result.preview = chain.map(c => ({ summary: c.summary, amount: c.amount, dateMs: c.entryDateMs, prevBalance: c.prev }));
    return result;
  }

  // 实际写入（幂等第 3 层）：整批成功才写状态；失败一行都不记，下一轮整体重试
  try {
    const records = chain.map(c => ({
      fields: {
        '购买物资名称': c.summary,
        '来源/去向': '学校',
        '收/支': '收入',
        '金额': c.amount,
        '日期': c.entryDateMs,
        '上一笔余额': c.prev,
      },
    }));
    const r = await client.requestAPI('POST', `/bitable/v1/apps/${appToken}/tables/${config.cardFlow.tableId}/records/batch_create`, { records });
    if (r.code !== 0) throw new Error(`公用卡收支明细写入失败: ${r.msg} (code: ${r.code})`);
    for (const c of chain) {
      state.synced[c.summary] = c.entryDateMs;
      result.appended.push(c.summary);
    }
    console.log(`[收支明细同步] 追加 ${chain.length} 行（${trigger}）：链尾余额 ${lastBalance} → ${runningBalance}`);
    save();
  } catch (err) {
    console.error(`[收支明细同步] 追加 ${chain.length} 行失败（state 未写，下轮重试）:`, err.message);
    result.failed.push(err.message);
  }
  return result;
}

/** paid 指令即时触发入口（ledgerSheetService.syncOnStatus 回填入账日期后调）：
 *  失败不抛给调用方（台账回执不受影响），由每小时轮询兜底重试。
 *
 *  静默闸裁定（2026-11-09 审查批，工位报 P1 不采纳）：paid 是财务当下主动发的指令
 *  （交互回路，晚间静默契约明文不受限），写 wiki 数据表27 与 paid 回填台账 L 列同属
 *  「业务动作（写表）」——顶层契约明文业务动作不延迟。cron 每小时轮询路径（兜财务
 *  手填行）已过静默闸（gateTask card_flow_sync），两条路径口径各有依据，不统一改闸。 */
function triggerAfterPaid() {
  return syncOnce({ trigger: 'paid' })
    .catch(err => {
      console.error('[收支明细同步] paid 即时同步失败（轮询兜底）:', err.message);
      return { action: 'failed', error: err.message };
    });
}

module.exports = {
  init,
  syncOnce,
  triggerAfterPaid,
  ledgerEnabled,
  parseLedgerDateMs,
};

// 模块加载即按配置初始化状态文件（cron 的显式 init 幂等，同 formAlertService 口径）：
// 保证 CARD_FLOW_SYNC_STATE_FILE 配置后，任何入口触发都落在配置路径而非默认路径
init(config.cardFlow.stateFile);
