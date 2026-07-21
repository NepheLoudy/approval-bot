# approval-bot 审批机器人

财务助手机器人 - 基于飞书多维表格的审批流程自动化系统。

## ⚠️ 独立飞书应用

本项目作为**独立的飞书应用**运行，与 knowledge-tracker、bambu-print-server 是三个完全隔离的项目：

- 独立的 App ID / App Secret（飞书开放平台单独创建）
- 独立的群机器人 Webhook
- 独立的多维表格
- 独立的 PM2 进程（`approval-bot`）
- 独立的 NAS 部署目录（`/opt/approval-bot`）

**严禁复用其他项目的应用凭证**，否则会导致事件订阅冲突、消息互相串扰。

## 一、飞书开放平台配置

### 1. 创建应用
前往 https://open.feishu.cn 创建一个「自建应用」，记录以下信息：
- App ID（`cli_` 开头）
- App Secret

### 2. 开通权限
按 `feishu-permissions.json` 中列出的权限逐项开通：
- `bitable:app` — 多维表格读写
- `im:message` — 收发消息
- `im:message:send_as_bot` — 以机器人身份发消息
- `im:message.p2p_msg:readonly` — 读取私聊消息
- `im:chat` — 获取群组信息
- `contact:user.base:readonly` — 获取用户基本信息

### 3. 启用机器人能力
- 应用功能 → 机器人 → 启用
- 应用发布 → 版本管理 → 创建版本并发布
- 应用可见范围设置为「全部成员」或指定群组

### 4. 配置事件订阅
- 事件与回调 → 事件配置 → 选择「长连接」模式
- 订阅以下事件：
  - `im.message.receive_v1` — 接收消息
  - `bitable.record.changed` — 多维表格记录变更

### 5. 创建群机器人
在飞书群聊中添加「自定义机器人」，记录 Webhook URL（`https://open.feishu.cn/open-apis/bot/v2/hook/...`）。

## 二、本地开发

### 安装依赖
```bash
cd approval-bot
npm install
```

### 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 填入实际配置
```

### 启动服务
```bash
npm start          # 生产模式
npm run dev        # 开发模式（自动重启）
```

### 健康检查
```bash
curl http://localhost:3002/api/health
```

## 三、API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/approvals` | 获取所有审批记录 |
| GET | `/api/approvals/pending` | 获取待审批列表 |
| GET | `/api/approvals/:id` | 获取审批详情 |
| POST | `/api/bot/test-broadcast` | 立即触发一次播报（测试用） |
| GET | `/api/bot/cron-status` | 查询定时任务状态 |
| GET | `/api/bot/history` | 查询播报历史 |

## 四、机器人指令

在群聊中 @机器人 或私聊机器人发送指令：

| 指令 | 说明 |
|------|------|
| `/approval-help` | 显示帮助 |
| `/approval-list` | 查看所有审批 |
| `/approval-pending` | 查看待审批 |
| `/approval-status` | 查看审批统计 |

## 五、定时播报

默认每天 18:00 通过群机器人 Webhook 发送审批播报卡片，内容包括：
- 审批统计（总计/待审批/已通过/已驳回）
- 待审批列表（含 @发起人）

可通过 `CRON_SCHEDULE` 环境变量调整时间（cron 表达式）。

## 六、部署到 NAS

### 1. 创建 GitHub 仓库
在 GitHub 上创建 `approval-bot` 仓库，然后：
```bash
cd approval-bot
git init
git branch -M main
git remote add origin https://github.com/NepheLoudy/approval-bot.git
git add .
git commit -m "init: approval-bot"
git push -u origin main
```

### 2. 一键部署
```bash
npm run deploy
```
该命令会：
1. 自动 git commit & push 到 GitHub
2. SSH 连接 NAS（10.253.33.233:8500）
3. 在 NAS 上 git pull 最新代码
4. 写入 `.env`（**首次部署前需手动编辑 `deploy.js` 中的 .env 模板填入真实凭证**）
5. `npm install --production`
6. `pm2 restart approval-bot`
7. 开放 3002 端口

### 3. 检查部署状态
```bash
npm run deploy:check
```

## 七、项目结构

```
approval-bot/
├── src/
│   ├── cron/index.js              # 定时播报入口
│   ├── feishu/
│   │   ├── bitable.js             # 多维表格API
│   │   ├── bot.js                 # 机器人消息发送
│   │   ├── client.js              # 飞书API客户端
│   │   └── eventSubscription.js   # 事件订阅（长连接）
│   ├── services/
│   │   ├── approvalService.js     # 审批业务逻辑
│   │   ├── broadcastService.js    # 定时播报服务
│   │   └── chatService.js         # 聊天指令处理
│   ├── config.js                  # 配置中心
│   └── index.js                   # 主入口
├── feishu-permissions.json        # 飞书应用权限清单
├── feishu-permissions.txt         # 权限scope列表
├── .env.example                   # 环境变量示例
├── deploy.js                      # 一键部署脚本
├── deploy-local.js                # 部署检查脚本
└── package.json
```

## 八、多维表格字段约定

审批表（`BITABLE_APPROVAL_TABLE_ID`）需包含以下字段：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 申请编号 | 文本/自动编号 | 审批编号 |
| 申请状态 | 单选 | 待审批 / 已通过 / 已驳回 |
| 发起人 | 人员 | 申请发起人 |
| 发起时间 | 日期时间 | 申请时间 |
| 审批意见 | 文本 | 审批者填写的意见（可选） |
