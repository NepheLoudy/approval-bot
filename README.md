# approval-bot 审批机器人

采购/发票审批播报机器人 —— 监听飞书多维表格「采购申请/发票提交」审批表的记录变更，自动向审批群推送新申请提醒、审批结果、每日待审批提醒和每周审批统计。

## 一、架构说明：共用飞书应用 + 群聊隔离

本项目**与所有 qianli 项目共用同一个飞书应用**（`APP_ID` 相同），但功能上做了两层隔离：

### 1. 群聊隔离
- 本项目**仅服务审批群**（`BOT_CHAT_ID = oc_1ea53731a8772400450da6ab107f8331`）
- 指令与对话触发只在该群生效，且必须 @机器人（共用应用机器人的实际名称为 **爆米花机_财务型**，`BOT_NAME` 与之保持一致用于 @识别；`/approval-*` 前缀指令即使漏检 @ 也会触发）
- 其他群的消息、私聊消息一律跳过（留给爆米花机 project-management-robot 的正常对话能力），不回复、不记录
- 自动播报通过审批群的**自定义机器人 Webhook**（`BOT_WEBHOOK_URL`）推送

### 2. 事件竞争与轮询对账（重要）
飞书对同一应用的多个长连接（本项目 / 爆米花机 / ticket-bot）是**随机分发**事件——每条事件只会投递给其中一条连接。因此：

- 多维表格播报**不直接消费事件体**，统一走「拉取记录 → 与内存快照 diff → 按迁移分支播报」
- 事件到达时只作为**快速触发器**（立即回查对应记录）
- 定时**对账轮询**（`BITABLE_POLL_MINUTES`，默认 5 分钟）兜底补漏，事件被其他项目抢走也不会漏播
- 事件订阅还必须先调用「订阅云文档」接口（启动时自动调用，见 `eventSubscription.js`）

首次启动的第一次对账只建快照、不播报（避免重启重放历史记录）。

## 二、飞书应用配置（共用应用，仅需补充权限/事件）

1. **权限**（见 `feishu-permissions.json`）：`bitable:app`、`im:message`、`im:message:send_as_bot`、`im:chat`、`contact:user.base:readonly`、云文档订阅相关权限
2. **事件订阅**：长连接模式，订阅 `im.message.receive_v1` 和 `drive.file.bitable_record_changed_v1`
3. **审批群自定义机器人**：Webhook `https://open.feishu.cn/open-apis/bot/v2/hook/d91361fc-b824-4a15-a8a3-a85b4344afba`

## 三、多维表格字段约定

审批表（`BITABLE_APPROVAL_TABLE_ID = tblwwBsMZDdP1iSN`）关键字段：

| 字段名 | 类型 | 用途 |
|--------|------|------|
| 申请编号 | Url/文本 | 审批编号，卡片主键展示 |
| 申请状态 | 单选 | **播报分支的判断依据**（取值见下） |
| 审批流程 | 单选 | 流程过滤：只有活跃流程才播报 |
| 发起人 | 人员 | 卡片 @ 提及对象 |
| 发起人部门 | 文本 | 新申请卡片展示 |
| 当前处理人 | 人员 | 每日提醒 @ 对象（为空回落配置的审批人） |
| 审批节点 | 文本 | 新申请卡片展示 |
| 购买物资名称 | 文本 | 卡片展示 |
| 总金额 / 总金额-币种 | 数量/单选 | 卡片展示 |
| 项目 / 付款人 | 单选 | 新申请卡片展示 |
| 发起时间 / 完成时间 | 日期 | 卡片展示、本周新增统计 |

**「申请状态」实际取值与播报策略：**

| 取值 | 播报策略 |
|------|----------|
| 审批中 | 新申请卡片（记录首次出现时） |
| 已通过 | ✅ 结果卡片（green） |
| 已拒绝 | ❌ 结果卡片（red） |
| 已撤回 / 已取消 / 已终止 / 已删除 | 静默（仅更新快照，不打扰群） |

**「审批流程」过滤**：表中混有历史/测试流程（如「发票（测试不要提交)」），`APPROVAL_PROCESS_NAMES` 配置当前活跃流程 `💸【27赛季】千里采购申请/发票提交`，非活跃流程的记录一律静默。

## 四、判断分支与播报逻辑总览

