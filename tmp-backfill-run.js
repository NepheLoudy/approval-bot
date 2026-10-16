// 一次性操作：生产跑全量回溯（limit 40）
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const cmd = `cd /c/qianli/opt/approval-bot && TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '\\r') && curl -s -m 300 -X POST http://localhost:3002/api/invoice/backfill -H "X-API-Token: $TOKEN" -H 'Content-Type: application/json' -d '{"limit":100,"sinceDays":60}'`;
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('exec 失败:', err.message); conn.end(); return; }
    let out = '';
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.stderr.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('close', () => {
      console.log(out.slice(0, 4000));
      conn.end();
    });
  });
});
conn.on('error', (e) => { console.error('SSH 连接失败:', e.message); process.exit(1); });
conn.connect({
  host: process.env.DEPLOY_HOST,
  port: Number(process.env.DEPLOY_PORT || 22),
  username: process.env.DEPLOY_USER,
  password: process.env.DEPLOY_PASSWORD,
  readyTimeout: 15000,
  keepaliveInterval: 5000,
});
