# DEVLOG · approval-bot（财务审批机器人）

版本隔离单位：一次 `npm run push`（= 一次 git 提交 + 一次部署）。v1~v15 于 2026-09-04 按提交历史回溯编号，此后每次 push 在文末追加新版本（规则见顶层 [AGENTS.md](../AGENTS.md)）。

当前最新：**v45**（2026-09-25，随本提交落地）。上一版 v44（e3bc757，发票 OCR 转录服务端能力批）。

## 阶段十 · 私聊链接文本简化（2026-09-05）

### v27 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**催发票私聊改富文本：审批入口超链接文本简化为「项目名+金额」**
- 私聊从纯文本（text）升级为富文本（post）：纯文本不渲染 markdown 链接，升级后超链接可点击；地址仍是「申请编号」自带的审批实例链接，展示文本简化为「项目名 + 金额」（无项目回落物资名称，再回落申请编号），行尾保留 编号/完成时间。
- 新增 `sendPostToUser`（msg_type=post，沿用 230013 可用范围提示）与 `buildInvoiceUrgePost`/`previewInvoiceUrgePost`；`buildInvoiceUrgeText`（纯文本版）移除。回复轮询不受影响（post 发送响应同样返回 chat_id/create_time）。
- 实测：dry-run 预览（如 `[步兵机器人 541.13 CNY](applink…)`）+ 真实 post 发送（财务负责人，带测试标记）均通过。

## 阶段九 · 补交发票双栏判断（2026-09-05）

### v26 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**发票判断改双栏：发票/补交发票任一栏有值即算已交**
- 财务在多维表格「发票」栏后新增「补交发票」附件栏（type 17）；所有发票相关判断改为两栏任一有值即通过：周报未交发票分支（`getFinanceFollowUp`）与催发票私聊超期判定（`getOverdueInvoices`）统一收敛到新助手 `hasInvoiceSubmitted(fields)`。
- `hasAttachment` 天然兼容两种形态：Url 字段（发票 = {link,text} 对象）与附件字段（补交发票 = 数组，按长度判空）。
- 实测：当前补交栏全表无数据，名单数量无变化（未交 14 / 超期私聊 5），无回归。

## 阶段八 · 私聊失败群聊兜底链路移除（2026-09-05）

### v25 · 2026-09-05 · fix（随本提交落地，无独立哈希）
**移除"私聊不行→群聊兜底"链路（应需求方要求：机器人已可直达所有人私聊）**
- 实测结论（阶段七）：主动私聊不依赖"先私聊一次"，正常在册员工均可直达（杨彬意实证）；唯一 230013 个案（胡茗媛）系已离队，属账号生命周期问题，不再需要群侧兜底呈现。
- 移除 v23 引入的兜底呈现：① 催交失败不再写 `lastUrgeError/lastUrgeErrorAt` 状态；② 周报徽标去掉「**[私聊失败]**」分支（`invoiceStatusBadge` 回归 无法提交/已延期/已催N次 三态）。
- 保留：`sendTextToUser` 的 230013 中文提示与失败日志（仅日志诊断用，不进群聊）；`/approval-urge` 回复里的失败计数；「今日已催」卡与周报的业务升级链路（多次催交/无法提交/已催满）——它们是业务职能而非私聊失败兜底。
- 效果：私聊失败回归安静失败（日志可见），群聊内容只承载业务语义（催交明细/财务关注/周报）。


## 阶段八 · 今日已催每日播报（2026-09-05）

### v24 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**新增「今日已催」每日群播报（与周报能力分开），重点提醒多次催交/无法提交**
- 每日 10:30 私聊催交后（及 `/approval-urge` 发票分支）独立群播「🔔 今日已催」卡：① 今日已私聊明细（单号审批超链接+状态徽标）；② ⚠️ 需财务关注——多次催交仍无票（已催 ≥2 次，含满 3 次升级）与回复得知「无法提交」的记录，加粗原因标签；③ 未私聊汇总（延期中/无法提交/已催满）。有需关注记录时卡片头红色；无催交且无重点关注不发卡。
- 与周报严格分开：周报（周一 18:00）保持三段全量清单+本周统计+项目分布，不含今日已催内容；今日已催卡也不含未制单/未转账段。
- `runInvoiceUrge` 返回值补 `overdueRecords`（全量超期名单，供重点名单计算）；新增 `announceTodayUrged`（播报失败不抛出，避免定时重试导致私聊重复发送）；`buildInvoiceUrgeReportCard` 更名重构为 `buildTodayUrgedCard`。
- 同提交入库并行会话的 v23 改动（230013 显性化/lastUrgeError/[私聊失败]徽标/nas-diag.tmp.js 清理），详见阶段七。

## 阶段七 · 私聊不可达显性化（2026-09-05）