```
记录新增（快照中不存在）
├─ 审批流程 ∉ 活跃流程列表        → 跳过（历史/测试流程静默）
├─ 状态 = 审批中                  → 📋 新申请卡片（@发起人）
├─ 状态 ∈ {已通过, 已拒绝}        → ✅/❌ 结果卡片（兜底：漏看创建/秒批）
└─ 状态 ∈ 撤回/取消/终止/删除     → 静默

状态变更（prev ≠ next）
├─ → 已通过                       → ✅ 结果卡片（@发起人）
├─ → 已拒绝                       → ❌ 结果卡片（@发起人）
├─ → 撤回/取消/终止/删除          → 静默
└─ → 审批中 / 其他中间态          → 静默（创建时已播报）

定时任务（Asia/Shanghai）
├─ 每周一 18:00（CRON_SCHEDULE）
│    📊 周播报：状态统计（含本周新增）+ 审批中列表（@当前处理人）
├─ 每天 09:00（DAILY_INVOICE_REMINDER_SCHEDULE）
│    ⏰ 待审批提醒：有「审批中」记录才发送，@当前处理人（空则 @ 配置审批人）
└─ 每 5 分钟（BITABLE_POLL_MINUTES）
     🔁 对账轮询：事件分发竞争的兜底播报通道
```

同一条记录的播报由**快照状态机**天然去重：重复事件、同一状态的多次编辑都不会重复推送。

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
| POST | `/api/bot/sync` | 立即执行一次全量对账 |
| GET | `/api/bot/cron-status` | 定时任务状态 + 对账快照状态 |
| GET | `/api/bot/history` | 播报历史 |
| POST | `/api/chat/command` | 指令转发端点（`{command, args}` → `{reply}`） |

## 七、机器人指令（仅审批群，需 @爆米花机_财务型）

| 指令 | 说明 |
|------|------|
| `/approval-help` | 显示帮助 |
| `/approval-list` | 查看所有申请（审批中在前） |
| `/approval-pending` | 查看审批中列表 |
| `/approval-status` | 查看审批统计 |
| `/approval-sync` | 立即对账一次（排查漏播报） |

指令命名空间统一为 `/approval-*`，与爆米花机的 `/print-*` 等互不冲突。由于共用应用长连接的事件随机分发，指令消息**可能不会到达本服务**；此时可在爆米花机的 chatService 中把 `/approval-*` 指令转发到 `POST http://localhost:3002/api/chat/command`（bambu 打印服务同款转发契约）。

## 八、部署到 NAS

### 一键部署（推荐）
```bash
npm run deploy
```
该命令会：git commit & push → SSH 连接 NAS（10.253.33.233:8500）→ `/opt/approval-bot` 拉取最新代码 → 写入 `.env`（凭证已内置在 `deploy.js`）→ `npm install --production` → `pm2 restart approval-bot` → 开放 3002 端口。

### GitHub Actions 自动部署
push 到 main 后 `deploy.yml` 会通过 SSH 自动部署，相关密钥配置在仓库 Secrets（`APP_ID`、`APP_SECRET`、`BOT_CHAT_ID`、`BOT_WEBHOOK_URL` 等）。

### 检查部署状态
```bash
npm run deploy:check
ssh -p 8500 qianli@10.253.33.233 "pm2 logs approval-bot --lines 30"
```

## 九、项目结构

```
approval-bot/
├── src/
│   ├── cron/index.js              # 三个定时任务：周播报 / 每日提醒 / 对账轮询
│   ├── feishu/
│   │   ├── bitable.js             # 多维表格 API（自动翻页）
│   │   ├── bot.js                 # 卡片构建 + webhook/API 发送
│   │   ├── client.js              # 飞书 API 客户端（token 缓存）
│   │   └── eventSubscription.js   # 长连接事件订阅（含云文档订阅）
│   ├── services/
│   │   ├── approvalService.js     # 播报引擎：快照对账 + 状态迁移分支
│   │   ├── broadcastService.js    # 每周统计播报
│   │   ├── reminderService.js     # 每日待审批提醒
│   │   └── chatService.js         # 群隔离 + /approval-* 指令
│   ├── config.js                  # 配置中心
│   └── index.js                   # 主入口（Express API）
├── scripts/inspect-bitable.js     # 多维表格结构/分布检查工具
├── feishu-permissions.json        # 飞书应用权限清单
├── deploy.js                      # 一键部署脚本（.env 模板已内置凭证）
└── package.json
```
