// 临时诊断：私聊发送失败证据 + 建联状态（用后即删）
const { Client } = require('ssh2');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const conn = new Client();
setTimeout(() => { console.error('!! 超时退出'); process.exit(2); }, 45000);

conn.on('ready', () => {
  const cmd = [
    `echo '===== [1] 催发票私聊失败记录（out 日志） ====='`,
    `grep -E '私聊.*失败' /home/qianli/.pm2/logs/approval-bot-out.log /home/qianli/.pm2/logs/approval-bot-error.log 2>/dev/null | tail -10`,
    `echo '(空 = 无失败记录)'`,
    `echo`,
    `echo '===== [2] 发送私聊相关报错（error 日志，含飞书错误码） ====='`,
    `grep -oE '发送私聊消息失败[^"]*|code: 230[0-9]+|code: 9999[0-9]+' /home/qianli/.pm2/logs/approval-bot-error.log 2>/dev/null | sort | uniq -c | sort -rn | head -10`,
    `echo`,
    `echo '===== [3] 催发票执行轨迹（最近 12 条） ====='`,
    `grep '催发票' /home/qianli/.pm2/logs/approval-bot-out.log 2>/dev/null | tail -12`,
    `echo`,
    `echo '===== [4] 建联用户状态（脱敏截断） ====='`,
    `if [ -f /home/qianli/approval-bot-data/urge-state.json ]; then python3 -c "import json;d=json.load(open('/home/qianli/approval-bot-data/urge-state.json'));u=d.get('users',{});print('已建联用户数:',len(u));print('users键示例:',list(u.keys())[:2]);r=d.get('records',{});print('records数:',len(r))" 2>/dev/null || head -c 400 /home/qianli/approval-bot-data/urge-state.json; else echo '(状态文件不存在——v21 后还没有真实执行过催私聊)'; fi`,
    `echo`,
    `echo '===== [5] hub / ticket-bot 私聊发送痕迹 ====='`,
    `grep -c 'sendTextToUser\\|私聊' /home/qianli/.pm2/logs/knowledge-tracker-out.log 2>/dev/null || echo 'knowledge-tracker-out.log 无私聊相关'`,
  ].join('; ');
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('exec 失败:', err.message); process.exit(1); }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
});
conn.on('error', (err) => { console.error('SSH 失败:', err.message); process.exit(1); });
conn.on('close', () => process.exit(0));

conn.connect({
  host: process.env.NAS_HOST,
  port: Number(process.env.NAS_PORT || 22),
  username: process.env.NAS_USER,
  password: process.env.NAS_PASSWORD,
});