### v23 · 2026-09-05 · fix（随本提交落地，无独立哈希）
**私聊失败显性化：230013 可用范围拒绝 → 中文提示 + 周报「私聊失败」徽标**
- 排查"必须用户先私聊一次机器人才能触发私聊能力"：实为飞书 `230013 Bot has NO availability to this user`——共用应用「可用范围」不含目标用户（日志实证：胡茗媛被拒、徐进成功），属平台 ACL，代码/API 层无法绕过；彻底解法是管理员在飞书开发者后台把应用可用范围改为全员（或加入会被私聊的员工），改后无需对方先私聊。
- 代码侧让这类失败不再静默：① `sendTextToUser` 对 230013 附加可操作中文提示；② 私聊失败原因落 `urgeStateStore`（`lastUrgeError/lastUrgeErrorAt`），成功后自动清除；③ 周报未交票行对"从未成功私聊且最近一次失败"的记录加粗显示「**[私聊失败]**」徽标（已被成功催过的记录仍显示已催次数，避免误伤）。
- 顺带清理：上一提交误收的本会话临时诊断脚本 nas-diag.tmp.js 已删除。


## 阶段六 · 催发票私聊与周报项目分布（2026-09-05）

### v22 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**手动催办卡改版：默认展示本次私聊催交的未开票明细（未制单/未转账归位周报）**
- `/approval-urge` 留空（或 发票/全部）→ 走发票私聊催交后，群播新卡片「🔔 发票催交播报」：本次实际私聊的未开票记录逐条列出（单号审批超链接 + 私聊状态徽标），尾部汇总未私聊（延期中/无法提交/已催满）——解决此前手动催办卡只显示未制单、看不出"刚催了哪些"的问题。
- `报销单`/`转账` 改为仅显式传参才播对应清单卡（该二分支常规展示归周报职能），回复文本注明"常规展示见每周一 18:00 周报"。
- `runInvoiceUrge` 返回值新增 `urgedRecords`（本次实际私聊成功的记录）；新增 `buildInvoiceUrgeReportCard`。

### v21 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**周报单号超链接 + 催发票私聊回复监听（延期/无法提交/满3次升级）**
- 周报与催办卡片所有单号改为超链接（`[编号](审批实例链接)`，取「申请编号」Url 字段的 link），财务可点击直达审批详情页。
- 催发票私聊升级为有状态链路：每次私聊前用 IM 消息列表 API 轮询 p2p 会话新消息（不经网关事件链路，保持纯定时拉取定位；网关侧确认 p2p 默认进 hub，approval-bot 收不到私聊事件，故不走事件方案）。
  - 回复含「延期/推迟」→ 该批记录（最近一次私聊涉及的记录）3 天内不催，发确认回执；
  - 回复含「无法提交/交不了/开不出」→ 停止催该批记录，发确认回执；
  - 无回复 → 每天继续；同一笔累计私聊满 `INVOICE_URGE_MAX_TIMES`（默认 3）次仍无票 → 停止私聊升级财务。
- 周报未交发票行新增状态徽标：`[无法提交]`/`[已延期至M-D]`（加粗，需财务重点跟进）/`[已催N次]`/`[已催满3次]`（加粗）。
- 新增 `urgeStateStore`（JSON 文件持久化，pm2 重启不丢；`INVOICE_URGE_STATE_FILE` 必须配到项目目录外——SFTP 部署会清空 /opt/approval-bot，已配 /home/qianli/approval-bot-data/urge-state.json）。已交票记录状态自动清理。
- 新增 .env：`INVOICE_URGE_DEFER_DAYS=3`、`INVOICE_URGE_MAX_TIMES=3`、`INVOICE_URGE_STATE_FILE`。
- 实测：状态过滤（延期/无法提交/已催满各 1 → 私聊 5→2）、周报徽标与超链接渲染、parseReply 六组用例全部通过；IM 消息列表 API 实测可用（发送响应自带 chat_id + create_time 毫秒，sender.id 为 app_id 机器人、open_id 为用户）。
- 踩坑：① `im:chat` 权限后台未实际开通（repo 的 permissions.json 只是声明），会话列表 API 不可用——改为发送响应直接取 chat_id，不依赖 chats 列表；② 状态播种必须发生在 store 指向正确文件之后，否则 ensureInit 重载空状态。

### v20 · 2026-09-05 · docs+verify（随本提交落地，无独立哈希）
**三条催办链路确认（两条通道实发验证）+ README 链路一览表**
- 私聊通道实发验证：以「催发票私聊」真实文案（带【链路测试】标记）发往财务负责人（REMINDER_FALLBACK_OPEN_ID_1），IM API 投递成功——`sendTextToUser` 权限与链路首次实测打通。
- 群卡片通道实发验证：真实周报渲染卡片（含 @标记、三段催办、按项目分布）加测试标记后经 webhook 实发成功——近期生产日志里周报只有 dry-run 记录，真实发送路径借此补验。
- 生产日志核查：每日提醒定时链路多次正常执行（无审批中即跳过）；error log 中 PayloadTooLargeError 栈为历史残留（文件 mtime 2026-09-04 00:50，早于当天 2mb 修复部署），非现存问题。
- README 第四节新增「三条催办链路一览」表：分支判定条件、催办对象/通道、触发时机一表收敛。

### v19 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**新增手动催办指令 /approval-urge（触发未开票/未制单/未转账催办能力）**
- `/approval-urge [发票|报销单|转账]`，留空=全部；回复触发结果摘要。
- 分支与催办通道一一对应（与定时任务同款能力、按需触发）：未开票 → 私聊发起人（复用 invoiceUrgeService，与每天 10:30 定时私聊同一能力）；未制单/未转账 → 新增 `buildUrgeCard` 群卡片（@财务，经审批群自定义机器人 webhook 直发，两段都为空则不发卡片）。
- help 文案与 README 指令表同步更新。

