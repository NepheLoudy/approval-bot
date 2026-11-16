// 临时只读脚本：tail 生产日志看金额线触发结果（用完即删）
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const conn = new Client();
conn.on('ready', () => {
  const cmd = `grep -hE "制单金额线|锁定|补采|回溯" ~/.pm2/logs/approval-bot-out.log ~/.pm2/logs/approval-bot-error.log 2>/dev/null | tail -30`;
  conn.exec(cmd, (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log(out.trim() || '(无相关日志)');
      conn.end();
    });
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', () => {});
  });
}).on('error', (e) => { console.error('SSH 连接失败:', e.message); process.exit(1); }).connect({
  host: '192.168.31.57', port: 22, username: 'mechax',
  password: env.DEPLOY_PASSWORD, readyTimeout: 15000,
});
