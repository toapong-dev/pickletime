// Pickle Time: find common free time for pickleball (LINE LIFF front end).
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // slots start 06:00 … 21:00
const WEEKS_AHEAD = 4;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  config: null, token: null, user: null, liffReady: false,
  group: null, members: [], availability: {}, // availability: userId -> Set(slot)
  tab: 'best', week: 0, selected: null, saveTimer: null, pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const slotKey = (date, h) => `${date}T${pad(h)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    storeToken(null);
    location.reload();
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function storeToken(t) {
  state.token = t;
  try { t ? localStorage.setItem('pt_token', t) : localStorage.removeItem('pt_token'); } catch {}
}

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  $('backBtn').hidden = view !== 'group';
  if (view !== 'group') { $('title').textContent = '🏓 Pickle Time'; clearInterval(state.pollTimer); }
  window.scrollTo(0, 0);
}

// ---------- login ----------
async function boot() {
  state.config = await api('/api/config');
  try { state.token = localStorage.getItem('pt_token'); } catch {}

  if (state.config.liffId && window.liff) {
    try {
      await liff.init({ liffId: state.config.liffId });
      state.liffReady = true;
    } catch (e) { console.warn('LIFF init failed', e); }
  }

  if (state.token) {
    try { state.user = (await api('/api/me')).user; } catch { storeToken(null); }
  }

  if (!state.user && state.liffReady) {
    if (!liff.isLoggedIn()) return liff.login({ redirectUri: location.href });
    const idToken = liff.getIDToken();
    const r = await api('/api/login', { method: 'POST', body: { idToken } });
    storeToken(r.token); state.user = r.user;
  }

  if (!state.user) {
    if (state.config.devLogin) return show('devlogin');
    $('view-loading').innerHTML = '<p class="muted center">Please open this app from LINE.</p>';
    return;
  }
  afterLogin();
}

async function afterLogin() {
  if (state.user.picture) { $('avatar').src = state.user.picture; $('avatar').hidden = false; }
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    history.replaceState(null, '', location.pathname);
    try { return openGroup((await api('/api/join', { method: 'POST', body: { code } })).group.id); }
    catch (e) { toast(e.message); }
  }
  loadHome();
}

$('devLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('/api/dev-login', { method: 'POST', body: { name: $('devName').value } });
  storeToken(r.token); state.user = r.user;
  afterLogin();
});

// ---------- home ----------
async function loadHome() {
  show('home');
  const { groups } = await api('/api/groups');
  $('groupList').innerHTML = groups.length
    ? groups.map((g) => `<li data-id="${g.id}"><span class="name">${esc(g.name)}</span>
        <span class="muted small">${g.member_count} 👤</span><span class="code">${g.code}</span></li>`).join('')
    : '<li class="empty">No groups yet. Create one or join with a code.</li>';
}

$('groupList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openGroup(Number(li.dataset.id));
});

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { group } = await api('/api/groups', { method: 'POST', body: { name: $('groupName').value } });
    $('groupName').value = '';
    toast(`Group created. Code: ${group.code}`);
    openGroup(group.id);
  } catch (err) { toast(err.message); }
});

$('joinCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { group } = await api('/api/join', { method: 'POST', body: { code: $('joinCode').value } });
    $('joinCode').value = '';
    openGroup(group.id);
  } catch (err) { toast(err.message); }
});

$('backBtn').addEventListener('click', () => { flushSave(); loadHome(); });

// ---------- group ----------
async function fetchGroup(id) {
  const d = await api(`/api/groups/${id}`);
  state.group = d.group;
  state.members = d.members;
  const mine = state.availability[state.user.id];
  state.availability = {};
  for (const m of d.members) state.availability[m.id] = new Set(d.availability[m.id] || []);
  // Keep unsaved local edits.
  if (state.saveTimer && mine && state.group.id === id) state.availability[state.user.id] = mine;
}

async function openGroup(id) {
  state.availability = {};
  await fetchGroup(id);
  state.week = 0; state.selected = null;
  show('group');
  $('title').textContent = state.group.name;
  $('groupCode').textContent = state.group.code;
  renderGroup();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.dragging) return;
    try { await fetchGroup(id); renderGroup(); } catch {}
  }, 20000);
}

function renderGroup() {
  renderMembers();
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === state.tab);
  $('bestPanel').hidden = state.tab !== 'best';
  $('mineHint').hidden = state.tab !== 'mine';
  if (state.tab === 'best') renderTopTimes();
  renderGrid();
}

function renderMembers() {
  $('memberRow').innerHTML = state.members.map((m) => {
    const active = state.availability[m.id]?.size > 0;
    const pic = m.picture ? `<img src="${esc(m.picture)}" alt="">` : `<span class="ph">${esc(m.name[0] || '?')}</span>`;
    return `<span class="chip ${active ? '' : 'inactive'}" title="${active ? '' : 'Has not added free time yet'}">${pic}${esc(m.name)}</span>`;
  }).join('');
}

function weekDates(week) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + week * 7);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}

function isPast(date, h) {
  const now = new Date();
  return date < new Date(now.getFullYear(), now.getMonth(), now.getDate()) ||
    (ymd(date) === ymd(now) && h < now.getHours());
}

function freeAt(slot) {
  return state.members.filter((m) => state.availability[m.id]?.has(slot));
}

function renderGrid() {
  const dates = weekDates(state.week);
  const today = ymd(new Date());
  const n = Math.max(state.members.length, 1);
  const mine = state.availability[state.user.id] || new Set();
  const editing = state.tab === 'mine';
  $('grid').classList.toggle('editing', editing);

  let html = '<div></div>' + dates.map((d) =>
    `<div class="hd ${ymd(d) === today ? 'today' : ''}">${DAY[d.getDay()]}<b>${d.getDate()}</b></div>`).join('');
  for (const h of HOURS) {
    html += `<div class="hr">${pad(h)}:00</div>`;
    for (const [ci, d] of dates.entries()) {
      const key = slotKey(ymd(d), h);
      const past = isPast(d, h);
      let cls = 'cell', style = '', label = '';
      if (past) cls += ' past';
      if (editing) {
        if (mine.has(key)) cls += ' on';
      } else {
        const c = freeAt(key).length;
        if (c) {
          const a = 0.18 + 0.82 * (c / n);
          style = `background: rgba(6,199,85,${a.toFixed(2)})`;
          label = c;
        }
        if (state.selected === key) cls += ' sel';
      }
      html += `<div class="${cls}" data-slot="${key}" data-c="${ci}" data-h="${h}" ${past ? 'data-past="1"' : ''} style="${style}">${label}</div>`;
    }
  }
  $('grid').innerHTML = html;

  const first = dates[0], last = dates[6];
  $('weekLabel').textContent = `${first.getDate()} ${MON[first.getMonth()]} – ${last.getDate()} ${MON[last.getMonth()]}`;
  $('prevWeek').disabled = state.week === 0;
  $('nextWeek').disabled = state.week === WEEKS_AHEAD - 1;
  renderCellInfo();
}

function renderCellInfo() {
  const s = state.selected;
  if (state.tab !== 'best' || !s) { $('cellInfo').textContent = state.tab === 'best' ? 'Tap a time to see who is free.' : ''; return; }
  const who = freeAt(s).map((m) => m.name);
  $('cellInfo').textContent = `${fmtSlot(s.slice(0, 10), +s.slice(11), +s.slice(11) + 1)}: ` +
    (who.length ? `${who.join(', ')} (${who.length}/${state.members.length})` : 'nobody free');
}

function fmtSlot(date, h1, h2) {
  const d = new Date(date + 'T00:00:00');
  return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}, ${pad(h1)}:00–${pad(h2)}:00`;
}