### v18 · 2026-09-05 · feat（随本提交落地，无独立哈希）
**新增催发票私聊 + 周报本周统计按项目分布**
- 催发票私聊（第三个定时任务 `INVOICE_URGE_SCHEDULE`，默认建议每天 10:30，留空不启用）：「已通过」且完成时间满 `INVOICE_URGE_GRACE_DAYS`（默认 14）天仍未交发票 → 按发起人分组私聊（应用 IM API `sendTextToUser`），一人一条汇总名下全部超期记录，附「申请编号」Url 字段自带的**审批实例链接**（applink 审批详情页，非表格链接，同 ticket-bot 结单提醒同源），引导到审批界面补交；发起人为空的记录跳过并告警。
- 周报卡片底部本周统计（近7天）新增按「项目」单选字段粗分类：新增/通过/拒绝各自的项目条数分布（`approvalService.getApprovalStats` 返回 `projects` 分组，拒绝为 0 时省略该行）。
- 新增 `services/invoiceUrgeService.js`（支持 dryRun）与 `POST /api/bot/test-invoice-urge` 测试端点；`scripts/dryrun-invoice-urge.js` 预览脚本。
- 实测：超期 5 条涉及 2 人；本周 13 条通过按项目分布 = 步兵机器人 5、重装机器人 4、英雄机器人 3、无人机 1。
- 踩坑备忘：「申请编号」是 Url 字段 `{text, link}`，`fieldText` 只取 text，取审批链接必须读 `.link`，别拼表格记录链接。


## 阶段五 · 开发历史建档（2026-09-04）

### v16 · 2026-09-04 · `5f4b8af` · docs
**新增 DEVLOG 开发历史 v1~v15（按 push 回溯建档）**
- 本 DEVLOG 诞生：v1~v15 按提交历史回溯编号，此后每次 push 追加一版（规则见顶层 AGENTS.md「开发日志（DEVLOG）」节）。

### v17 · 2026-09-05 · docs（随本提交落地，无独立哈希）
**补记 v16 建档条目（昨日建档时「当前最新」头部与阶段五段落遗留未提交）**
- 无代码改动，仅提交 DEVLOG 头部修正（v15 → v16）与阶段五建档段落；同批部署为无差异重发。

## 阶段一 · 框架搭建（2026-07-21）

### v1 · 2026-07-21 · `87b2b13` · init
**Initial commit**（仅 .gitignore，GitHub 仓库初始化）

### v2 · 2026-07-21 · `23f6190` · init
**init: approval-bot - 审批机器人框架，含多维表格事件订阅、定时播报、指令交互**
- 首提骨架：feishu 四件套 + approval/broadcast/chat 三个 service + cron，沿用 pm-robot 的项目模板。

## 阶段二 · 数据层补全与播报框架成形（2026-08-06 ~ 08-30）

### v3 · 2026-08-06 · `5c50d1b` · fix
**补全数据访问层与指令处理层，修复播报链路断裂**
- 项目搁置两周后的救活性提交，链路首次端到端跑通。

### v4 · 2026-08-30 · `7513864` · feat
**完成审批播报框架——快照对账播报引擎、群聊隔离、每日提醒与周播报**
- 新增 reminderService；快照对账思路与 ticket-bot 的对账兜底同源。

## 阶段三 · 网关化与「纯定时催办」定型（2026-08-31 ~ 09-01）

### v5 · 2026-08-31 · `9e0d38d` · fix
**审批群内直接发送 /help 也响应财务帮助（未@时兜底）**

### v6 · 2026-09-01 · `9438682` · feat
**统一事件网关接入与字段展示修复；push.js 统一部署（密钥与脚本分离）**
- 自有长连接下线，改 HTTP 消费网关事件；新增 `src/utils/fields.js` 处理富文本字段。

### v7 · 2026-09-01 · `1476d19` · fix
**push.js 增加 NAS git fetch 失败自动转 SFTP 直传的兜底**

### v8 · 2026-09-01 · `df7c692` · feat
**播报重构为纯定时财务催办——移除事件即时播报**
- 职能定型：不再盯表格事件做即时播报，只做每日待审批提醒 + 催办周报（发票/报销单/转账）。

### v9 · 2026-09-01 · `207c4a8` · fix
**转发端点未知指令返回财务指引**

### v10 · 2026-09-01 · `a457499` · fix
**@识别兼容 mentioned_type=bot，BOT_NAME 修正为真实名称 爆米花机-对话型**

### v11 · 2026-09-01 · `0f2a55c` · docs
**对话模块标注架构铁律（生产对话由对话型机器人触发，本模块仅调试用）**

### v12 · 2026-09-01 · `b28711b` · fix
**移除 Actions 旧式部署（Secrets 回写 .env 与 push.js 冲突），统一走 push.js**

## 阶段四 · 边界文档与收尾（2026-09-02 ~ 09-04）

### v13 · 2026-09-02 · `04663c8` · docs
**增加项目职能边界声明（发错会话防护，需求错位即提醒停手）**

