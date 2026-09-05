# approval-bot 审批机器人

财务审批播报机器人 —— 基于飞书多维表格「采购申请/发票提交」审批表，按定时任务向审批群推送**财务催办周报**（催发票/催报销单/催转账，本周统计附按项目分布）与**每日待审批提醒**，并对超期未交发票的申请人做**催发票私聊**。审批提交、审批通过/拒绝均**不做事件即时播报**。

## 一、架构说明：共用飞书应用 + 群聊隔离

本项目**与所有 qianli 项目共用同一个飞书应用**（`APP_ID` 相同），但功能上做了两层隔离：

### 1. 群聊隔离
- 本项目**仅服务审批群**（`BOT_CHAT_ID = oc_1ea53731a8772400450da6ab107f8331`）
- 指令与对话触发只在该群生效，且必须 @机器人（共用应用机器人的实际名称为 **爆米花机_财务型**，`BOT_NAME` 与之保持一致用于 @识别；`/approval-*` 前缀指令即使漏检 @ 也会触发）
- 其他群的消息、私聊消息一律跳过（留给爆米花机 project-management-robot 的正常对话能力），不回复、不记录
- 定时播报通过审批群的**自定义机器人 Webhook**（`BOT_WEBHOOK_URL`）推送

### 2. 事件接收方式
事件统一由 **feishu-gateway**（`FEISHU_USE_LONG_CONNECTION=false`，本服务不开长连接）持有共用应用的唯一长连接并转发到本服务 `/api/feishu/event`。本服务只消费消息事件（指令与对话触发）；**多维表格事件不消费**——播报全部为定时任务在执行时拉取最新数据计算，天然不受事件分发/重复投递影响。

> 若网关不可用，可临时把 `FEISHU_USE_LONG_CONNECTION` 改回 `true` 独立接收消息事件。

## 二、飞书应用配置（共用应用，仅需补充权限/事件）

1. **权限**（见 `feishu-permissions.json`）：`bitable:app`、`im:message`、`im:message:send_as_bot`、`im:chat`、`contact:user.base:readonly`
2. **事件订阅**：`im.message.receive_v1`（由 feishu-gateway 长连接接收）
3. **审批群自定义机器人**：Webhook `https://open.feishu.cn/open-apis/bot/v2/hook/d91361fc-b824-4a15-a8a3-a85b4344afba`

## 三、多维表格字段约定

审批表（`BITABLE_APPROVAL_TABLE_ID = tblwwBsMZDdP1iSN`）关键字段：

| 字段名 | 类型 | 用途 |
|--------|------|------|
| 申请状态 | 单选 | 催办对象过滤：仅「已通过」进入财务催办分支 |
| 审批流程 | 单选 | 流程过滤：只有活跃流程才纳入统计与催办 |
| 发票 | 附件 | **催办分支1**：为空 = 未交发票 → 催发票 |
| 报销单 | 单选 | **催办分支2**：已有发票但此栏为空 = 未制单 → 做报销单（「无需报销」视为已处理） |
| 是否转账 | 单选 | **催办分支3**：发票+报销单齐全但为空，且完成时间超3个月 → 提醒转账 |
| 完成时间 | 日期 | 转账提醒的宽限期起算点；本周通过统计 |
| 发起时间 | 日期 | 本周新增统计、催办列表展示 |
| 发起人 / 当前处理人 | 人员 | 列表展示 / 每日提醒 @ |
| 申请编号 / 购买物资名称 / 总金额 / 项目 / 付款人 | 各类 | 列表与统计展示 |

**「审批流程」过滤**：表中混有历史/测试流程（如「发票（测试不要提交)」），`APPROVAL_PROCESS_NAMES` 配置当前活跃流程 `💸【27赛季】千里采购申请/发票提交`，非活跃流程的记录一律静默。

## 四、播报逻辑总览（纯定时，无事件即时播报）

```
定时任务（Asia/Shanghai）

├─ 每周一 18:00（CRON_SCHEDULE）
│    🧾 财务催办周报（仅统计「已通过」且活跃流程的记录）
│    ├─ 分支1 未交发票：发票栏为空
│    │    → 提醒财务催发票
│    ├─ 分支2 未制单：已有发票但「报销单」为空
│    │    → 提醒财务做报销单（报销单=无需报销 视为已处理）
│    ├─ 分支3 未转账：发票+报销单齐全但「是否转账」为空
│    │    且 完成时间已超过 3 个月（宽限期，未满不提醒）
│    │    → 提醒财务跟进转账
│    └─ 卡片底部：本周统计（近7天新增/通过/拒绝，
│         并按「项目」字段粗分类：各项目条数分布）
│
├─ 每天 09:00（DAILY_INVOICE_REMINDER_SCHEDULE）
│    ⏰ 待审批提醒：有「审批中」记录才发送，@当前处理人（空则 @ 配置审批人）
│
└─ 每天 10:30（INVOICE_URGE_SCHEDULE，留空不启用）
     🧾 催发票私聊：「已通过」且完成时间满 INVOICE_URGE_GRACE_DAYS
     天（默认 14）仍未交发票 → 按发起人分组私聊催交，
     附「申请编号」自带的审批实例链接（审批详情页，非表格链接）
```

