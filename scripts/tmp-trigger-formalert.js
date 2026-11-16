// 临时触发脚本：生产触发金额线检查（test-form-alert 端点，含鉴权；用完即删）
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
  const cmd = `cd /c/qianli/opt/approval-bot && TOKEN=$(grep "^API_TOKEN=" .env | cut -d= -f2) && curl -s -X POST http://127.0.0.1:3002/api/bot/test-form-alert -H "X-API-Token: $TOKEN" -H "Content-Type: application/json" -d '{}' --max-time 560 && echo '' && echo '--- 最近日志 ---' && tail -25 ~/.pm2/logs/approval-bot-out.log | grep -E "制单金额线|收支|锁定|补采" | tail -15`;
  conn.exec(cmd, (err, stream) => {
    let out = '', errOut = '';
    stream.on('close', (code) => {
      console.log('== 触发返回 ==');
      console.log(out.trim() || '(空响应)');
      if (errOut.trim()) console.log('[stderr]', errOut.trim().slice(0, 300));
      console.log('exit=' + code);
      conn.end();
    });
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', d => { errOut += d; });
  });
}).on('error', (e) => { console.error('SSH 连接失败:', e.message); process.exit(1); }).connect({
  host: '192.168.31.57', port: 22, username: 'mechax',
  password: env.DEPLOY_PASSWORD, readyTimeout: 15000,
});