### v14 · 2026-09-03 · `439ba4a` · docs
**AGENTS.md 增加「顶层规则与交互性」段（独立会话内联交互契约，开工先读顶层总表）**

### v15 · 2026-09-04 · `fb43cae` · fix
**网关转发大事件 413——express body 放宽到 2mb**
- 与 ticket-bot、pm-robot 同批修复：审批实例事件体超 express 默认 100kb。

## 阶段五 · 全项目审查修复批次（2026-09-06）

### v28 · 2026-09-06 · e0b0a29 · fix
**全项目审查修复：dry-run 真只读 + 回执失败不中断 + 催办并发互斥 + 文档对齐**
- 催发票 dry-run 不再消费回复：原 pollAllReplies 的 silent 模式仍写延期/无法提交状态并推进 lastReadTime——dry-run 预览会把申请人刚回复的「延期/无法提交」消费掉且申请人收不到回执，与「只预览不改状态」的文档承诺相反；改为纯只读，回复留到真实执行再消费。
- 回执发送失败仅记日志不中断整轮（原先单个用户回执失败会让当天所有人的催办私聊与「今日已催」卡全部不发）；runInvoiceUrge 加并发互斥（定时任务、/approval-urge、测试接口重入会重复私聊、urgeCount 双计）。
- 周报「本周统计/项目分布」补活跃流程过滤（原 getApprovalStats 不过滤，测试流程记录混入周报，违反「非活跃流程一律静默」口径）；cron 下次执行时间计算支持周域与时区语义（原周报在非周一也显示「今天/明天 18:00」）；月末 setMonth 溢出钳制（11-30+3月滚到3-02）；「今日未私聊 NaN 条」防护。
- FEISHU_USE_LONG_CONNECTION 安全默认改 false（漏配时不再自行开长连接抢网关事件；生产 .env 已显式 false，行为不变）。
- 文档对齐：README 机器人名改「爆米花机-对话型」、删已不存在的 /api/bot/sync、催发票主消息通道改 sendPostToUser、卡片名「今日已催」、API 表补 /api/feishu/event、结构补 dryrun-urge-state.js，并移除误提交的群机器人 webhook 完整地址（应轮换）；另将上批遗留未提交的 AGENTS.md 边界补充一并入库。
- 版本线备注：v16~v27 期间条目未及时入档，版本号以 git 提交消息为准（fb5ae6f=v27），本条起恢复逐 push 记录。

## 阶段六 · 晚间静默——播报时段限制（2026-09-06）

### v29 · 2026-09-06 · 137e6fc · feat
**02:00–09:00（Asia/Shanghai）静默窗口：三个定时播报积压到 09:00 统一补跑（可配可关）**
- 新增 `src/utils/quietHours.js`（顶层 AGENTS.md「晚间静默」规则的本仓实现）：窗口 `[QUIET_HOURS_START, QUIET_HOURS_END)`（默认 2→9，支持跨午夜写法，`QUIET_HOURS_DISABLED=1` 关闭）内 cron 触发不直接执行，登记积压持久化 `.quiet-backlog.json`（重启不丢），窗口结束整点重跑整个任务函数；启动时过点立即补冲刷；冲刷失败单条保留重试 ≤3 次。
- 接线：催办周报/每日待审批提醒/催发票私聊三个定时任务统一过 `gateTask`（同触发槽位去重）；冲刷重跑以补发时刻最新数据重查——夜里已了结的审批不再催，催办状态/已催标记/p2p 回复轮询都以实际补发时刻为准；催发票的「今日已催」群播属同一任务流一并顺延。
- 现状默认调度（周一18:00 / 每天09:00 / 每天10:30）均不在窗口内，本改动为规则兜底：调度改进窗口或未来新增夜间播报时自动生效。
- 豁免：人工接口（`/api/broadcast`、urge/reminder 手动触发、dryRun）不受限。
- 其他：`getCronStatus` 附 `quietHours` 状态；.gitignore/.env.example 同步；README §四 补静默说明；顶层 AGENTS.md 新增「晚间静默」规则段。
- 同批补：README §九 项目结构树补 `src/utils/quietHours.js`（例行维护扫描发现结构树漏登记新文件）。

### v30 · 2026-09-11 · 6e38233 · chore

**隐私整改（代码与文档零人名/群号）+ 提醒回落变量名通用化**

- `src/config.js`：提醒 @ 回落变量 `HE_YUNJIE_OPEN_ID`/`ZHANG_GUOHAO_OPEN_ID` → `REMINDER_FALLBACK_OPEN_ID_1/2`（本地与 NAS `.env` 已随批同步改名，行为不变：留空回落 `DAILY_REMINDER_MENTION_IDS` 配置）
- README 移除硬编码审批群号与人名（群 id 只存 .env）；DEVLOG 历史条目人名最小替换（角色称谓，内容不变）
- 无功能变更；`.env.example` 键名同步

### v31 · 2026-09-11 · 1e8630f · fix

**全仓审计 debug 批：飞书 API 客户端加超时 + 静默积压文件可配**

- `requestAPI` 与 tenant_access_token 获取加 15s AbortSignal 超时 + 非 JSON 响应保护——此前网络挂起会把 cron 无限挂住，催发票私聊的互斥锁永不释放（之后每天 skip 'already_running' 直到重启）
- quietHours 积压文件支持 QUIET_BACKLOG_FILE 挪出项目目录；`.env` 已配 /home/qianli/approval-bot-data/（目录已存在，与催发票状态文件同目录），SFTP 部署清目录不再丢积压

