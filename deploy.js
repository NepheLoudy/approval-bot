const { Client } = require('ssh2');
const { execSync } = require('child_process');

const config = {
  host: '10.253.33.233',
  port: 8500,
  username: 'qianli',
  password: 'cquqianli2026'
};

function runGitCommands() {
  console.log('\n=== 步骤1: 提交代码到 GitHub ===');

  try {
    console.log('检查 git 状态...');
    const status = execSync('git status --porcelain').toString().trim();
    if (!status) {
      console.log('❌ 没有需要提交的更改');
      return false;
    }

    console.log('添加所有文件...');
    execSync('git add -A');

    console.log('提交更改...');
    execSync('git commit -m "chore: 自动部署更新"');

    console.log('推送代码到 GitHub...');
    execSync('git push origin main');

    console.log('✅ 代码已推送到 GitHub');
    return true;
  } catch (err) {
    console.error('❌ Git 操作失败:', err.message);
    return false;
  }
}

const commands = [
  { cmd: 'mkdir -p /opt/approval-bot', sudo: true },
  { cmd: 'chown -R qianli:qianli /opt/approval-bot', sudo: true },
  { cmd: 'cd /opt/approval-bot && if [ -d .git ]; then git fetch origin main && git reset --hard origin/main; else git init && git remote add origin https://github.com/NepheLoudy/approval-bot.git && git fetch origin main && git reset --hard origin/main; fi', sudo: false },
  { cmd: 'cd /opt/approval-bot && npm install --production', sudo: false },
  { cmd: `cat > /opt/approval-bot/.env << 'ENVEOF'
PORT=3002
# 飞书应用配置（与所有 qianli 项目共用同一个应用）
APP_ID=cli_aac7e6f6cdf8dcc0
APP_SECRET=Z11s3UBWL2pivBCcc1zJnfJInKWmaYjN
# 审批多维表格（采购申请/发票提交）
BITABLE_APP_TOKEN=XrEjbPZn5aFcArsh03mc9QyCnlH
BITABLE_APPROVAL_TABLE_ID=tblwwBsMZDdP1iSN
# 飞书事件订阅配置（长连接模式，无需公网地址）
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
FEISHU_USE_LONG_CONNECTION=true
# 机器人配置：自动播报 webhook + 唯一服务的目标群
BOT_NAME=爆米花机_财务型
BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/d91361fc-b824-4a15-a8a3-a85b4344afba
BOT_CHAT_ID=oc_1ea53731a8772400450da6ab107f8331
# 活跃审批流程过滤（只播报该流程的记录）
APPROVAL_PROCESS_NAMES=💸【27赛季】千里采购申请/发票提交
# 对账轮询间隔（分钟）：共用应用长连接事件随机分发的兜底通道
BITABLE_POLL_MINUTES=5
# 审批者 open_id 列表（逗号分隔，提醒回落用）
APPROVERS=
# 每周播报（每周一 18:00）
CRON_SCHEDULE=0 0 18 * * 1
# 每日待审批提醒（每天 09:00）
DAILY_INVOICE_REMINDER_SCHEDULE=0 0 9 * * *
# 提醒 @ 目标（留空则回落到下面两位审批人）
DAILY_REMINDER_MENTION_IDS=
HE_YUNJIE_OPEN_ID=ou_54493ce1595583e02084309b3e81f6c7
ZHANG_GUOHAO_OPEN_ID=ou_249993fe55916ccf549719ff6bf6f12d
ENVEOF`, sudo: false },
  { cmd: 'pm2 delete approval-bot 2>/dev/null || true', sudo: false },
  { cmd: 'pm2 start /opt/approval-bot/src/index.js --name approval-bot', sudo: false },
  { cmd: 'pm2 save', sudo: false },
  { cmd: 'ufw allow 3002/tcp', sudo: true }
];

function deployToNAS() {
  const conn = new Client();

  conn.on('ready', () => {
    console.log('\nSSH连接成功！');
    executeNextCommand(conn, 0);
  });

  conn.on('error', (err) => {
    console.error('SSH连接失败:', err.message);
    process.exit(1);
  });

  conn.on('end', () => {
    console.log('SSH连接已关闭');
  });

  console.log('\n=== 步骤2: 部署到 NAS ===');
  console.log('正在连接到 NAS...');
  conn.connect(config);
}

function executeNextCommand(conn, index) {
  if (index >= commands.length) {
    console.log('\n✅ 所有命令执行完成！');
    conn.end();
    return;
  }

  const { cmd, sudo } = commands[index];
  const displayCmd = cmd.substring(0, 60) + (cmd.length > 60 ? '...' : '');
  console.log(`\n[${index + 1}/${commands.length}] 执行${sudo ? '(sudo)' : ''}: ${displayCmd}`);

  const execCmd = sudo ? `echo "cquqianli2026" | sudo -S ${cmd}` : cmd;

  conn.exec(execCmd, (err, stream) => {
    if (err) {
      console.error('命令执行失败:', err.message);
      conn.end();
      return;
    }

    stream.on('data', (data) => {
      const output = data.toString().trim();
      if (output && !output.includes('[sudo] password') && !output.includes('cquqianli2026')) {
        console.log(output);
      }
    });

    stream.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (error && !error.includes('[sudo] password') && !error.includes('cquqianli2026')) {
        console.error('错误:', error);
      }
    });

    stream.on('close', (code) => {
      if (code === 0) {
        console.log(`命令执行成功 (退出码: ${code})`);
        executeNextCommand(conn, index + 1);
      } else {
        console.error(`命令执行失败 (退出码: ${code})`);
        conn.end();
      }
    });
  });
}

async function main() {
  const hasChanges = runGitCommands();

  if (!hasChanges) {
    console.log('\n=== 跳过部署 ===');
    process.exit(0);
  }

  deployToNAS();
}

main();
