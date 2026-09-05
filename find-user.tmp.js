// 临时：从 NAS 审批数据中提取杨彬意的 open_id（用后即删）
const { Client } = require('ssh2');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const conn = new Client();
setTimeout(() => { console.error('!! 超时'); process.exit(2); }, 40000);
conn.on('ready', () => {
  const cmd = `curl -s --max-time 10 http://localhost:3002/api/approvals > /tmp/apprs.json; node -e "
    const d = JSON.parse(require('fs').readFileSync('/tmp/apprs.json','utf8'));
    const list = Array.isArray(d) ? d : (d.approvals || []);
    const hits = [];
    for (const r of list) {
      const f = r.fields || {};
      const owner = f['发起人'];
      const arr = Array.isArray(owner) ? owner : (owner ? [owner] : []);
      for (const u of arr) {
        const name = (u && (u.name || u.text)) || '';
        const id = (u && (u.id || u.open_id)) || '';
        if (String(name).includes('杨彬意')) hits.push({ record: r.record_id, name, id });
      }
    }
    console.log('records total:', list.length);
    console.log('hits:', JSON.stringify(hits, null, 1).slice(0, 600));
  "`;
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('exec 失败:', err.message); process.exit(1); }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
});
conn.on('error', (e) => { console.error('SSH 失败:', e.message); process.exit(1); });
conn.on('close', () => process.exit(0));
conn.connect({ host: process.env.NAS_HOST, port: Number(process.env.NAS_PORT || 22), username: process.env.NAS_USER, password: process.env.NAS_PASSWORD });
