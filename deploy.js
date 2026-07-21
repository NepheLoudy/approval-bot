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
# 飞书应用凭证 - 必须是 approval-bot 独立应用的凭证，不要复用 knowledge-tracker 的
APP_ID=
APP_SECRET=
# 审批多维表格配置
BITABLE_APP_TOKEN=
BITABLE_APPROVAL_TABLE_ID=
# 飞书事件订阅配置（长连接模式，无需公网地址）
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
FEISHU_USE_LONG_CONNECTION=true
# 机器人配置 - 独立应用的群机器人 webhook
BOT_NAME=审批机器人
BOT_WEBHOOK_URL=
BOT_CHAT_ID=
# 审批者 open_id 列表（逗号分隔）
APPROVERS=
# 定时播报（cron表达式，默认每天18:00）
CRON_SCHEDULE=0 0 18 * * *
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