### v32 · 2026-09-11 · 0728e21 · feat

**定制窗口 GET /api/approval/policy（顶层「机器人后端定制窗口」规则首批落地）**

- 只读全景：审批流程名/状态映射（APPROVAL_PROCESS_NAMES/STATUS）、审批人白名单（APPROVERS）、催发票参数（INVOICE_URGE_*）、提醒与 cron 配置、审批群 chatId。
- 只读窗口；催办等行为的修改仍走 .env + push。

### v33 · 2026-09-12 · 随本提交落地 · chore

**全量 debug 批：quietHours 建目录守卫 + 文档补齐**

- quietHours 补启动自动建目录（对齐 ticket-bot/bambu/duty 版本）：`QUIET_BACKLOG_FILE` 指向项目外时目录无人预建，此前依赖 NAS 侧目录已存在。
- `.env.example` 补 `QUIET_BACKLOG_FILE` 键（v31 起 `.env` 已配，模板漏键）。
- README API 表补 `GET /api/approval/policy` 定制窗口行（v32 上线时漏记）。
- DEVLOG 哈希回填：v28（e0b0a29）/ v29（137e6fc）/ v30（6e38233）/ v31（1e8630f）；头部「当前最新」指针 v29 → v33。

### v34 · 2026-09-13 · cabe8d7 · feat

**管理端点鉴权 + 部署前测试闸门（体系推荐 R2/R4）**

- 新增 src/auth.js：/api/bot/test-* 触发端点需 X-API-Token（fail-closed）。运维台代理自动带头。
- push.js 加部署前测试闸门：入口/服务语法检查（本仓暂无 stub 套件）。

### v35 · 2026-09-14 · a7eed1c · chore

**部署目标切换小电脑（Windows）——push.js 路径双轨**

- 路由器割接完成：机器人运行环境整体从 NAS 迁至小电脑 DESKTOP-FE1MIGI（192.168.31.57，Windows + PortableGit + node v22.10.0 + pm2，ssh 默认 shell = git-bash，开机自启 pm2 resurrect）。
- push.js 目标段双轨：exec 走 MSYS 路径（/c/qianli/...），SFTP 走 Windows 路径（C:/qianli/...）；REMOTE_DIR/TAR_REMOTE 改指小电脑。
- 本仓 .env 的 NAS_* 四值改指小电脑（192.168.31.57:22 mechax）——运维台 /api/nas/api 代理随之自动指向。
- NAS 转入备件位：保留 copyparty/快照/备份职能，校园网保活脚本已部署于 NAS（每分钟 cron + @reboot，v35 前置迁移项）。

### v36 · 2026-09-14 · 8dfccd9 · docs

**README 部署目标表述清扫收尾（NAS→部署目标，纯文档，随下次 push 部署）**

- 「八、部署到 NAS」→「部署到部署目标（小电脑）」，`NAS_*` 键标注历史命名语义=部署目标，`/opt/approval-bot` 路径表述同步；「私聊状态文件必须放项目目录外」一句的「NAS 的 SFTP 部署」改为「部署目标的 SFTP 部署」。属顶层 v64 全量表述清扫的漏网收尾（上一会话遗留，本批盘点入库）。

### v37 · 2026-09-15 · 92f84fb · feat

**催发票私聊前通讯录兜底校验——发起人退队停止私聊并呈报财务**

- 背景：胡茗媛已退队（v23/v25 即实证的 230013 个案），其名下超期记录每天仍进私聊名单、必然失败（230013 刷日志），且因从未成功私聊、无状态记录，永不进「需财务关注」，财务侧无感知。
- 新增 `src/feishu/contacts.js`：`listActiveOpenIds()` 拉全租户部门×成员 → 活跃成员 open_id 集合（离职不在任何部门、停用 activated=false 均不入集合）；端点与 duty-bot contacts.js 同款（共用应用，权限 contact:user.base:readonly 已在应用清单）。
- `invoiceUrgeService` 私聊前新增校验步：候选发起人不在通讯录 → 记录标记 `resigned` 停止私聊，转呈财务——周报徽标 `[发起人已退队]`、「今日已催」需财务关注、未私聊汇总行（延期中/无法提交/已催满/已退队）三处可见；`resigned` 记录每轮重过校验，发起人重新入队自动恢复催办；通讯录校验失败 fail-open（本轮按原名单继续，不阻塞催办）；dry-run 静默不写状态。
- 文档同步：README（逻辑总览/状态机表/徽标清单/项目结构）、用户侧《机器人总成使用指南.html》今日已催卡描述（工作区外，不进 git）。
- 实测：node --check 全过；生产数据 dry-run——超期 9 条中胡茗媛 1 条被正确标记退队排除出私聊名单，其余 8 条正常分组预览（徐进 7 笔/卢裕阳 1 笔）。

### v38 · 2026-09-15 · 49e5fe4 · fix

**R10/R13 鉴权与卫生批（全项目审查推荐落地批，仅配置）**

