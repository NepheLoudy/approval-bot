/**
 * 统一部署脚本：一条命令完成「代码进 Git + 配置进部署目标 + 部署」
 *
 * 用法：
 *   npm run push "提交说明"   提交并部署
 *   npm run push              使用默认提交说明 "update: 代码更新"
 *
 * 流程：
 *   [1/4] 代码提交推送到 GitHub（失败则标记，稍后改走 SFTP 直传）
 *   [2/4] 部署代码到部署目标（git push 成功走 git fetch，失败走 SFTP 打包直传）
 *   [3/4] 上传 .env 到部署目标（含飞书密钥，只单独进部署目标，绝不进 git）
 *   [4/4] npm install + 重启服务
 *
 * 部署目标连接配置从 .env 读取（DEPLOY_HOST/DEPLOY_PORT/DEPLOY_USER/DEPLOY_PASSWORD），脚本不存任何密钥。
 */
const { spawnSync } = require('child_process');
const { Client } = require('ssh2');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
// ---------- [0] 部署前测试闸门（2026-09-13 R4）：测试不过不部署；SKIP_TESTS=1 可跳过 ----------
function runTestGate() {
  if (process.env.SKIP_TESTS === '1') {
    console.log('SKIP_TESTS=1，跳过部署前测试');
    return true;
  }
  const { spawnSync } = require('child_process');
  const cmd = 'node --check src/index.js && node --check src/services/chatService.js && node --check src/services/ocrService.js && node --check src/services/invoiceParser.js && node --check src/services/invoiceCollectService.js && node --check src/services/batchService.js && node --check src/services/backfillService.js && node scripts/test-invoice-urge.js && node scripts/stub-test-ocr.js && node scripts/stub-test-invoice-collect.js';
  if (!cmd) { console.log('[测试闸门] 无测试命令，跳过'); return true; }
  console.log('[测试闸门] 运行:', cmd);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: __dirname });
  if (r.status !== 0) {
    console.error('部署前测试未通过（SKIP_TESTS=1 可跳过），中止部署');
    return false;
  }
  console.log('[测试闸门] 通过');
  return true;
}
if (!runTestGate()) process.exit(1);

const commitMessage = process.argv[2] || 'update: 代码更新';
const TAR_NAME = 'approval-bot-deploy.tar.gz';
// 打包时用相对文件名 + cwd 指向临时目录，避免 Windows GNU tar 把 "C:" 当远程主机
const TAR_LOCAL = path.join(os.tmpdir(), TAR_NAME);
const TAR_REMOTE = '/c/qianli/' + TAR_NAME;   // bash 路径（小电脑 git-bash）
const TAR_REMOTE_WIN = 'C:/qianli/' + TAR_NAME; // SFTP 用 Windows 路径
const REMOTE_DIR = '/c/qianli/opt/approval-bot';      // bash 路径
const REMOTE_DIR_WIN = 'C:/qianli/opt/approval-bot';  // SFTP 用 Windows 路径
const GIT_REMOTE = 'https://github.com/NepheLoudy/approval-bot.git';
const PM2_NAME = 'approval-bot';

const deployConfig = {
  host: process.env.DEPLOY_HOST,
  port: Number(process.env.DEPLOY_PORT || 22),
  username: process.env.DEPLOY_USER,
  password: process.env.DEPLOY_PASSWORD,
};
if (!deployConfig.host || !deployConfig.password) {
  console.error('缺少部署配置：请在 .env 中配置 DEPLOY_HOST/DEPLOY_PORT/DEPLOY_USER/DEPLOY_PASSWORD');
  process.exit(1);
}

// ============ [1/4] 代码提交推送到 GitHub ============
console.log('========== [1/4] 代码提交推送到 GitHub ==========');

const add = spawnSync('git', ['add', '-A'], { stdio: 'inherit' });
if (add.status !== 0) {
  console.error('git add 失败');
  process.exit(1);
}

const hasChanges = spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0;
if (hasChanges) {
  const commit = spawnSync('git', ['commit', '-m', commitMessage], { stdio: 'inherit' });
  if (commit.status !== 0) {
    console.error('git commit 失败');
    process.exit(1);
  }
} else {
  console.log('(无待提交改动，跳过 commit)');
}

const push = spawnSync('git', ['push'], { stdio: 'inherit' });
const gitPushed = push.status === 0;
if (gitPushed) {
  console.log('✓ git push 成功，部署目标将通过 git fetch 拉取代码');
} else {
  console.log('⚠ git push 失败（本地无法访问 GitHub 443），改用 SFTP 直传代码到部署目标');
}

// =* 连接部署目标 =*
console.log('\n========== [2/4] 连接 小电脑 部署代码 ==========');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH 连接成功');
  deployCode().catch((err) => { console.error('部署失败:', err.message); conn.end(); process.exit(1); });
});

// 执行命令并返回退出码（不中断流程，便于降级处理）
function execCode(cmd) {
  return new Promise((resolve) => {
    console.log('>', cmd);
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error('执行失败:', err.message); resolve(-1); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
      stream.on('close', (code) => resolve(code));
    });
  });
}

conn.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

// 执行单条命令（成功回调 cb）
function exec(cmd, cb) {
  console.log('>', cmd);
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('执行失败:', err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`命令失败 (退出码 ${code})`);
        conn.end();
        process.exit(code);
      }
      cb();
    });
  });
}