- 审批提交、审批通过/拒绝**不触发任何播报**（多维表格事件不订阅、不消费）
- 周报各分支按时间倒序（最久未处理的排最前），单段超过 15 条折叠
- 周报抬头 @财务负责人（`DAILY_REMINDER_MENTION_IDS`，回落到何云杰/张郭浩）
- 催发票私聊走应用 IM API（`receive_id_type=open_id`），一人一条汇总名下全部超期记录；发起人为空的记录跳过

## 五、本地开发

```bash
npm install
cp .env.example .env   # 填入配置（目标群 ID、webhook、多维表格）
npm start              # 生产模式
npm run dev            # 开发模式（自动重启）

curl http://localhost:3002/api/health
```

## 六、API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查（含目标群 ID） |
| GET | `/api/approvals` | 所有审批记录 |
| GET | `/api/approvals/pending` | 审批中列表 |
| GET | `/api/approvals/stats` | 审批统计 |
| GET | `/api/approvals/:id` | 审批详情 |
| POST | `/api/bot/test-broadcast` | 立即触发一次周播报（测试） |
| POST | `/api/bot/test-reminder` | 立即触发一次每日提醒（测试） |
| POST | `/api/bot/test-invoice-urge` | 立即触发一次催发票私聊（测试，body 传 `{"dryRun":true}` 只预览不发送） |
| POST | `/api/bot/sync` | 立即执行一次全量对账 |
| GET | `/api/bot/cron-status` | 定时任务状态 + 对账快照状态 |
| GET | `/api/bot/history` | 播报历史 |
| POST | `/api/chat/command` | 指令转发端点（`{command, args}` → `{reply}`） |

## 七、机器人指令（仅审批群，需 @爆米花机_财务型）

| 指令 | 说明 |
|------|------|
| `/approval-help` | 显示帮助（`/help` 同效） |
| `/approval-list` | 查看所有申请（审批中在前） |
| `/approval-pending` | 查看审批中列表 |
| `/approval-status` | 查看审批统计（含本周通过/拒绝） |

指令命名空间统一为 `/approval-*`，与爆米花机的 `/print-*` 等互不冲突。**对话链路遵循 qianli 架构铁律**（除工单接单监听外，所有对话逻辑由对话型机器人触发）：群内消息经 feishu-gateway 统一送至对话型机器人（爆米花机-对话型），由其把 `/approval-*` 转发到本服务 `POST http://localhost:3002/api/chat/command` 并代为回复；本服务的消息处理模块仅用于本地调试。

## 八、部署到 NAS

### 一键部署（push.js，密钥存 .env 的 NAS_*）
```bash
npm run push
```
git push（失败自动降级 SFTP 直传）→ NAS `/opt/approval-bot` 同步代码 → 单独上传 `.env` → `pm2 restart approval-bot`。

### 检查部署状态
```bash
ssh -p 8500 qianli@10.253.33.233 "pm2 logs approval-bot --lines 30"
```

## 九、项目结构

```
approval-bot/
├── src/
│   ├── cron/index.js              # 三个定时任务：财务催办周报 / 每日待审批提醒 / 催发票私聊
│   ├── feishu/
│   │   ├── bitable.js             # 多维表格 API（自动翻页）
│   │   ├── bot.js                 # 卡片构建（催办周报/每日提醒/催发票私聊文案）+ webhook/API 发送
│   │   ├── client.js              # 飞书 API 客户端（token 缓存）
│   │   └── eventSubscription.js   # 消息事件接入（长连接调试模式；生产走网关转发）
│   ├── services/
│   │   ├── approvalService.js     # 数据查询 + 财务催办三分支 + 超期未交发票 + 周统计按项目分组
│   │   ├── broadcastService.js    # 每周财务催办周报（支持 dryRun 预览）
│   │   ├── invoiceUrgeService.js  # 催发票私聊（按发起人分组，支持 dryRun 预览）
│   │   ├── reminderService.js     # 每日待审批提醒
│   │   └── chatService.js         # 群隔离 + /approval-* 指令
│   ├── utils/fields.js            # 多维表格字段值 → 展示文本
│   ├── config.js                  # 配置中心
│   └── index.js                   # 主入口（Express API + 事件接收）
├── scripts/inspect-bitable.js     # 多维表格结构/分布检查工具
├── scripts/dryrun-weekly.js       # 周报 dry-run 预览（不发送）
├── scripts/dryrun-invoice-urge.js # 催发票私聊 dry-run 预览（不发送）
├── feishu-permissions.json        # 飞书应用权限清单
├── push.js                        # 一键部署（git/SFTP + .env 上传）
└── package.json
```