- .env：FEISHU_VERIFICATION_TOKEN 补配共享密钥——/api/feishu/event 的 token 校验此前因密钥为空整体跳过（fail-open），LAN 可伪造 im.message 事件驱动 /approval-* 指令链路；现网关转发帧注入同一密钥，校验真实生效（代码校验逻辑本就有，纯配置就位）。
- .env：数据文件 POSIX 路径显式化 C:/home/qianli/...（防 cwd 换盘静默漂移）。

### v39 · 2026-09-15 · 随本提交落地 · feat

**催发票节奏改 2 天一催 + 上限 5 次 + 回执监听与引导优化**

- 节奏：新增 `INVOICE_URGE_INTERVAL_DAYS`（默认 2）间隔闸——定时任务仍每天 10:30 跑（回复轮询每日不漏），同一笔距上次私聊不满 2 天不重复催；「今日已催」卡改为仅实际催交日发送（间隔未到日不发空卡），未私聊汇总三处（卡片/指令回执/日志）补「间隔未到」计数。
- 上限：`INVOICE_URGE_MAX_TIMES` 默认 3 → 5（.env 与模板同步）。注意：上限上调后，此前催满 3 次升级的记录会重回私聊名单、最多再催 2 轮（间隔 2 天）。
- 引导优化（此前最大缺口：私聊文案从未告知可回复，监听器近乎空转）：私聊文案补回复指引——回复「延期」（可带时长）顺延、回复「无法提交」转财务；parseReply 识别词扩充（还没/未开/没开/过几天/晚点/稍后/改天/下周 → 延期；办不了 → 无法提交）；新增 `parseDeferDays` 时长解析（支持中文数字与天/周，钳制 1~60 天，无时长回落 deferDays），延期回执按实际时长确认，statusNote 记录申请天数。
- 可测性：invoiceUrgeService 发送/回执/播报改走 bot 模块对象（可桩替换）；新增 `scripts/test-invoice-urge.js` 桩测试（parseReply ×10 / parseDeferDays ×8 / 间隔闸 / 计数升级 / 满上限跳过，全离线、状态写临时文件），接入 push.js 部署前测试闸门——本仓首个 stub 套件，补上 v34 注明的缺口。
- 文档同步：README（节奏/状态机表/播报规则/结构树）、AGENTS.md 职能段、用户侧 HTML 私聊节奏四处。
- 实测：桩测试全绿；生产数据 dry-run——新文案渲染正确，通讯录兜底（1 条退队）与既有状态过滤无回归。
- 并发备注：本批开发期间另一会话落地 v38（纯 .env 配置），本批 DEVLOG 顺手回填 v37/v38 哈希。

### v40 · 2026-09-17 · 随本提交落地 · fix

**全量 debug 批：v39 催发票三处逻辑 bug 修复 + 配置收口（v39 同批收口上线）**

- parseDeferDays 复合中文数字修复：十五天=15/二十天=20/二十五天=25（旧解析只认单字）、两周零三天=17（周+天求和）、单位补「日」（延期7日=7）、半周=3、「下周…」=7；保留 1~60 钳制与回落。
- 间隔闸改按上海日历日比较（旧精确毫秒比较因 now/lastUrgeAt 打点时差，「2 天一催」实际 3 天；现第 0 天催、第 2 天可再催）。
- announceTodayUrged 播报闸修复：当日新增「需财务关注」（无法提交/退队，statusChangedAt 记账）不再被「无催交即跳过」吞掉——当天无催交且无当日状态变化才不发卡。
- 「今日已催」卡头「延期 3 天内免催」改插值 deferDays + 可带时长表述（与 v39 私聊文案同口径）。
- .env.example NAS 三键迁小电脑实值；cron 头注释注明「默认留空=不启用，注释时刻为现网配置值」。
- 测试：stub-test-invoice-urge 扩到 parseDeferDays ×16 + 48h 边界 + 第 1 天 hold + 播报闸正反用例，全绿。

### v41 · 2026-09-19 · 随本提交落地 · chore

**npm test 与 push.js 闸门同源（R27）**

- package.json `test` 由 `echo "Error: no test specified"` 占位符改为与 push.js 测试闸门完全相同的清单（`node --check src/index.js && node --check src/services/chatService.js && node scripts/test-invoice-urge.js`）——此前直接 `npm test` 得到误导输出，与 README「测试」节口径脱节（09-18 全量 debug 批观察项 R27）。
- 纯元数据批，无行为改动；npm test 实跑验证全绿。

## v42 · 2026-09-20 · 随本提交落地 · fix

**全量 debug 批：催发票回复轮询 230001 根因修复 + 分页补齐**

