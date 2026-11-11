// Pickleball free-time finder: LINE LIFF app backend.
// Run: LIFF_ID=... LINE_CHANNEL_ID=... node server.js
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const LIFF_ID = process.env.LIFF_ID || '';
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID || '';
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
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
function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM groups WHERE code = ?').get(c)) return c;
  }
  throw new Error('Could not generate a unique code');
}

function upsertUser({ id, name, picture }) {
  db.prepare(`INSERT INTO users (id, name, picture) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, picture = excluded.picture`)
    .run(id, name || 'LINE user', picture || null);
}

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return token;
}

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const row = token && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row) return res.status(401).json({ error: 'Please log in again' });
  req.user = row;
  next();
}

function memberGroup(req, res) {
  const g = db.prepare(`SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id
    WHERE g.id = ? AND m.user_id = ?`).get(Number(req.params.id), req.user.id);
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
    upsertUser({ id: p.sub, name: p.name, picture: p.picture });
    res.json({ token: newSession(p.sub), user: { id: p.sub, name: p.name, picture: p.picture } });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach LINE' });
  }
});

// Local testing without LINE (only when DEV_LOGIN=1).
app.post('/api/dev-login', (req, res) => {
  if (!DEV_LOGIN) return res.status(404).end();
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'dev-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
  upsertUser({ id, name });
  res.json({ token: newSession(id), user: { id, name } });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/groups', auth, (req, res) => {
  const groups = db.prepare(`SELECT g.id, g.name, g.code,
      (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS member_count
    FROM groups g JOIN members m ON m.group_id = g.id
    WHERE m.user_id = ? ORDER BY m.joined_at DESC`).all(req.user.id);
  res.json({ groups });
});

app.post('/api/groups', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60) || 'Pickleball crew';
  const code = newCode();
  const now = Date.now();
  const { lastInsertRowid } = db.prepare('INSERT INTO groups (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)')
    .run(name, code, req.user.id, now);
  db.prepare('INSERT INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(lastInsertRowid, req.user.id, now);
  res.json({ group: { id: Number(lastInsertRowid), name, code } });
});

app.post('/api/join', auth, (req, res) => {
  const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const g = code.length === 4 && db.prepare('SELECT id, name, code FROM groups WHERE code = ?').get(code);
  if (!g) return res.status(404).json({ error: 'No group with that code' });
  db.prepare('INSERT OR IGNORE INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(g.id, req.user.id, Date.now());
  res.json({ group: g });
});

app.get('/api/groups/:id', auth, (req, res) => {
  const g = memberGroup(req, res);
  if (!g) return;
  const members = db.prepare(`SELECT u.id, u.name, u.picture FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? ORDER BY m.joined_at`).all(g.id);
  const rows = db.prepare('SELECT user_id, slot FROM availability WHERE group_id = ?').all(g.id);
  const availability = {};
  for (const r of rows) (availability[r.user_id] ||= []).push(r.slot);
  res.json({ group: { id: g.id, name: g.name, code: g.code, ownerId: g.owner_id }, members, availability });
});

// Replace my free slots for the given dates.
app.put('/api/groups/:id/availability', auth, (req, res) => {
  const g = memberGroup(req, res);
  if (!g) return;
  const { dates, slots } = req.body || {};
  if (!Array.isArray(dates) || !Array.isArray(slots) || dates.length > 60 || slots.length > 2000) {
    return res.status(400).json({ error: 'Bad request' });
  }
  const dateSet = new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const del = db.prepare('DELETE FROM availability WHERE group_id = ? AND user_id = ? AND substr(slot, 1, 10) = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO availability (group_id, user_id, slot) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const d of dateSet) del.run(g.id, req.user.id, d);
    for (const s of slots) if (SLOT_RE.test(s) && dateSet.has(s.slice(0, 10))) ins.run(g.id, req.user.id, s);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

app.delete('/api/groups/:id/membership', auth, (req, res) => {
  const g = memberGroup(req, res);
  if (!g) return;
  db.prepare('DELETE FROM availability WHERE group_id = ? AND user_id = ?').run(g.id, req.user.id);
  db.prepare('DELETE FROM members WHERE group_id = ? AND user_id = ?').run(g.id, req.user.id);
  const left = db.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ?').get(g.id).n;
  if (!left) db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Pickleball app on http://localhost:${PORT}` + (DEV_LOGIN ? ' (dev login enabled)' : ''));
  if (!LIFF_ID && !DEV_LOGIN) console.warn('Warning: LIFF_ID is not set and DEV_LOGIN is off; nobody can log in.');
});
