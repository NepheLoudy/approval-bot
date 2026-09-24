/**
 * 建「发票采集」与「报销批次」两张表（幂等，可重复执行）。
 * 跑完把输出的 table_id 配到 .env 的 BITABLE_COLLECT_TABLE_ID / BITABLE_BATCH_TABLE_ID。
 *
 * 口径备注：
 * - 发票与审批表「补交发票」栏等价（采集成功即视为已交票，同时回写补交发票附件栏作镜像）；
 * - 批次号沿用财务既有命名（27备赛N<项目>N），批次状态机：拟批→已锁定→已提交→已到账/已退回；
 * - 表建在审批 base（BITABLE_APP_TOKEN）下，与审批表同 base 便于关联视图。
 */
const bitableApi = require('../src/feishu/bitable');

const FIELD_TYPES = { TEXT: 1, NUMBER: 2, SINGLE_SELECT: 3, DATE: 5, USER: 11 };

const COLLECT_FIELDS = [
  { field_name: '发票号码', type: FIELD_TYPES.TEXT },
  { field_name: '发票代码', type: FIELD_TYPES.TEXT },
  { field_name: '票种', type: FIELD_TYPES.SINGLE_SELECT, property: { options: [{ name: '全电发票' }, { name: '增值税发票' }, { name: 'unknown' }] } },
  { field_name: '开票日期', type: FIELD_TYPES.DATE },
  { field_name: '价税合计', type: FIELD_TYPES.NUMBER, property: { formatter: '0.00' } },
  { field_name: '购买方名称', type: FIELD_TYPES.TEXT },
  { field_name: '购买方税号', type: FIELD_TYPES.TEXT },
  { field_name: '销售方名称', type: FIELD_TYPES.TEXT },
  { field_name: '销售方税号', type: FIELD_TYPES.TEXT },
  { field_name: '校验码后6位', type: FIELD_TYPES.TEXT },
  { field_name: '提交人', type: FIELD_TYPES.TEXT }, // open_id（人员字段写入需 open_id 转 id，V1 存 open_id 文本）
  { field_name: '提交人姓名', type: FIELD_TYPES.TEXT },
  { field_name: '关联申请编号', type: FIELD_TYPES.TEXT }, // 审批表「申请编号」，归类结果，财务可改
  { field_name: '申请金额', type: FIELD_TYPES.NUMBER, property: { formatter: '0.00' } },
  { field_name: '金额差', type: FIELD_TYPES.NUMBER, property: { formatter: '0.00' } },
  { field_name: '识别通道', type: FIELD_TYPES.SINGLE_SELECT, property: { options: [{ name: 'pdfText' }, { name: 'qrcode' }, { name: 'qrcode+ocr' }, { name: 'ocr' }] } },
  { field_name: '校验状态', type: FIELD_TYPES.SINGLE_SELECT, property: { options: [{ name: '通过' }, { name: '金额不符' }, { name: '抬头存疑' }, { name: '待人工' }] } },
  { field_name: '批次', type: FIELD_TYPES.TEXT }, // = 审批表「报销单」批次号，锁定时回填
  { field_name: '发票图片', type: 17 }, // 附件：发票原件（下载重传的 file_token）
  { field_name: '备注', type: FIELD_TYPES.TEXT },
  { field_name: '采集时间', type: FIELD_TYPES.DATE, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
];

const BATCH_FIELDS = [
  { field_name: '批次号', type: FIELD_TYPES.TEXT }, // 如 27备赛20步兵5（=审批表「报销单」取值）
  { field_name: '项目', type: FIELD_TYPES.TEXT },
  { field_name: '张数', type: FIELD_TYPES.NUMBER, property: { formatter: '0' } },
  { field_name: '金额合计', type: FIELD_TYPES.NUMBER, property: { formatter: '0.00' } },
  { field_name: '状态', type: FIELD_TYPES.SINGLE_SELECT, property: { options: [{ name: '拟批' }, { name: '已锁定' }, { name: '已提交' }, { name: '已到账' }, { name: '已退回' }] } },
  { field_name: '锁定时间', type: FIELD_TYPES.DATE, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  { field_name: '提交时间', type: FIELD_TYPES.DATE, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  { field_name: '到账时间', type: FIELD_TYPES.DATE, property: { date_formatter: 'yyyy-MM-dd HH:mm' } },
  { field_name: '打印文件', type: 17 }, // 附件：按录入顺序一页两票的 PDF（财务三件套②）
  { field_name: 'BOM表', type: 17 }, // 附件：本批次 BOM xlsx（财务三件套③）
  { field_name: '备注', type: FIELD_TYPES.TEXT },
];

async function main() {
  console.log('== 建表：发票采集 ==');
  const collect = await bitableApi.ensureTable('发票采集');
  console.log(`表 ID: ${collect.tableId}`);
  for (const field of COLLECT_FIELDS) {
    const r = await bitableApi.ensureField(collect.tableId, field);
    if (r.created) console.log(`  + 字段 ${field.field_name}`);
  }

  console.log('== 建表：报销批次 ==');
  const batch = await bitableApi.ensureTable('报销批次');
  console.log(`表 ID: ${batch.tableId}`);
  for (const field of BATCH_FIELDS) {
    const r = await bitableApi.ensureField(batch.tableId, field);
    if (r.created) console.log(`  + 字段 ${field.field_name}`);
  }

  const collectId = (await bitableApi.findTableByName('发票采集')).tableId;
  const batchId = (await bitableApi.findTableByName('报销批次')).tableId;
  console.log('\n✅ 完成。请把下面两行配置进 .env：');
  console.log(`BITABLE_COLLECT_TABLE_ID=${collectId}`);
  console.log(`BITABLE_BATCH_TABLE_ID=${batchId}`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