- **P1 · 回复轮询 230001 根因修复**：`listChatMessages` 把毫秒 `lastReadTime` 直接当 `GET /im/v1/messages` 的 `start_time` 传且不传 `end_time`——该接口查询参数是**秒级**（响应体 `create_time` 才是毫秒），13 位毫秒被解释为「未来」，end 缺省小于 start → 230001。凡成功私聊催过一次的用户回复轮询必失败：用户回「延期/无法提交」永远不被识别，延期者被反复私聊到催满、`lastReadTime` 永不推进。现 `start_time=秒(since/1000)` + 显式 `end_time=秒(now)`，客户端毫秒过滤口径不变。此病自催发票私聊上线起存在（v40 修的是同模块另外三处，桩测试从未执行过该路径所以漏网）。
- **分页补齐**：①会话消息拉取补 `has_more/page_token` 循环（原 page_size=50 一页，未读超 50 条时延期识别按天拖沓）；②`contacts.listActiveOpenIds` 部门列表补翻页（原单页 50，组织超 50 部门时漏人 → 误标 resigned 持久化停催且无法自愈）。
- **桩测试 230001 回归锁**：`invoiceUrgeService` 改经 `client.requestAPI` 模块引用以便打桩；新增场景断言 start_time/end_time 均为 10 位秒级且 end≥start。全绿。

### v43 · 2026-09-24 · 432e8a0 · fix

**事件端点 fail-closed + auth 废除 ?token=（全仓复查批，附 README 回填）**

- 提交说明：fix: /api/feishu/event fail-closed（同 ticket-bot 口径）+ auth 废除 ?token=
- src/index.js：/api/feishu/event 原 fail-open（token 未配置即跳过校验），补「未配置 FEISHU_VERIFICATION_TOKEN 一律 403 拒绝 im.message.receive_v1 帧」；本仓该端点仅调试用消息处理消费，现网 .env 已配 token，行为无实际变化。
- src/auth.js：删除 req.query.token 回退（R10② 同口径，token 会进访问/代理日志）。
- 随本提交入库：README 部署路径 /opt/ → /c/qianli/opt/（09-22 遗留文档批）。
- 测试：node --check ×2 + 催发票桩全套通过。

### v44 · 2026-09-24 · 随本提交落地 · feat

**发票图像 OCR 转录（飞书免费 OCR + 字段提取规则引擎 + 定制窗口热改）**

- 提交说明：feat: 发票图像 OCR 转录——飞书免费 OCR+字段规则引擎+定制窗口热改+桩测试
- **引擎选型**：飞书开放平台「识别图片中的文字」（`POST /open-apis/optical_char_recognition/v1/image/basic_recognize`），**免费**（官方 API 清单 chargingMethod=none，单租户 20 QPS，图片 <5MB）；发票图下载自飞书消息、识别在飞书侧完成，数据不经第三方，图片不落盘（内存直传）、转录结果不持久化。飞书 OCR 返回按区域分段文本但无坐标，「某些区域转录」用可配置字段规则在分段上实现（anchor 标签锚点 same/next/same_or_next + occurrence 区分买方/卖方同标签；regex 取捕获组）。内置默认规则：发票号码/开票日期/买卖方名称与税号/价税合计大写+小写。
- **新增 src/services/ocrService.js**：`recognizeBuffer`（base64 调 OCR，非 0 错误码如实透出、超限前置拒绝不发请求）、`transcribe`（message 入口=downloadImage+OCR；base64 入口直连；组装 segments/fullText/fields/misses/meta）、`extractFields` 纯函数规则引擎、规则持久化 `.ocr-fields.local.json`（首次种子落盘，`setFieldRules` 整表校验替换即时生效，`resetFieldRules` 回内置默认）。
- **client.js**：+`downloadImage`（duty-bot v28 同款：用户图片必须走消息资源接口 `/im/v1/messages/:id/resources/:file_key`，走 `/im/v1/images` 对用户图片报 234001；需 `im:resource` 权限）；`requestAPI` 加 `opts.timeoutMs`（OCR 大 base64 体用 30s，默认仍 15s，向后兼容）。
- **index.js 端点**：`POST /api/ocr/transcribe`（requireApiToken；`{messageId, imageKey}` 或 `{imageBase64}`；OCR_ENABLED=false 时 503）、`GET /api/ocr/fields`（只读窗口）、`POST /api/ocr/fields`（热改，requireApiToken，action=set/reset）；`GET /api/approval/policy` 增 `ocr` 段（engine/enabled/fieldCount/fields 清单）。
- **config/.env.example**：`OCR_ENABLED`（默认开）、`OCR_TIMEOUT_MS`（默认 30000）、`OCR_MAX_IMAGE_BYTES`（默认 5MB）、`OCR_FIELDS_FILE`（默认项目内 `.ocr-fields.local.json`，生产应配项目外——SFTP 部署清目录；push.js 打包排除清单同步加该文件，防「本地种子覆盖部署目标运行时规则」）。
- **桩测试 scripts/stub-test-ocr.js**（并入 npm test 与 push.js 闸门）：validateRules 非法形态 ×7、extractFields（三种 take/occurrence 第 N 命中/regex 捕获组与整匹配/全未命中 misses）、OCR 调用契约（路径/base64 往返/timeoutMs 透传/错误码透出/空与超限拒绝不发请求/空识别报错）、transcribe 双入口与参数校验、规则窗口热改与落盘（校验失败不丢生效规则）、端点 403 鉴权/200 链路/500 错误透出/503 开关/policy ocr 段。**take=same 误跨段回落 bug 由本套件抓出后修复**（stub 先行红绿流程）。
- **权限（后台待开通）**：`im:resource`（获取与上传图片或资源）、`optical_char_recognition`（图片识别，高级权限）；feishu-permissions.json/.txt 与 README 权限节同步。开通前调用 OCR 会报错。
- **接入状态**：本期只落服务端能力（HTTP 端点 + service），消息侧入口（私聊回传识别/审批群交互）待需求方定接口形态后另批接入；真实票据分段形态联调后可经 `/api/ocr/fields` 热改规则。
- 测试：npm test 全绿（node --check ×3 + 催发票桩全套 + OCR 桩全套）。

