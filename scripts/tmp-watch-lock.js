// 临时后台脚本：轮询生产日志直到金额线锁定或超时（用完即删）
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const DEADLINE = Date.now() + 35 * 60 * 1000; // 最多盯 35 分钟
let seen = '';

function tail() {
  return new Promise((res) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(`grep -hE "制单金额线|回溯|锁定前|自动锁定|补采" ~/.pm2/logs/approval-bot-out.log ~/.pm2/logs/approval-bot-error.log 2>/dev/null | tail -10`, (err, stream) => {
        let out = '';
        stream.on('close', () => { res(out); try { conn.end(); } catch {} });
        stream.on('data', d => { out += d; });
        stream.stderr.on('data', () => {});
      });
    }).on('error', () => res('')).connect({ host: '192.168.31.57', port: 22, username: 'mechax', password: env.DEPLOY_PASSWORD, readyTimeout: 15000 });
  });
}

(async () => {
  while (Date.now() < DEADLINE) {
    const out = await tail();
    const lines = out.trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1] || '';
    if (last !== seen) {
      seen = last;
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + lines.slice(-3).join('\n'));
    }
    // 终局判定：锁定成功 或 新一轮失败跳过（且非上轮已见）
    if (/自动锁定（/.test(out) && /郭禹澄|宣运物资/.test(out)) {
      console.log('🎉 终局：已自动锁定并发详情卡');
      process.exit(0);
    }
    if ((out.match(/跳过锁定（下轮重试）/g) || []).length >= 4) {
      console.log('⏹ 多轮失败跳过，停止轮询（每轮进度已入库，明日 10:35 兜底继续收敛）');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 3 * 60 * 1000));
  }
  console.log('⏱ 35 分钟盯梢超时，退出');
})();