// Find the best blocks of consecutive hours where the most people are free.
function renderTopTimes() {
  const n = state.members.length;
  const blocks = [];
  for (let w = 0; w < WEEKS_AHEAD; w++) {
    for (const d of weekDates(w)) {
      const date = ymd(d);
      let cur = null;
      for (const h of [...HOURS, 99]) {
        const key = slotKey(date, h);
        const who = h === 99 || isPast(d, h) ? [] : freeAt(key);
        const sig = who.map((m) => m.id).join(',');
        if (cur && sig === cur.sig) { cur.end = h + 1; continue; }
        if (cur && cur.count >= Math.min(2, n)) blocks.push(cur);
        cur = who.length ? { date, start: h, end: h + 1, sig, count: who.length, who } : null;
      }
    }
  }
  blocks.sort((a, b) => b.count - a.count || (b.end - b.start) - (a.end - a.start) || (a.date + a.start).localeCompare(b.date + b.start));
  const top = blocks.slice(0, 5);
  $('topTimes').innerHTML = top.length
    ? top.map((b) => `<li><div class="when">${fmtSlot(b.date, b.start, b.end)}</div>
        <div class="who">${b.count === n ? '🎉 Everyone' : `${b.count} of ${n}`}: ${esc(b.who.map((m) => m.name).join(', '))}</div></li>`).join('')
    : `<li class="empty">${n < 2 ? 'Invite friends with the code above, then everyone adds their free time.'
        : 'No overlapping free time yet. Add yours under “My free time”.'}</li>`;
}

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => { state.tab = t.dataset.tab; state.selected = null; renderGroup(); });
}
$('prevWeek').addEventListener('click', () => { flushSave(); state.week--; renderGrid(); });
$('nextWeek').addEventListener('click', () => { flushSave(); state.week++; renderGrid(); });