### v45 · 2026-09-25 · 随本提交落地 · feat

**发票采集全链路 + 报销批次三件套（对接重庆大学财务/小翼Plus 流程，hub 同批联动）**

- 提交说明：feat: 发票采集全链路(私聊/催办回票+三通道识别+双闸查重+金额归类+采集台账)+报销批次三件套(自动拟批/锁定/打印PDF/BOM)+存量回溯
- **队员侧交票（减负：干掉「修改审批」交票）**：队员私聊机器人（或催发票私聊直接回图）发 发票 PDF/二维码截图/拍照 → `invoiceParser` 三通道识别（数电票 PDF 文本层直读 > 发票二维码解码（与重大小翼Plus 扫码同源）> OCR 兜底，`looksLikeInvoiceText` 特征词判定非发票图静默忽略不打回）→ 校验闸：查重双闸（发票号精确+日期/金额/销售方三元组近似）→ 抬头校验（`INVOICE_ALLOWED_BUYERS`「名称|税号」可多套，不配只记录）→ 金额归类匹配（精确唯一自动归；名下唯一候选直接归由金额比对闸 ±5%/¥10 兜底标「金额不符」；多候选转财务人工；**候选排除采集台账已收录申请——「发票/补交发票/采集台账」三口径等价的函数级落地**，修连续交多张票时旧记录干扰归类）→ 落「发票采集」表（真源）+回写审批表「补交发票」附件栏（镜像，先读后 append+按记录串行锁防丢图）→ 私聊回执核对单/打回提醒（带缺失要素与重发指引）。
- **hub 同批联动**（pm-robot chatService）：p2p 图片/文件消息 fire-and-forget 转发 approval-bot `POST /api/invoice/collect`（X-API-Token，usageReport 同源 token）；值日照片线照旧，两条线靠「特征词静默」互不干扰。
- **催办闭环**：`invoiceUrgeService` 回复轮询扩展 image/file 消息 → 走采集链路；采集成功→补交发票栏回写→下轮催办名单自动排除（`getOverdueInvoices`/`getFinanceFollowUp` 并入采集台账口径，fail-open：采集表未配置退回两栏判断不崩）。
- **财务三件套（/approval-batch 指令）**：`preview` 票池按项目分组拟批建议；`lock <批次号> [项目]` 锁定（批次号沿用财务既有命名 27备赛N×X，回写采集表「批次」+审批表「报销单」栏，**锁定后顺序不可变、迟到票进下一批**）；`submit/paid/reject <批次号>` 状态流转。锁定即自动生成 ②打印件 PDF（A4 竖版一页两票、严格按录入顺序，pdf-lib；原件缺失生成 ASCII 占位页——pdf-lib 内置字体无中文）③BOM xlsx（exceljs，申请/物资/型号/金额/发票/校验状态+合计），均落「报销批次」表附件。批次状态机 拟批→已锁定→已提交→已到账/已退回。
- **存量回溯**：`POST /api/invoice/backfill`（X-API-Token）——审批表已交票经 SourceID→`GET /approval/v4/instances/:id` 附件引用→`downloadApprovalFile` 探测式下载（两个候选路径，**飞书各文档源对下载路径表述不一，首次运行即验证，路径有变改 client.js 候选清单**）→识别回填采集表；历史「报销单」批次值同步到采集表（历史批次只记录不重建状态机）。
- **播报增强**：周报卡新增「报销台账」段（票池待归集张数/金额+各状态批次汇总；采集表未配置降级跳过）。
- **新表**：审批 base 下「发票采集」「报销批次」（`scripts/create-collect-tables.js` 幂等建表，表 ID 配 `BITABLE_COLLECT_TABLE_ID`/`BITABLE_BATCH_TABLE_ID`）。**采集表为唯一真源，补交发票栏为镜像**（曼波确认：修改审批仅一次机会、队员交票后不再改审批，镜像覆盖风险可忽略）。
- **依赖新增（全免费 npm）**：sharp/jsqr（二维码解码）、pdf-parse（数电票 PDF 文本）、pdf-lib（打印件排版）、exceljs（BOM）。**权限新增（后台待开通）**：`approval:approval:readonly`（存量回溯）、`drive:drive`（附件转存/打印件/BOM 落表）。
- **桩测试** `scripts/stub-test-invoice-collect.js`（并入 npm test 与 push 闸门）：解析器（数电票/老票文本、QR 两代格式、特征词）、金额归类四场景、抬头三态、采集链路（收录+镜像+查重双闸+非发票静默+缺要素打回+金额不符）、三口径等价与 fail-open、拟批/锁定/状态流转、端点鉴权 403/400/200/503。**测试先行抓出三处实现缺陷并修复**：take=same 式跨段吞税号、PDF 排版下半页 y 坐标错位、addPage 参数形态错误。
- 测试：npm test 全绿（node --check ×7 + 催发票桩 + OCR 桩 + 采集桩全套）。
