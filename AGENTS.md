# approval-bot 开发边界（防需求发错会话）

## 本项目职能
财务审批机器人：仅服务审批群（BOT_CHAT_ID），`/approval-*` 指令；每周财务催办周报（催发票→催制单→催转账，周一 18:00）；每日待审批提醒（09:00）；催发票私聊（每 2 天一催、任务每天 10:30 跑，已通过满 14 天仍未交发票 → 私聊发起人并附审批实例链接；私聊后轮询 p2p 会话消息识别「延期/无法提交」回复，同一笔满 5 次升级周报；实际催交日独立群播「今日已催」卡——今日明细+需财务关注（多次催交/无法提交/发起人退队），与周报分开）。**发票采集全链路（v44-v46 起）**：hub 把 p2p 图片/文件观察转发到本仓 `POST /api/invoice/collect`，三通道识别（PDF 文本层/二维码/飞书 OCR 兜底）+ 双闸查重（发票号精确 + 日期/金额/税号三元组近似）+ 抬头校验，落「发票采集」表并镜像回写审批表「补交发票」；`/approval-batch` 报销批次三件套+**交付包**（lock 拟批/打印 PDF+BOM xlsx/**物料清单（校格式）+投递底单 xlsx**（v49，严格照财务《物料清单》模板与学校「智能财务服务大厅投递单」实样；开票内容缺失标黄，摘要/笔序自动拼装落批次表）/submit|paid|reject 状态机（paid 回执附归档文件夹名建议）/regen 四件自愈）；**「接取」**（v49）：锁定后审批群发交付卡，hub 转发裸词 `接取`（带 senderName）到 `/api/chat/command` 登记批次接取人；**报销台账电子表格同步**（v50，《2027年千里团队报销台账》：submit 追加行/paid·reject 按批次摘要精确回填，not_found 不误改人工行，ledger 子指令手动补，读改写互斥锁）；**安全边界（v51 全量安全审查批）**：HTTP 仅回环监听 127.0.0.1（hub 同机转发/运维台 SSH 代理不受影响，跨机一律 SSH 隧道）；资金指令操作人经 open_id 反查通讯录实名（不信自报昵称），submit/paid/reject 留痕批次表「最后操作人/最后操作时间」；`/api/invoice/backfill` 存量票回溯（APPROVAL_CODE 驱动）。**纯定时拉取+hub 观察转发，无事件消费**；群指令由 feishu-gateway/hub 转发。工单审批任务的自动通过是 ticket-bot 在做（approvalLinkService），本项目不碰工单审批定义与审批人白名单。


## 顶层规则与交互性（每次开工先读）

本会话是独立工作区，**不会自动加载顶层规则**——开工前先读一遍 `../AGENTS.md`（顶层职能总表 + 架构铁律）；涉及消息路由、@识别、指令转发的改动，再读顶层 `.agents/skills/qianli-chat-architecture/SKILL.md`。

与其它机器人/服务的交互契约（改接口前先对顶层文档）：
- 五个机器人**共用同一个飞书应用**；长连接只属于 feishu-gateway，本项目事件一律 `FEISHU_USE_LONG_CONNECTION=false`，由网关转发到本项目的 `POST /api/feishu/event`；
- 指令交互契约：`POST /api/chat/command`，入参 `{command, args}`，回 `{reply}`（回复由调用方——网关或 hub——代发）；
- 群播报走群自定义机器人 webhook，对话回复走飞书 IM API；
- 部署一律项目内 `npm run push "说明"`（规则见 qianli-deploy skill 与顶层 AGENTS.md），NAS 凭证在 .env 的 NAS_*；
- 通用坑：@识别要兼容 mentioned_type='bot'；多维表格字段值先过 fieldText 类工具再拼字符串；express.json 需放宽到 10mb（OCR base64 直传，v46）。

顶层职能速览（需求跨项目即停，走上方"发错时的规定动作"）：
ticket-bot=工单域｜approval-bot=财务审批｜project-management-robot=对话枢纽+DDL｜bambu-print-reservation=打印预约｜duty-bot=值日+快递｜wecom-attendance-bot=企业微信考勤周报｜feishu-gateway=事件接入｜qianli 顶层=部署/架构/整理。

## 只管这些（归属信号）
审批、发票、报销单、转账、财务、采购、审批群指令、催办、APPROVERS、审批多维表格字段。

## 不管这些（发错信号 → 立即停手）
- **工单、接单、结单、面向组别、工单播报、工单审批任务自动通过** → ticket-bot 会话（`ticket-pm/ticket-bot`）
- **项目 DDL 播报、逾期确认、各群对话/关键词** → project-management-robot 会话
- **3D 打印、预约、打印机** → bambu-print-reservation 会话
- **事件路由、网关连接、指令没到（跨项目）** → feishu-gateway 会话
- **部署链路、push.js、架构、工作区整理** → qianli 顶层会话

## 发错时的规定动作
用户需求落在"不管这些"时，必须：
1. **停止开发，不写任何代码、不改任何文件**；
2. 回复：「⚠️ 这个需求属于 <X 项目>（负责 <…>），当前会话是 approval-bot——你可能发错会话了。请到对应会话发送；如确认要在 approval-bot 做，请回复"就在本项目做"。」
3. 用户明确确认后才继续；模糊回答时再确认一次。
4. 边界模糊时：先列分工与建议归属，等用户指定后再动手。
