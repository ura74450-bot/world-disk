const express = require('express'), http = require('http'), path = require('path');
const { Readable } = require('stream'), { once } = require('events');
const { WebSocketServer } = require('ws');
const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main', FILES_DIR = 'files' } = process.env;
const app = express(), server = http.createServer(app);
const GH = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/`;
const H = (x = {}) => ({ Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'vsemirny-disk', 'X-GitHub-Api-Version': '2022-11-28', ...x });
const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf' };
const ext = n => (n.split('.').pop() || '').toLowerCase();
const show = n => n.replace(/^\d+-/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.use(express.static(path.join(__dirname, 'public')));

// Большие файлы хранятся кусками: имя.part0000, имя.part0001 ... Список склеивает их в один файл.
async function listRaw() {
  const r = await fetch(`${GH}${FILES_DIR}?ref=${GITHUB_BRANCH}`, { headers: H() });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return (await r.json()).filter(i => i.type === 'file' && i.name !== '.gitkeep');
}
function group(items) {
  const m = new Map();
  for (const i of items) {
    const p = i.name.match(/^(.+)\.part\d{4}$/), id = p ? p[1] : i.name;
    const g = m.get(id) || { id, size: 0, parts: [] };
    g.size += i.size; g.parts.push(i.name); m.set(id, g);
  }
  return [...m.values()].map(g => ({ ...g, parts: g.parts.sort() }));
}

// Очередь: GitHub не любит параллельные коммиты в одну ветку
let q = Promise.resolve();
const put = (p, buf) => {
  const run = q.then(async () => {
    for (let a = 0; ; a++) {
      const r = await fetch(GH + FILES_DIR + '/' + encodeURIComponent(p), {
        method: 'PUT', headers: H({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: 'upload ' + p, content: buf.toString('base64'), branch: GITHUB_BRANCH })
      });
      if (r.ok) return;
      if (a < 4 && [403, 409, 429].includes(r.status) || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
      throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 200));
    }
  });
  q = run.catch(() => {});
  return run;
};

app.get('/api/files', async (req, res) => {
  try {
    const list = group(await listRaw()).map(g => ({ id: g.id, name: show(g.id), size: g.size, time: +(g.id.match(/^\d+/) || [0])[0] }));
    res.json(list.sort((a, b) => b.time - a.time));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chunk', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const { name = 'file', ts, i = 0, n = 1, size = 0, by = 'Аноним' } = req.query;
    if (!/^\d{10,15}$/.test(ts || '')) return res.status(400).json({ error: 'bad ts' });
    const safe = decodeURIComponent(name).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, 120) || 'file';
    const id = ts + '-' + safe, idx = +i, total = +n;
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
    await put(total > 1 ? `${id}.part${String(idx).padStart(4, '0')}` : id, req.body);
    if (idx === total - 1) {
      const file = { id, name: safe, size: +size || req.body.length, time: +ts };
      broadcast({ type: 'file', file });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/f/:id', async (req, res) => {
  try {
    const id = req.params.id, mime = MIME[ext(id)];
    const g = group(await listRaw()).find(x => x.id === id);
    if (!g) return res.status(404).send('Файл не найден');
    res.set({
      'Content-Type': mime || 'application/octet-stream', 'Content-Length': g.size,
      'Content-Disposition': (mime && !req.query.dl ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(show(id)),
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups'
    });
    for (const p of g.parts) {
      const r = await fetch(`${GH}${FILES_DIR}/${encodeURIComponent(p)}?ref=${GITHUB_BRANCH}`, { headers: H({ Accept: 'application/vnd.github.raw+json' }) });
      if (!r.ok) throw new Error('GitHub ' + r.status);
      for await (const c of Readable.fromWeb(r.body)) { if (!res.write(c)) await Promise.race([once(res, 'drain'), once(res, 'close')]); if (res.destroyed) return; }
    }
    res.end();
  } catch (e) { res.headersSent ? res.destroy() : res.status(500).send(e.message); }
});

const wss = new WebSocketServer({ server, path: '/ws' });
const chat = [];
function broadcast(m) { const s = JSON.stringify(m); wss.clients.forEach(c => c.readyState === 1 && c.send(s)); }
const online = () => broadcast({ type: 'online', n: wss.clients.size });
wss.on('connection', ws => {
  ws.alive = true; ws.last = 0;
  ws.on('pong', () => ws.alive = true);
  ws.send(JSON.stringify({ type: 'init', chat }));
  online();
  ws.on('message', d => {
    try {
      const m = JSON.parse(d), now = Date.now();
      if (m.type !== 'chat' || now - ws.last < 400) return;
      ws.last = now;
      const msg = { type: 'chat', cid: String(m.cid || '').slice(0, 20), text: String(m.text || '').slice(0, 500), time: now };
      if (!msg.text.trim()) return;
      chat.push(msg); if (chat.length > 100) chat.shift();
      broadcast(msg);
    } catch {}
  });
  ws.on('close', online);
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('Всемирный диск запущен'));
