const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream'), { once } = require('events');
const { WebSocketServer } = require('ws');
const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main', FILES_DIR = 'files' } = process.env;
const ADMIN_KEY = process.env.ADMIN_KEY;
const app = express(), server = http.createServer(app);
const REPO = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/`, GH = REPO + 'contents/';
const H = (x = {}) => ({ Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'vsemirny-disk', 'X-GitHub-Api-Version': '2022-11-28', ...x });
const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf' };
const ext = n => (n.split('.').pop() || '').toLowerCase();
const show = n => n.replace(/^\d+-/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const clean = s => { const t = String(s || '').replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, 120).trim(); return /^\.*$/.test(t) ? '_' : t; };
const okKey = k => /^[a-f0-9]{32}$/.test(k || '');
const dirOf = k => `private/${crypto.createHash('sha256').update(k).digest('hex').slice(0, 40)}/`;

app.use(express.static(path.join(__dirname, 'public')));

// Большие файлы хранятся кусками: имя.part0000, имя.part0001 ... и склеиваются при открытии.
function group(items) {
  const m = new Map();
  for (const i of items) {
    const p = i.name.match(/^(.+)\.part\d{4}$/), id = p ? p[1] : i.name;
    const g = m.get(id) || { id, size: 0, parts: [], shas: {} };
    g.size += i.size; g.parts.push(i.name); g.shas[i.name] = i.sha; m.set(id, g);
  }
  return [...m.values()].map(g => ({ ...g, parts: g.parts.sort() }));
}
async function listRaw() {
  const r = await fetch(`${GH}${FILES_DIR}?ref=${GITHUB_BRANCH}`, { headers: H() });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return (await r.json()).filter(i => i.type === 'file' && i.name !== '.gitkeep').map(i => ({ name: i.name, size: i.size, sha: i.sha }));
}
async function tree(prefix) {
  const r = await fetch(`${REPO}git/trees/${GITHUB_BRANCH}?recursive=1`, { headers: H() });
  if (r.status === 404 || r.status === 409) return [];
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return (await r.json()).tree.filter(i => i.type === 'blob' && i.path.startsWith(prefix)).map(i => ({ name: i.path.slice(prefix.length), size: i.size, sha: i.sha }));
}

// Очередь: GitHub не любит параллельные коммиты в одну ветку
let q = Promise.resolve();
const gh = (method, p, body) => {
  const run = q.then(async () => {
    for (let a = 0; ; a++) {
      const r = await fetch(GH + enc(p), { method, headers: H({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ...body, branch: GITHUB_BRANCH }) });
      if (r.ok || (method === 'DELETE' && r.status === 404)) return;
      if (r.status === 422 && method === 'PUT') throw new Error('exists');
      if (a < 4 && ([403, 409, 429].includes(r.status) || r.status >= 500)) { await sleep(1500 * (a + 1)); continue; }
      throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 200));
    }
  });
  q = run.catch(() => {});
  return run;
};
const put = (p, buf) => gh('PUT', p, { message: 'upload ' + p.split('/').pop(), content: buf.toString('base64') });
const del = (p, sha) => gh('DELETE', p, { message: 'delete ' + p.split('/').pop(), sha });
const hs = x => crypto.createHash('sha256').update(String(x)).digest();
const isAdmin = req => ADMIN_KEY && crypto.timingSafeEqual(hs(req.get('x-admin') || ''), hs(ADMIN_KEY));
const badPath = s => s.length > 2 || s.some(x => !x || x === '.' || x === '..');

async function stream(res, g, dir, name, dl, cache) {
  const mime = MIME[ext(name)];
  res.set({
    'Content-Type': mime || 'application/octet-stream', 'Content-Length': g.size,
    'Content-Disposition': (mime && !dl ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(show(name)),
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups', 'Cache-Control': cache
  });
  for (const p of g.parts) {
    const r = await fetch(`${GH}${enc(dir + p)}?ref=${GITHUB_BRANCH}`, { headers: H({ Accept: 'application/vnd.github.raw+json' }) });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    for await (const c of Readable.fromWeb(r.body)) { if (!res.write(c)) await Promise.race([once(res, 'drain'), once(res, 'close')]); if (res.destroyed) return; }
  }
  res.end();
}
const fail = (res, e) => res.headersSent ? res.destroy() : res.status(500).json({ error: e.message });
const chunkInfo = req => {
  const { name = 'file', ts, i = 0, n = 1, size = 0 } = req.query;
  if (!/^\d{10,15}$/.test(ts || '')) throw new Error('bad ts');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Пустой файл');
  const safe = clean(name) || 'file', id = ts + '-' + safe, idx = +i, total = +n;
  return { safe, id, idx, total, size: +size || req.body.length, ts: +ts, last: idx === total - 1, file: total > 1 ? `${id}.part${String(idx).padStart(4, '0')}` : id };
};
const raw = express.raw({ type: '*/*', limit: '30mb' });

// ---------- Общий диск ----------
app.get('/api/files', async (req, res) => {
  try {
    const list = group(await listRaw()).map(g => ({ id: g.id, name: show(g.id), size: g.size, time: +(g.id.match(/^\d+/) || [0])[0] }));
    res.json(list.sort((a, b) => b.time - a.time));
  } catch (e) { fail(res, e); }
});
app.post('/api/chunk', raw, async (req, res) => {
  try {
    const c = chunkInfo(req);
    await put(`${FILES_DIR}/${c.file}`, req.body);
    if (c.last) broadcast({ type: 'file', file: { id: c.id, name: c.safe, size: c.size, time: c.ts } });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.get('/f/:id', async (req, res) => {
  try {
    const g = group(await listRaw()).find(x => x.id === req.params.id);
    if (!g) return res.status(404).send('Файл не найден');
    await stream(res, g, FILES_DIR + '/', g.id, req.query.dl, 'public, max-age=3600');
  } catch (e) { fail(res, e); }
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(501).json({ error: 'ADMIN_KEY не задан' });
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
    const g = group(await listRaw()).find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Файл не найден' });
    for (const n of g.parts) await del(`${FILES_DIR}/${n}`, g.shas[n]);
    broadcast({ type: 'del', id: g.id });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------- Мои файлы (приватные, по личному ключу) ----------
app.get('/api/my/list', async (req, res) => {
  try {
    if (!okKey(req.query.k)) return res.status(400).json({ error: 'bad key' });
    const items = await tree(dirOf(req.query.k)), folders = new Map(), real = [];
    for (const i of items) {
      const s = i.name.split('/');
      if (s.length === 2 && !folders.has(s[0])) folders.set(s[0], { name: s[0], size: 0, count: 0 });
      if (!i.name.endsWith('.gitkeep')) real.push(i);
    }
    const files = group(real).map(g => {
      const s = g.id.split('/'), nm = s[s.length - 1];
      return { id: g.id, folder: s.length > 1 ? s[0] : '', name: show(nm), size: g.size, time: +(nm.match(/^\d+/) || [0])[0] };
    });
    for (const f of files) if (f.folder) { const fo = folders.get(f.folder); fo.size += f.size; fo.count++; }
    res.json({ folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)), files: files.sort((a, b) => b.time - a.time) });
  } catch (e) { fail(res, e); }
});
app.post('/api/my/folder', async (req, res) => {
  try {
    if (!okKey(req.query.k)) return res.status(400).json({ error: 'bad key' });
    await put(`${dirOf(req.query.k)}${clean(req.query.name)}/.gitkeep`, Buffer.from('.'));
    res.json({ ok: true });
  } catch (e) { e.message === 'exists' ? res.status(409).json({ error: 'Такая папка уже есть' }) : fail(res, e); }
});
app.post('/api/my/chunk', raw, async (req, res) => {
  try {
    if (!okKey(req.query.k)) return res.status(400).json({ error: 'bad key' });
    const c = chunkInfo(req), folder = req.query.folder ? clean(req.query.folder) + '/' : '';
    await put(`${dirOf(req.query.k)}${folder}${c.file}`, req.body);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.get('/api/my/f', async (req, res) => {
  try {
    if (!okKey(req.query.k)) return res.status(400).send('bad key');
    const p = String(req.query.p || ''), s = p.split('/');
    if (badPath(s)) return res.status(400).send('bad path');
    const dir = dirOf(req.query.k), items = (await tree(dir)).filter(i => !i.name.endsWith('.gitkeep'));
    const g = group(items).find(x => x.id === p);
    if (!g) return res.status(404).send('Файл не найден');
    await stream(res, g, dir, s[s.length - 1], req.query.dl, 'private, no-store');
  } catch (e) { fail(res, e); }
});

app.delete('/api/my/item', async (req, res) => {
  try {
    if (!okKey(req.query.k)) return res.status(400).json({ error: 'bad key' });
    const dir = dirOf(req.query.k), items = await tree(dir);
    let targets;
    if (req.query.folder) {
      const f = String(req.query.folder);
      if (f.includes('/') || /^\.*$/.test(f)) return res.status(400).json({ error: 'bad folder' });
      targets = items.filter(i => i.name.startsWith(f + '/'));
    } else {
      const p = String(req.query.p || '');
      if (badPath(p.split('/'))) return res.status(400).json({ error: 'bad path' });
      const g = group(items.filter(i => !i.name.endsWith('.gitkeep'))).find(x => x.id === p);
      if (!g) return res.status(404).json({ error: 'Файл не найден' });
      targets = g.parts.map(n => ({ name: n, sha: g.shas[n] }));
    }
    for (const t of targets) await del(dir + t.name, t.sha);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------- Чат ----------
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
      if (m.type !== 'chat' || now - ws.last < 300) return;
      ws.last = now;
      const msg = { type: 'chat', cid: String(m.cid || '').slice(0, 20), text: String(m.text || '').trim().slice(0, 500), time: now };
      if (!msg.text) return;
      chat.push(msg); if (chat.length > 100) chat.shift();
      broadcast(msg);
    } catch {}
  });
  ws.on('close', online);
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('Всемирный диск запущен'));
