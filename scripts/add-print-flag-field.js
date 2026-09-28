/**
 * 审批表（财务多维表格）加「是否打印」单选列（选项 是/否），并把存量记录回填为「否」。
 * 幂等，可重复执行（字段已存在只跳过建列；回填只补空值，不覆盖人工已标的「是」）。
 *
 * 背景（2026-09-29 曼波定）：财务同学也在自行制报销单，与机器人自动制单需要去重——
 *   - 财务自行制单打印的记录人工标「是」→ 机器人不再把它的票拉进票池、不再催制单；
 *   - 机器人锁定批次生成三件套后自动把批次内票对应记录标「是」（代码侧 lockBatch 回写）；
 *   - 空值/「否」= 未打印，视为仍在待制单池（代码读侧空值一律当「否」，
 *     飞书多维表格字段无默认值机制，靠存量回填保证表格视觉一致）。
 */
const bitableApi = require('../src/feishu/bitable');
const config = require('../src/config');

const FIELD = {
  field_name: '是否打印',
  type: 3, // 单选
  property: { options: [{ name: '是' }, { name: '否' }] },
};

async function main() {
  const tableId = config.bitable.approvalTableId;
  if (!tableId) throw new Error('未配置 BITABLE_APPROVAL_TABLE_ID');

  const r = await bitableApi.ensureField(tableId, FIELD);
  console.log(r.created ? `✅ 已建字段「是否打印」（单选：是/否）` : '字段「是否打印」已存在，跳过建列');

  // 存量回填「否」（只补空值——人工/机器人已标的「是」不动）
  const records = await bitableApi.listAllRecords(tableId);
  let filled = 0, skipped = 0;
  for (const rec of records) {
    const v = rec.fields && rec.fields['是否打印'];
    if (v === null || v === undefined || v === '') {
      await bitableApi.updateRecord(tableId, rec.record_id, { '是否打印': '否' });
      filled++;
    } else {
      skipped++;
    }
  }
  console.log(`存量回填完成：共 ${records.length} 条，补「否」 ${filled} 条，已有值保留 ${skipped} 条`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