// Tap / drag to paint free hours.
const grid = $('grid');
grid.addEventListener('pointerdown', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || cell.dataset.past) return;
  const slot = cell.dataset.slot;
  if (state.tab === 'best') {
    state.selected = state.selected === slot ? null : slot;
    for (const c of grid.querySelectorAll('.cell.sel')) c.classList.remove('sel');
    if (state.selected) cell.classList.add('sel');
    return renderCellInfo();
  }
  e.preventDefault();
  const mine = (state.availability[state.user.id] ||= new Set());
  state.dragging = { add: !mine.has(slot), c: +cell.dataset.c, h: +cell.dataset.h, before: new Set(mine) };
  paint(cell);
});
grid.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cell = el && el.closest && el.closest('.cell');
  if (cell && grid.contains(cell) && !cell.dataset.past) paint(cell);
});
window.addEventListener('pointerup', () => { if (state.dragging) { state.dragging = null; renderMembers(); } });
window.addEventListener('pointercancel', () => { state.dragging = null; });

// Paint the rectangle between the first cell touched and the current one.
function paint(cell) {
  const dr = state.dragging;
  const c1 = Math.min(dr.c, +cell.dataset.c), c2 = Math.max(dr.c, +cell.dataset.c);
  const h1 = Math.min(dr.h, +cell.dataset.h), h2 = Math.max(dr.h, +cell.dataset.h);
  const mine = new Set(dr.before);
  for (const el of grid.querySelectorAll('.cell')) {
    const c = +el.dataset.c, h = +el.dataset.h;
    if (!el.dataset.past && c >= c1 && c <= c2 && h >= h1 && h <= h2) {
      if (dr.add) mine.add(el.dataset.slot); else mine.delete(el.dataset.slot);
    }
    el.classList.toggle('on', mine.has(el.dataset.slot));
  }
  state.availability[state.user.id] = mine;
  scheduleSave();
}

function scheduleSave() {
  $('saveState').textContent = 'Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 700);
}

function flushSave() { if (state.saveTimer) { clearTimeout(state.saveTimer); save(); } }

async function save() {
  state.saveTimer = null;
  const dates = Array.from({ length: WEEKS_AHEAD }, (_, w) => weekDates(w).map(ymd)).flat();
  const slots = [...(state.availability[state.user.id] || [])].filter((s) => dates.includes(s.slice(0, 10)));
  try {
    await api(`/api/groups/${state.group.id}/availability`, { method: 'PUT', body: { dates, slots } });
    $('saveState').textContent = 'Saved ✓';
  } catch (e) {
    $('saveState').textContent = 'Could not save. Check your connection.';
  }
}
window.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

// ---------- invite / leave ----------
$('shareBtn').addEventListener('click', async () => {
  const { code, name } = state.group;
  const link = state.config.liffId
    ? `https://liff.line.me/${state.config.liffId}?code=${code}`
    : `${location.origin}/?code=${code}`;
  const text = `🏓 Join "${name}" on Pickle Time so we can find a time to play!\nCode: ${code}\n${link}`;
  try {
    if (state.liffReady && liff.isApiAvailable('shareTargetPicker')) {
      await liff.shareTargetPicker([{ type: 'text', text }]);
      return;
    }
    if (navigator.share) return await navigator.share({ text });
    await navigator.clipboard.writeText(text);
    toast('Invite copied. Paste it in your LINE group.');
  } catch (e) {
    if (e?.name !== 'AbortError') toast(`Share this code: ${code}`);
  }
});

$('leaveBtn').addEventListener('click', async () => {
  if (!confirm(`Leave "${state.group.name}"? Your free times in this group will be removed.`)) return;
  await api(`/api/groups/${state.group.id}/membership`, { method: 'DELETE' });
  state.group = null;
  loadHome();
});

boot().catch((e) => {
  console.error(e);
  $('view-loading').innerHTML = `<p class="muted center">Something went wrong: ${esc(e.message)}</p>`;
});
