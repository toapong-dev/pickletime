// Pickleball free-time finder: LINE LIFF app backend.
// Run: LIFF_ID=... LINE_CHANNEL_ID=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node server.js
// Without TURSO_DATABASE_URL it uses a local SQLite file (fine for testing).
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const LIFF_ID = process.env.LIFF_ID || '';
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID || '';
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const DB_URL = process.env.TURSO_DATABASE_URL || 'file:' + (process.env.DB_PATH || path.join(__dirname, 'data.sqlite'));

const db = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const one = async (sql, args = []) => (await all(sql, args))[0];
const run = (sql, args = []) => db.execute({ sql, args });

const ready = db.executeMultiple(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, picture TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS availability (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    slot TEXT NOT NULL, -- local "YYYY-MM-DDTHH"
    PRIMARY KEY (group_id, user_id, slot)
  );
`);

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
async function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!(await one('SELECT 1 FROM groups WHERE code = ?', [c]))) return c;
  }
  throw new Error('Could not generate a unique code');
}

function upsertUser({ id, name, picture }) {
  return run(`INSERT INTO users (id, name, picture) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, picture = excluded.picture`,
    [id, name || 'LINE user', picture || null]);
}

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, userId, Date.now()]);
  return token;
}

// Wrap async handlers so errors become 500s instead of crashing.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const auth = h(async (req, res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const row = token && await one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]);
  if (!row) return res.status(401).json({ error: 'Please log in again' });
  req.user = { id: row.id, name: row.name, picture: row.picture };
  next();
});

async function memberGroup(req, res) {
  const g = await one(`SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id
    WHERE g.id = ? AND m.user_id = ?`, [Number(req.params.id), req.user.id]);
  if (!g) res.status(404).json({ error: 'Group not found' });
  return g;
}

const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

// ---------- routes ----------
app.get('/api/config', (req, res) => res.json({ liffId: LIFF_ID, devLogin: DEV_LOGIN }));

// Exchange a LIFF ID token for an app session (token is verified with LINE).
app.post('/api/login', async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing idToken' });
  if (!LINE_CHANNEL_ID) return res.status(500).json({ error: 'Server missing LINE_CHANNEL_ID' });
  try {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
    });
    const p = await r.json();
    if (!r.ok || !p.sub) return res.status(401).json({ error: p.error_description || 'LINE login failed' });
    await upsertUser({ id: p.sub, name: p.name, picture: p.picture });
    res.json({ token: await newSession(p.sub), user: { id: p.sub, name: p.name, picture: p.picture } });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach LINE' });
  }
});

// Local testing without LINE (only when DEV_LOGIN=1).
app.post('/api/dev-login', h(async (req, res) => {
  if (!DEV_LOGIN) return res.status(404).end();
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'dev-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
  await upsertUser({ id, name });
  res.json({ token: await newSession(id), user: { id, name } });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/groups', auth, h(async (req, res) => {
  const groups = await all(`SELECT g.id, g.name, g.code,
      (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS member_count
    FROM groups g JOIN members m ON m.group_id = g.id
    WHERE m.user_id = ? ORDER BY m.joined_at DESC`, [req.user.id]);
  res.json({ groups });
}));

app.post('/api/groups', auth, h(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60) || 'Pickleball crew';
  const code = await newCode();
  const now = Date.now();
  const { lastInsertRowid } = await run('INSERT INTO groups (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)',
    [name, code, req.user.id, now]);
  const id = Number(lastInsertRowid);
  await run('INSERT INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)', [id, req.user.id, now]);
  res.json({ group: { id, name, code } });
}));

app.post('/api/join', auth, h(async (req, res) => {
  const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const g = code.length === 4 && await one('SELECT id, name, code FROM groups WHERE code = ?', [code]);
  if (!g) return res.status(404).json({ error: 'No group with that code' });
  await run('INSERT OR IGNORE INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)', [g.id, req.user.id, Date.now()]);
  res.json({ group: { id: Number(g.id), name: g.name, code: g.code } });
}));

app.get('/api/groups/:id', auth, h(async (req, res) => {
  const g = await memberGroup(req, res);
  if (!g) return;
  const members = (await all(`SELECT u.id, u.name, u.picture FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? ORDER BY m.joined_at`, [g.id])).map((m) => ({ id: m.id, name: m.name, picture: m.picture }));
  const rows = await all('SELECT user_id, slot FROM availability WHERE group_id = ?', [g.id]);
  const availability = {};
  for (const r of rows) (availability[r.user_id] ||= []).push(r.slot);
  res.json({ group: { id: Number(g.id), name: g.name, code: g.code, ownerId: g.owner_id }, members, availability });
}));

// Replace my free slots for the given dates.
app.put('/api/groups/:id/availability', auth, h(async (req, res) => {
  const g = await memberGroup(req, res);
  if (!g) return;
  const { dates, slots } = req.body || {};
  if (!Array.isArray(dates) || !Array.isArray(slots) || dates.length > 60 || slots.length > 2000) {
    return res.status(400).json({ error: 'Bad request' });
  }
  const dateSet = new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const stmts = [];
  for (const d of dateSet) {
    stmts.push({ sql: 'DELETE FROM availability WHERE group_id = ? AND user_id = ? AND substr(slot, 1, 10) = ?', args: [g.id, req.user.id, d] });
  }
  for (const s of new Set(slots)) {
    if (typeof s === 'string' && SLOT_RE.test(s) && dateSet.has(s.slice(0, 10))) {
      stmts.push({ sql: 'INSERT OR IGNORE INTO availability (group_id, user_id, slot) VALUES (?, ?, ?)', args: [g.id, req.user.id, s] });
    }
  }
  await db.batch(stmts, 'write'); // one transaction
  res.json({ ok: true });
}));

app.delete('/api/groups/:id/membership', auth, h(async (req, res) => {
  const g = await memberGroup(req, res);
  if (!g) return;
  await db.batch([
    { sql: 'DELETE FROM availability WHERE group_id = ? AND user_id = ?', args: [g.id, req.user.id] },
    { sql: 'DELETE FROM members WHERE group_id = ? AND user_id = ?', args: [g.id, req.user.id] },
    { sql: 'DELETE FROM availability WHERE group_id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE group_id = ?)', args: [g.id, g.id] },
    { sql: 'DELETE FROM groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE group_id = ?)', args: [g.id, g.id] },
  ], 'write');
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error, please try again' });
});

ready.then(() => app.listen(PORT, () => {
  console.log(`Pickleball app on http://localhost:${PORT}` + (DEV_LOGIN ? ' (dev login enabled)' : ''));
  console.log('Database:', DB_URL.startsWith('file:') ? DB_URL : 'Turso');
  if (!LIFF_ID && !DEV_LOGIN) console.warn('Warning: LIFF_ID is not set and DEV_LOGIN is off; nobody can log in.');
}));