// 部署代码（git 或 SFTP 两种方式）
async function deployCode() {
  if (gitPushed) {
    const cmd = 'cd ' + REMOTE_DIR + ' && '
      + 'if [ ! -d .git ]; then git init; fi; '
      + 'git remote set-url origin ' + GIT_REMOTE + ' 2>/dev/null || git remote add origin ' + GIT_REMOTE + '; '
      + 'git fetch origin main && git reset --hard origin/main';
    const code = await execCode(cmd);
    if (code === 0) return npmInstall();
    console.log('⚠ 部署目标拉取 GitHub 失败（目标机网络不通），改用 SFTP 直传代码');
  }
  {
    console.log('本地打包代码...');
    const pack = spawnSync('tar', [
      '-czf', TAR_NAME,
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=.env',
      // 本地私有环境覆盖（.env 上传单独走 SFTP，2026-09-27 补洞）
      '--exclude=.env.local',
      '--exclude=.env.*.local',
      '--exclude=logs',
      '--exclude=*.log',
      '--exclude=.ocr-fields.local.json',
      '--exclude=.drill/', // 本地演练残留（drill-online.js 产物）不进部署包
      '--exclude=' + TAR_NAME,
      '-C', __dirname,
      '.',
    ], { stdio: 'inherit', cwd: os.tmpdir() });
    if (pack.status !== 0) {
      console.error('打包失败');
      conn.end();
      process.exit(1);
    }

    conn.sftp((err, sftp) => {
      if (err) {
        console.error('SFTP 失败:', err.message);
        conn.end();
        process.exit(1);
      }
      console.log('上传代码包到 小电脑...');
      sftp.fastPut(TAR_LOCAL, TAR_REMOTE_WIN, (err2) => {
        if (err2) {
          console.error('代码上传失败:', err2.message);
          conn.end();
          process.exit(1);
        }
        console.log('✓ 代码包已上传');
        const cmd = 'rm -rf ' + REMOTE_DIR + '/.git ' + REMOTE_DIR + '/* ' + REMOTE_DIR + '/.[!.]* 2>/dev/null || true; '
          + 'tar -xzf ' + TAR_REMOTE + ' -C ' + REMOTE_DIR;
        exec(cmd, () => npmInstall());
      });
    });
  }
}

// npm install
function npmInstall() {
  console.log('\n安装依赖...');
  exec('export PATH=/c/tools/node-v22.10.0-win-x64:$PATH; cd ' + REMOTE_DIR + ' && npm install --omit=dev', () => uploadEnv());
}

// ============ [3/4] 上传 .env ============
function uploadEnv() {
  console.log('\n========== [3/4] 上传 .env 到部署目标 ==========');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP 失败:', err.message);
      conn.end();
      process.exit(1);
    }
    sftp.fastPut(path.join(__dirname, '.env'), REMOTE_DIR_WIN + '/.env', (err2) => {
      if (err2) {
        console.error('.env 上传失败:', err2.message);
        conn.end();
        process.exit(1);
      }
      console.log('✓ .env 已上传到 小电脑（含飞书密钥）');
      restart();
    });
  });
}

// ============ [4/4] 重启服务 ============
const HEALTH_PORT = process.env.PORT || '3002';

function restart() {
  console.log('\n========== [4/4] 重启服务 ==========');
  // --time：pm2 日志加时间戳前缀（2026-09-30 曼波定——排查「群里发了什么」需要时间线）
  const cmd = 'pm2 restart ' + PM2_NAME + ' --time --update-env 2>/dev/null || pm2 start ' + REMOTE_DIR + '/src/index.js --name ' + PM2_NAME + ' --time; pm2 save';
  exec(cmd, () => healthCheck(0));
}

// 部署后健康检查（2026-10-04）：重启后轮询 /api/health，防止「部署成功但进程起不来」
// 的静默故障——09-29~10-03 目标机 node_modules 半残（qrcode 缺失）导致进程 crash
// 循环、定时任务全灭，当时无任何部署期告警。6 次重试仍不就绪即判部署失败。
function healthCheck(attempt) {
  const MAX_ATTEMPTS = 6;
  console.log(`健康检查 (${attempt + 1}/${MAX_ATTEMPTS}): localhost:${HEALTH_PORT}/api/health`);
  conn.exec(`sleep 3; curl -s -m 3 localhost:${HEALTH_PORT}/api/health`, (err, stream) => {
    if (err) { console.error('健康检查执行失败:', err.message); conn.end(); process.exit(1); }
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    stream.on('close', () => {
      if (out.includes('"status":"ok"')) {
        console.log('✅ 健康检查通过:', out.trim().slice(0, 160));
        showStatus();
        return;
      }
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(`❌ 部署后健康检查失败（${MAX_ATTEMPTS} 次未就绪）——进程可能 crash 循环（依赖缺失/启动异常）。`);
        console.error('   排查：ssh 上机后 pm2 logs ' + PM2_NAME + ' --err --lines 50；不要让机器人带病运行。');
        conn.end();
        process.exit(1);
      }
      healthCheck(attempt + 1);
    });
  });
}

function showStatus() {
  console.log('\n✅ 部署完成，服务状态：');
  conn.exec('pm2 list', (err, stream) => {
    if (err) { conn.end(); return; }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}

console.log('正在连接部署目标...');
conn.connect(deployConfig);
