require('dotenv').config();

// Surface silent boot-time crashes in Railway logs instead of letting Node
// exit with no explanation (which appears to the user as a 503 "Offline").
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});

const express = require('express');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const config  = require('./config/server-config');
const sheets  = require('./sheets');
const gmail   = require('./gmail');
const push    = require('./push');
const bot     = require('./advancingBot');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));

// Lightweight liveness probe. Unauthenticated by design — Railway's edge and
// external monitors hit this to confirm the container is alive.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid, node: process.version });
});

// Serve React build in production.
// Hashed assets get long cache; HTML and sw.js MUST always be fresh so users
// pick up new Railway deploys without manual cache-clearing.
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/dist'), {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'sw.js' || base === 'index.html' || base === 'manifest.webmanifest') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\/assets\//.test(filePath)) {
        // Vite fingerprints assets/* so they're safe to cache forever
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// ── Auth Helpers ─────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: '24h' }
  );
}

function requireAuth(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  // Query-string fallback for EventSource / <img> / <a download> flows that
  // can't send an Authorization header. Never accepted from a POST body.
  const token = headerToken || req.query.access_token || null;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user)                               return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)                              return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.active?.toLowerCase() === 'false') return res.status(403).json({ success: false, message: 'Account disabled' });
    const token = signToken(user);
    res.json({ success: true, token, user: { id: user.id, name: user.name, role: user.role, email: user.email, staffId: user.staffId || '' } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Update the currently signed-in user's display name (and optionally email).
// Email changes require re-checking uniqueness across the Users sheet.
app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body || {};
    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof email === 'string' && email.trim()) {
      const newEmail = email.trim().toLowerCase();
      const users = await sheets.getRows(config.googleSheets.sheets.users);
      const clash = users.find(u => u.email?.toLowerCase() === newEmail && u.id !== req.user.id);
      if (clash) return res.status(409).json({ success: false, message: 'Email already in use' });
      updates.email = newEmail;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'No changes provided' });
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, updates);
    res.json({ success: true, user: { ...req.user, ...updates } });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Change the signed-in user's password. Requires the current password.
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Both current and new password are required' });
    if (newPassword.length < 8)            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === req.user.id);
    if (!user)                                       return res.status(404).json({ success: false, message: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid)                                      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, { password: hash });
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Generic CRUD factory ──────────────────────────────────────────────────────
function crudRoutes(router, path, sheetKey, writeRoles = ['admin','production_manager'], hooks = {}) {
  const deleteRoles = hooks.deleteRoles || writeRoles;
  router.get(path, requireAuth, async (req, res) => {
    try { res.json({ success: true, data: await sheets.getRows(config.googleSheets.sheets[sheetKey]) }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.post(path, requireAuth, requireRole(...writeRoles), async (req, res) => {
    try {
      const record = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };
      // Pre-create guard. Client can bypass by posting with ?force=1.
      if (typeof hooks.beforeCreate === 'function' && req.query.force !== '1') {
        try {
          const check = await hooks.beforeCreate(record, req);
          if (check && check.duplicate) {
            return res.status(409).json({
              success: false,
              code: 'duplicate',
              message: check.message || 'A similar record already exists.',
              conflict: check.conflict || null,
            });
          }
        } catch (err) {
          // Fail open — don't block a legit create on a hook error.
          console.error(`[${sheetKey} beforeCreate]`, err.message);
        }
      }
      await sheets.appendRow(config.googleSheets.sheets[sheetKey], record);
      let extra;
      if (typeof hooks.afterCreate === 'function') {
        if (hooks.awaitAfterCreate) {
          // Awaited hook may return an object to merge into the response payload.
          try { extra = await hooks.afterCreate(record, req); }
          catch (err) { console.error(`[${sheetKey} afterCreate]`, err.message); }
        } else {
          // Fire-and-forget so the client gets a fast response.
          Promise.resolve()
            .then(() => hooks.afterCreate(record, req))
            .catch(err => console.error(`[${sheetKey} afterCreate]`, err.message));
        }
      }
      res.json({ success: true, data: record, ...(extra || {}) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.put(path + '/:id', requireAuth, requireRole(...writeRoles), async (req, res) => {
    try {
      let prev;
      if (typeof hooks.afterUpdate === 'function') {
        try {
          const rows = await sheets.getRows(config.googleSheets.sheets[sheetKey]);
          prev = rows.find(r => String(r.id) === String(req.params.id));
        } catch (err) { console.warn(`[${sheetKey} afterUpdate prev]`, err.message); }
      }
      await sheets.updateRowById(config.googleSheets.sheets[sheetKey], req.params.id, req.body);
      if (typeof hooks.afterUpdate === 'function') {
        Promise.resolve()
          .then(() => hooks.afterUpdate({ id: req.params.id, ...(prev || {}), ...req.body }, prev, req))
          .catch(err => console.error(`[${sheetKey} afterUpdate]`, err.message));
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
  router.delete(path + '/:id', requireAuth, requireRole(...deleteRoles), async (req, res) => {
    try {
      await sheets.deleteRowById(config.googleSheets.sheets[sheetKey], req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
}

// ── Auto-advancing kickoff for new shows ─────────────────────────────────────
// When a show is created, automatically:
//   1. Create a matching Advancing record (idempotent — skips if one exists)
//   2. Create the show's Google Drive folder (best-effort)
//   3. If an advance contact email is already known, sync Gmail history and
//      run the bot extractor so the advancer opens to pre-filled suggestions
//   4. Make sure every artist on the bill exists in the Artist Registry

// Split a free-text show title into individual artist names.
// Handles separators commonly used on lineups: comma, semicolon, "/", "&",
// " w/ ", " with ", " + ", " feat. ", " ft. ".
function splitArtistNames(text) {
  if (!text) return [];
  return String(text)
    .split(/\s*(?:,|;|\/| w\/ | with | feat\.? | ft\.? | \+ | & )\s*/i)
    .map(s => s.trim())
    .filter(s => s && s.length >= 2 && s.length <= 80);
}

// Make sure every artist named on a show exists in the Artist Registry.
// Match is case-insensitive against existing artist.name and any aliases.
// Newly created rows include createdAt and a small audit note.
async function ensureArtistsFromShow(show) {
  const candidates = [
    ...splitArtistNames(show.artist),
    ...splitArtistNames(show.support),
    ...splitArtistNames(show.eventName),
  ];
  if (candidates.length === 0) return [];

  const existing = await sheets.getRows(config.googleSheets.sheets.artists);
  const known = new Set();
  for (const a of existing) {
    if (a.name) known.add(a.name.toLowerCase().trim());
    String(a.aliases || '').split(',').forEach(x => {
      const t = x.trim().toLowerCase();
      if (t) known.add(t);
    });
  }

  const seen = new Set();
  const created = [];
  for (const raw of candidates) {
    const key = raw.toLowerCase().trim();
    if (!key || seen.has(key) || known.has(key)) continue;
    seen.add(key);
    const row = {
      id:            `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      name:          raw,
      aliases:       '',
      agency:        '',
      agent:         '',
      contactName:   '',
      contactEmail:  '',
      contactPhone:  '',
      notes:         `Auto-added from show ${show.id} (${show.date || ''})`,
      driveFolderId: '',
      createdAt:     new Date().toISOString(),
    };
    try {
      await sheets.appendRow(config.googleSheets.sheets.artists, row);
      created.push(row.name);
      known.add(key);
      // Best-effort: create the artist's Drive folder so docs have a home
      ensureArtistFolder(row.id).catch(err =>
        console.warn('[kickoff] artist folder creation failed for', row.name, err.message)
      );
    } catch (err) {
      console.error('[kickoff] Failed to add artist', raw, err.message);
    }
  }
  if (created.length) {
    console.log(`[kickoff] Added ${created.length} artist(s) to registry: ${created.join(', ')}`);
  }
  return created;
}

// Standard Day-of-Show timeline seeded on every show creation.
// Idempotent: does nothing if the show already has any schedule rows.
// Returns the number of rows inserted.
//
// The `time` values here are hard-coded fallbacks. Admins can override them
// (globally, or per day of the week) via /api/settings/venue — see
// getVenueDefaults() below. Item keys and default labels are fixed.
const DAY_SHEET_TEMPLATE = [
  { key: 'loadIn',     label: 'Load In',           time: '15:00' },
  { key: 'soundCheck', label: 'Sound Check',       time: '17:00' },
  { key: 'doors',      label: 'Doors',             time: '19:00' },
  { key: 'set1',       label: 'Set 1',             time: '20:00' },
  { key: 'changeover', label: 'Changeover',        time: '21:00' },
  { key: 'set2',       label: 'Set 2',             time: '21:30' },
  { key: 'curfew',     label: 'Curfew / Load Out', time: '23:00' },
];
const DAY_SHEET_KEYS = DAY_SHEET_TEMPLATE.map(it => it.key);

// ── Venue defaults (per-stage capacity + day-sheet times) ─────────────────
// Stored as a single JSON row in the AppSettings sheet under key
// `venueDefaults`. Cached in memory for a short window to avoid hitting
// Sheets on every show creation.
//
// Shape:
//   {
//     stages: {
//       <stageKey>: {
//         capacity: <number>,
//         daySheet: {
//           default: { [itemKey]: 'HH:MM' },
//           byDay:   { '0'..'6': { [itemKey]: 'HH:MM' } }  // 0 = Sunday
//         }
//       }
//     }
//   }
function buildStageDefaults() {
  const flatTimes = Object.fromEntries(DAY_SHEET_TEMPLATE.map(it => [it.key, it.time]));
  return Object.fromEntries(
    Object.entries(config.stages).map(([k, s]) => [k, {
      capacity: s.capacity,
      daySheet: { default: { ...flatTimes }, byDay: {} },
    }])
  );
}
const HARD_VENUE_DEFAULTS = { stages: buildStageDefaults() };

let _venueCache = null;
let _venueCacheAt = 0;
const VENUE_CACHE_MS = 15_000;

function normalizeTime(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  // Accept HH:MM (24h). Reject anything else silently.
  return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, '0') : '';
}

function normalizeDaySheet(src, fallback) {
  const def = {};
  for (const k of DAY_SHEET_KEYS) {
    def[k] = normalizeTime(src?.default?.[k]) || fallback.default[k];
  }
  const byDay = {};
  for (const d of ['0','1','2','3','4','5','6']) {
    const raw = src?.byDay?.[d];
    if (!raw || typeof raw !== 'object') continue;
    const entry = {};
    for (const k of DAY_SHEET_KEYS) {
      const t = normalizeTime(raw[k]);
      if (t) entry[k] = t;
    }
    if (Object.keys(entry).length) byDay[d] = entry;
  }
  return { default: def, byDay };
}

function normalizeVenueDefaults(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  // Legacy shape had a top-level `daySheet`. Fold it into every stage so old
  // rows keep working after the per-stage refactor.
  const legacy = src.daySheet && typeof src.daySheet === 'object' ? src.daySheet : null;
  const stages = {};
  for (const k of Object.keys(HARD_VENUE_DEFAULTS.stages)) {
    const hard = HARD_VENUE_DEFAULTS.stages[k];
    const stageSrc = src.stages?.[k] || {};
    const cap = Number(stageSrc.capacity);
    const capacity = Number.isFinite(cap) && cap > 0 ? Math.round(cap) : hard.capacity;
    const daySheet = normalizeDaySheet(stageSrc.daySheet || legacy || {}, hard.daySheet);
    stages[k] = { capacity, daySheet };
  }
  return { stages };
}

async function getVenueDefaults({ force = false } = {}) {
  if (!force && _venueCache && (Date.now() - _venueCacheAt) < VENUE_CACHE_MS) {
    return _venueCache;
  }
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.appSettings);
    const row = rows.find(r => r.key === 'venueDefaults');
    let parsed = {};
    if (row?.value) {
      try { parsed = JSON.parse(row.value); }
      catch (err) { console.warn('[venue-defaults] parse failed:', err.message); }
    }
    _venueCache = normalizeVenueDefaults(parsed);
  } catch (err) {
    console.warn('[venue-defaults] read failed, using hard defaults:', err.message);
    _venueCache = normalizeVenueDefaults({});
  }
  _venueCacheAt = Date.now();
  return _venueCache;
}

// Deep-merge a patch onto the current per-stage venue defaults. Any stage,
// capacity, default row, or byDay entry the caller omits is left untouched.
async function setVenueDefaults(patch) {
  const current = await getVenueDefaults({ force: true });
  const mergedStages = { ...current.stages };
  const patchStages = patch?.stages || {};
  for (const k of Object.keys(HARD_VENUE_DEFAULTS.stages)) {
    const cur = current.stages[k] || HARD_VENUE_DEFAULTS.stages[k];
    const p   = patchStages[k];
    if (!p) { mergedStages[k] = cur; continue; }
    mergedStages[k] = {
      capacity: p.capacity !== undefined ? p.capacity : cur.capacity,
      daySheet: {
        default: { ...cur.daySheet.default, ...(p.daySheet?.default || {}) },
        byDay:   { ...cur.daySheet.byDay,   ...(p.daySheet?.byDay   || {}) },
      },
    };
  }
  const merged = normalizeVenueDefaults({ stages: mergedStages });
  const value = JSON.stringify(merged);
  const rows = await sheets.getRows(config.googleSheets.sheets.appSettings);
  const existing = rows.find(r => r.key === 'venueDefaults');
  if (existing) {
    await sheets.updateRowById(config.googleSheets.sheets.appSettings, existing.id, { value, updatedAt: new Date().toISOString() });
  } else {
    await sheets.appendRow(config.googleSheets.sheets.appSettings, {
      id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      key: 'venueDefaults',
      value,
      updatedAt: new Date().toISOString(),
    });
  }
  _venueCache = merged;
  _venueCacheAt = Date.now();
  return merged;
}

// Resolve the day-sheet times to use for a given show, applying:
//   show-specific field > per-day-of-week override for the show's stage
//   > stage default > hard-coded template.
//
// Show-specific fields are the ones the user enters on the show form:
//   • show.doorsTime  → maps to the `doors` day-sheet item
//   • show.showTime   → maps to `set1` when a support is booked, else `set2`
//     (i.e. the first act to hit the stage). We only apply it once; the other
//     set falls back to the default/override.
function resolveDaySheetTimes(show, venue) {
  const stageKey = show?.stage || 'inside';
  const stage = venue?.stages?.[stageKey] || HARD_VENUE_DEFAULTS.stages[stageKey] || HARD_VENUE_DEFAULTS.stages.inside;
  const daySheet = stage.daySheet;
  let dow = null;
  const iso = String(show?.date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    dow = String(new Date(y, m - 1, d).getDay());
  }
  const perDay = dow != null ? (daySheet.byDay?.[dow] || {}) : {};

  // Which set does the show's `showTime` correspond to?
  const hasSupport = Boolean(String(show?.support || '').trim());
  const showTimeKey = hasSupport ? 'set1' : 'set2';
  const fromShow = {};
  const doors = normalizeTime(show?.doorsTime);
  if (doors) fromShow.doors = doors;
  const showTime = normalizeTime(show?.showTime);
  if (showTime) fromShow[showTimeKey] = showTime;

  const out = {};
  for (const it of DAY_SHEET_TEMPLATE) {
    out[it.key] =
      fromShow[it.key] ||
      perDay[it.key] ||
      daySheet.default?.[it.key] ||
      it.time;
  }
  return out;
}

// Build day-sheet labels using the show's headliner / support names when
// available. Support acts play Set 1; the headliner plays Set 2.
// `times` is a { [key]: 'HH:MM' } map (from resolveDaySheetTimes) — falls
// back to the hard-coded template time when a key is missing.
function buildDaySheetLabels(show, times = {}) {
  const headliner = (show.artist || '').trim();
  const supportRaw = (show.support || '').trim();
  const supports = supportRaw
    ? supportRaw.split(/\s*,\s*/).filter(Boolean)
    : [];
  const firstSupport = supports[0] || '';

  return DAY_SHEET_TEMPLATE.map(it => {
    let label = it.label;
    if (it.key === 'set1') {
      if (firstSupport) label = `${firstSupport} Set`;
      else if (headliner) label = `${headliner} Set 1`;
    } else if (it.key === 'set2') {
      if (headliner && firstSupport) label = `${headliner} Set`;
      else if (headliner) label = `${headliner} Set 2`;
    }
    return { ...it, label, time: times[it.key] || it.time };
  });
}

async function seedDaySheetForShow(show) {
  if (!show || !show.id) return 0;
  const showLabel = show.artist || show.eventName || `Show ${show.id}`;
  const existing = await sheets.getRows(config.googleSheets.sheets.schedule);
  const mine = existing.filter(r => String(r.showId) === String(show.id));
  if (mine.length > 0) return 0;
  const venue = await getVenueDefaults().catch(() => normalizeVenueDefaults({}));
  const times = resolveDaySheetTimes(show, venue);
  const template = buildDaySheetLabels(show, times);
  const stamp = Date.now();
  const rows = template.map((it, i) => ({
    id:          `${stamp}${i}${Math.random().toString(36).slice(2, 5)}`,
    showId:      show.id,
    showName:    showLabel,
    stage:       show.stage || 'inside',
    date:        show.date || '',
    eventType:   'time',
    label:       it.label,
    time:        it.time,
    duration:    '',
    responsible: '',
    notes:       '',
    createdAt:   new Date().toISOString(),
  }));
  await sheets.appendRows(config.googleSheets.sheets.schedule, rows);
  return rows.length;
}

// Rename generic "Set 1" / "Set 2" placeholders to include the headliner /
// support names for shows that were seeded before this feature existed.
// Only touches rows whose label is still the untouched generic string, so
// user-customized labels are preserved.
async function backfillDaySheetLabels(show) {
  if (!show || !show.id || !show.artist) return 0;
  const rows = await sheets.getRows(config.googleSheets.sheets.schedule);
  const mine = rows.filter(r => String(r.showId) === String(show.id));
  if (mine.length === 0) return 0;
  const venue = await getVenueDefaults().catch(() => normalizeVenueDefaults({}));
  const times = resolveDaySheetTimes(show, venue);
  const template = buildDaySheetLabels(show, times);
  const wanted = {
    'Set 1': template.find(t => t.key === 'set1')?.label,
    'Set 2': template.find(t => t.key === 'set2')?.label,
  };
  let updated = 0;
  for (const row of mine) {
    const next = wanted[row.label];
    if (next && next !== row.label) {
      try {
        await sheets.updateRowById(config.googleSheets.sheets.schedule, row.id, { label: next });
        updated++;
      } catch (err) {
        console.warn('[day-sheet backfill] update failed:', err.message);
      }
    }
  }
  return updated;
}

async function kickoffAdvanceForShow(show) {
  if (!show || !show.id) return;
  const showLabel = show.artist || show.eventName || `Show ${show.id}`;
  console.log(`[kickoff] Preparing advance for show ${show.id} — ${showLabel}`);

  // Notify production team that a new show was created (fire-and-forget).
  push.sendToRole(
    ['admin', 'production_manager'],
    {
      title: 'New show added',
      body: `${showLabel}${show.date ? ' — ' + show.date : ''}${show.stage ? ' (' + show.stage + ')' : ''}`,
      url: `/shows/${show.id}`,
      tag: `show-${show.id}`,
    },
    'showUpdates'
  ).catch(err => console.warn('[push] show-created notify failed:', err.message));



  // 0. Ensure artists on the bill are in the registry (fire-and-forget safe)
  try { await ensureArtistsFromShow(show); }
  catch (err) { console.error('[kickoff] Artist registry sync failed:', err.message); }

  // 1. Create Advancing record if none exists for this showId
  let advanceId = null;
  try {
    const existing = await sheets.getRows(config.googleSheets.sheets.advancing);
    const match    = existing.find(a => a.showId === show.id);
    if (match) {
      advanceId = match.id;
      console.log(`[kickoff] Advance row already exists (${advanceId}); skipping create.`);
    } else {
      const advance = {
        id:                 `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        showId:             show.id,
        showName:           showLabel,
        stage:              show.stage || 'inside',
        riderReceived:      'false',
        riderNotes:         '',
        stagingChanges:     '',
        capacityChanges:    '',
        soundRestrictions: '',
        curfew:             '',
        productionNeeds:    '',
        backlineNotes:      '',
        cateringNotes:      '',
        hospitalityNotes:   '',
        localCrewNeeds:     '',
        advancingComplete:  'false',
        advanceContact:     show.tourManager || '',
        advancePhone:       '',
        advanceEmail:       show.advanceEmail || '',
        notes:              '',
        createdAt:          new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.advancing, advance);
      advanceId = advance.id;
      console.log(`[kickoff] Created advance row ${advanceId}.`);
    }
  } catch (err) {
    console.error('[kickoff] Failed to create advance row:', err.message);
  }

  // 2. Create the show's Drive folder (best-effort)
  try {
    if (!show.driveFolderId) {
      const drive = await sheets.getDriveClient();
      const folderName = `Windjammer — ${show.date || 'TBD'} — ${showLabel}`;
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      const folderId = folder.data.id;
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      await sheets.updateRowById(config.googleSheets.sheets.shows, show.id, { driveFolderId: folderId });
      console.log(`[kickoff] Created Drive folder ${folderId}.`);
    }
  } catch (err) {
    console.error('[kickoff] Drive folder creation failed:', err.message);
  }

  // 2b. Seed the Day-of-Show schedule with the standard day sheet items.
  try {
    const seeded = await seedDaySheetForShow(show);
    if (seeded > 0) console.log(`[kickoff] Seeded ${seeded} day-sheet items.`);
  } catch (err) {
    console.error('[kickoff] Day-sheet seed failed:', err.message);
  }

  // 3. If we already have an advance email, do an initial Gmail sync
  const advanceEmail = show.advanceEmail || '';
  if (advanceEmail && gmail.isConfigured() && advanceId) {
    try {
      const newCount = await syncEmailsForShow(show.id, advanceEmail, showLabel);
      console.log(`[kickoff] Pulled ${newCount} initial email(s) for ${advanceEmail}.`);
    } catch (err) {
      console.error('[kickoff] Initial Gmail sync failed:', err.message);
    }
  }
}

// Notify the assigned staff member when a labor row (shift) is created for
// them. Looks up the user account by staffId and pushes only to that user.
async function notifyShiftAssigned(record) {
  try {
    if (!record || !record.staffId) return;
    const users = await sheets.getRows(config.googleSheets.sheets.users).catch(() => []);
    const u = users.find(x => String(x.staffId) === String(record.staffId));
    if (!u || !u.id) return;
    const showLabel = record.showName || record.showId || 'a show';
    const when = [record.callTime, record.wrapTime].filter(Boolean).join(' – ');
    push.sendToUser(
      u.id,
      {
        title: 'Shift assigned',
        body: `${record.role || 'Shift'} for ${showLabel}${when ? ' (' + when + ')' : ''}`,
        url: record.showId ? `/shows/${record.showId}` : '/labor',
        tag: `shift-${record.id}`,
      },
      'shiftAssigned'
    ).catch(err => console.warn('[push] shift notify failed:', err.message));
  } catch (err) {
    console.warn('[push] notifyShiftAssigned error:', err.message);
  }
}

// ── Show Requests ────────────────────────────────────────────────────────────
// Staff/crew "raise their hand" for a show. This does NOT auto-assign them —
// production reviews the list when building the crew call (see /labor).
// Roles allowed to submit: any authed user. A user may only submit on behalf
// of themselves (or PM+ may submit on behalf of any staff).
const REQUEST_PM_ROLES = ['admin', 'production_manager', 'stage_manager'];

app.get('/api/show-requests', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.showRequests);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/show-requests', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const showId = String(body.showId || '').trim();
    if (!showId) return res.status(400).json({ success: false, message: 'showId required' });

    // Resolve the staff row: non-PM users may only request for themselves.
    const isPM = REQUEST_PM_ROLES.includes(req.user?.role);
    let staffId = String(body.staffId || '').trim();
    if (!isPM || !staffId) staffId = req.user?.staffId || '';
    if (!staffId) return res.status(400).json({ success: false, message: 'No staff record linked to your account' });

    const [staffRows, showRows, existing] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.staff),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.showRequests),
    ]);
    const staff = staffRows.find(s => s.id === staffId);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
    const show = showRows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    const dup = existing.find(r =>
      r.showId === showId && r.staffId === staffId && (r.status || 'requested') !== 'withdrawn'
    );
    if (dup) return res.status(409).json({ success: false, message: 'You already requested this show', data: dup });

    const record = {
      id:         Date.now().toString(),
      showId,
      showDate:   show.date || '',
      showName:   show.artist || show.eventName || '',
      staffId,
      staffName:  staff.name || '',
      role:       (body.role || staff.role || '').trim(),
      notes:      (body.notes || '').trim(),
      status:     'requested',
      createdAt:  new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.showRequests, record);

    // Ping the production team so requests don't sit unseen.
    push.sendToRole(
      ['admin', 'production_manager'],
      {
        title: 'Show request',
        body: `${staff.name || 'Someone'} requested ${record.showName || 'a show'}${record.role ? ' — ' + record.role : ''}`,
        url: `/shows/${showId}`,
        tag: `show-req-${record.id}`,
      },
      'shiftAssigned'
    ).catch(err => console.warn('[push] show-request notify failed:', err.message));

    res.json({ success: true, data: record });
  } catch (err) {
    console.error('Show request error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Withdraw a request. Owner or PM+ only.
app.delete('/api/show-requests/:id', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.showRequests);
    const row = rows.find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const isPM = REQUEST_PM_ROLES.includes(req.user?.role);
    const isOwner = req.user?.staffId && String(req.user.staffId) === String(row.staffId);
    if (!isPM && !isOwner) return res.status(403).json({ success: false, message: 'Not allowed' });
    await sheets.deleteRowById(config.googleSheets.sheets.showRequests, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Show request delete error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

crudRoutes(app, '/api/shows',           'shows',     ['admin','production_manager','stage_manager','promoter'], {
  // Duplicate guard: reject a manual create that matches an existing show on
  // date + artist (alias-aware via the Artist Registry). Client can retry
  // with ?force=1 after confirming with the user.
  beforeCreate: async (record) => {
    if (!record?.date || !(record.artist || record.eventName)) return null;
    const [shows, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    const isDup = buildDuplicateChecker(shows, artists);
    const name = record.artist || record.eventName;
    const evForCheck = { date: record.date, artist: name, title: name, url: '' };
    if (!isDup(evForCheck)) return null;
    const targetKey = normalizeArtistKey(name);
    const conflict = shows.find(s =>
      s.date === record.date &&
      (normalizeArtistKey(s.artist || s.eventName || '') === targetKey ||
       (targetKey.length >= 6 && normalizeArtistKey(s.artist || s.eventName || '').includes(targetKey)) ||
       (normalizeArtistKey(s.artist || s.eventName || '').length >= 6 && targetKey.includes(normalizeArtistKey(s.artist || s.eventName || ''))))
    );
    return {
      duplicate: true,
      message: `A show on ${record.date} for "${name}" already exists.`,
      conflict: conflict
        ? { id: conflict.id, date: conflict.date, artist: conflict.artist || conflict.eventName || '' }
        : null,
    };
  },
  afterCreate: kickoffAdvanceForShow,
  // When an editor changes `artist` or `support`, make sure any newly-named
  // acts get an Artist Registry entry (and Drive folder) so their documents
  // tab works. Existing day-sheet labels are left alone so user-customized
  // rows survive; the Set 1 / Set 2 backfill only re-labels rows that still
  // have the untouched generic string.
  afterUpdate: async (next, prev /*, req */) => {
    try {
      const artistChanged  = (prev?.artist  || '') !== (next?.artist  || '');
      const supportChanged = (prev?.support || '') !== (next?.support || '');
      if (!artistChanged && !supportChanged) return;
      await ensureArtistsFromShow(next).catch(err =>
        console.warn('[shows afterUpdate] artist registry sync failed:', err.message)
      );
      await backfillDaySheetLabels(next).catch(err =>
        console.warn('[shows afterUpdate] day-sheet label refresh failed:', err.message)
      );
    } catch (err) {
      console.warn('[shows afterUpdate]', err.message);
    }
  },
});

// ── Events (multi-day / multi-show groupings) ────────────────────────────────
// Lightweight overlay on Shows. A show belongs to at most one Event via its
// eventId column; regular one-off shows leave eventId blank and behave exactly
// as before. Used for festivals, residencies, weekend-long bookings, etc.

// Clear eventId on shows that were attached to a deleted event. Registered
// BEFORE crudRoutes so this middleware matches the DELETE first and passes
// through to the crudRoutes-installed delete handler via next().
app.delete('/api/events/:id', requireAuth, requireRole('admin', 'production_manager'), async (req, res, next) => {
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const linked = shows.filter(s => String(s.eventId || '') === String(req.params.id));
    for (const s of linked) {
      await sheets.updateRowById(config.googleSheets.sheets.shows, s.id, { eventId: '' });
    }
  } catch (err) {
    console.warn('[events delete cascade]', err.message);
  }
  next();
});

crudRoutes(app, '/api/events', 'events', ['admin', 'production_manager'], {
  // Recompute startDate/endDate from linked shows if they weren't supplied.
  // Keeps the event's date range accurate as shows get attached/removed.
  afterUpdate: async (next /*, prev, req */) => {
    try {
      if (next.startDate && next.endDate) return;
      const shows = await sheets.getRows(config.googleSheets.sheets.shows);
      const dates = shows
        .filter(s => String(s.eventId || '') === String(next.id))
        .map(s => s.date)
        .filter(Boolean)
        .sort();
      if (dates.length === 0) return;
      const patch = {};
      if (!next.startDate) patch.startDate = dates[0];
      if (!next.endDate)   patch.endDate   = dates[dates.length - 1];
      if (Object.keys(patch).length) {
        await sheets.updateRowById(config.googleSheets.sheets.events, next.id, patch);
      }
    } catch (err) {
      console.warn('[events afterUpdate range]', err.message);
    }
  },
});

// Bulk-attach a set of existing shows to an event in one call.
// Body: { showIds: string[] }
app.post('/api/events/:id/attach-shows', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const showIds = Array.isArray(req.body?.showIds) ? req.body.showIds : [];
    if (showIds.length === 0) return res.json({ success: true, updated: 0 });
    const events = await sheets.getRows(config.googleSheets.sheets.events);
    const event = events.find(e => String(e.id) === String(req.params.id));
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    let updated = 0;
    for (const id of showIds) {
      await sheets.updateRowById(config.googleSheets.sheets.shows, String(id), { eventId: event.id });
      updated++;
    }
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const dates = shows
      .filter(s => String(s.eventId || '') === String(event.id))
      .map(s => s.date)
      .filter(Boolean)
      .sort();
    if (dates.length) {
      await sheets.updateRowById(config.googleSheets.sheets.events, event.id, {
        startDate: dates[0],
        endDate:   dates[dates.length - 1],
      });
    }
    res.json({ success: true, updated });
  } catch (err) {
    console.error('[events attach-shows]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Detach a single show from its event (clears eventId).
app.post('/api/events/:id/detach-show', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const showId = String(req.body?.showId || '');
    if (!showId) return res.status(400).json({ success: false, message: 'showId is required' });
    await sheets.updateRowById(config.googleSheets.sheets.shows, showId, { eventId: '' });
    res.json({ success: true });
  } catch (err) {
    console.error('[events detach-show]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Event-wide schedule: merges rows tagged with this eventId with any per-show
// day-sheet rows whose showId belongs to a show in the event.
app.get('/api/events/:id/schedule', requireAuth, async (req, res) => {
  try {
    const eventId = String(req.params.id);
    const [events, shows, schedule] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.events),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.schedule),
    ]);
    const event = events.find(e => String(e.id) === eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    const eventShows = shows.filter(s => String(s.eventId || '') === eventId);
    const showIds = new Set(eventShows.map(s => String(s.id)));
    const items = schedule.filter(r =>
      String(r.eventId || '') === eventId || showIds.has(String(r.showId || ''))
    );
    items.sort((a, b) => {
      const d = (a.date || '').localeCompare(b.date || '');
      if (d !== 0) return d;
      return (a.time || '').localeCompare(b.time || '');
    });
    res.json({ success: true, data: { event, shows: eventShows, items } });
  } catch (err) {
    console.error('[events schedule]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Artist defaults: shared helpers ──────────────────────────────────────────
// The artist registry now owns long-term production info (rider, production
// needs, backline, hospitality, catering, advance contact). Per-show Advancing
// rows can still override any of these for one-off changes, but when an
// Advancing field is blank we fall back to the artist record.
const ARTIST_DEFAULT_FIELDS = [
  'riderNotes', 'productionNeeds', 'backlineNotes',
  'hospitalityNotes', 'cateringNotes',
  'advanceContact', 'advancePhone', 'advanceEmail',
];

// Find the artist row that matches a show. Match is case-insensitive against
// name and aliases — same logic the Artists page uses to find shows.
function findArtistForShow(show, artists) {
  if (!show || !artists?.length) return null;
  const key = String(show.artist || show.eventName || '').trim().toLowerCase();
  if (!key) return null;
  for (const a of artists) {
    const name = String(a.name || '').trim().toLowerCase();
    if (!name) continue;
    if (name === key) return a;
    const aliases = String(a.aliases || '').split(',').map(s => s.trim().toLowerCase());
    if (aliases.includes(key)) return a;
    if (name && (key.includes(name) || name.includes(key))) return a;
  }
  return null;
}

function pickArtistDefaults(artist) {
  if (!artist) return {};
  const out = {};
  for (const k of ARTIST_DEFAULT_FIELDS) {
    if (artist[k] && String(artist[k]).trim()) out[k] = artist[k];
  }
  // Fall back to the artist's legacy contact fields when the advance-specific
  // ones aren't filled in.
  if (!out.advanceContact && artist.contactName) out.advanceContact = artist.contactName;
  if (!out.advanceEmail   && artist.contactEmail) out.advanceEmail  = artist.contactEmail;
  if (!out.advancePhone   && artist.contactPhone) out.advancePhone  = artist.contactPhone;
  return out;
}

// Enriched GET /api/advancing — each row gets `artistDefaults` and `artistId`
// so the UI can show artist-level fallbacks without a second fetch.
app.get('/api/advancing', requireAuth, async (req, res) => {
  try {
    const [advances, shows, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    const showMap = new Map(shows.map(s => [s.id, s]));
    const data = advances.map(a => {
      const show   = showMap.get(a.showId);
      const artist = findArtistForShow(show, artists);
      return {
        ...a,
        artistId:       artist?.id || '',
        artistName:     artist?.name || '',
        artistDefaults: pickArtistDefaults(artist),
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

crudRoutes(app, '/api/advancing',       'advancing', ['admin','production_manager','stage_manager','promoter','venue_management']);

// Ensure a show's day-sheet has the standard timeline seeded.
// Idempotent — safe to call on every visit. Backfills shows created before
// the auto-seed hook was added.
app.post('/api/schedule/ensure-defaults', requireAuth, async (req, res) => {
  try {
    const { showId } = req.body || {};
    if (!showId) return res.status(400).json({ success: false, message: 'showId is required' });
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show = shows.find(s => String(s.id) === String(showId));
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
    const seeded = await seedDaySheetForShow(show);
    const renamed = seeded === 0 ? await backfillDaySheetLabels(show) : 0;
    res.json({ success: true, seeded, renamed });
  } catch (err) {
    console.error('[schedule/ensure-defaults]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Venue defaults (stage capacities + day-sheet times) ────────────────────
// GET is readable by any authed user (the UI needs capacity for progress
// bars). PUT is admin-only.
app.get('/api/settings/venue', requireAuth, async (req, res) => {
  try {
    const venue = await getVenueDefaults();
    res.json({
      success: true,
      data: venue,
      meta: {
        daySheetItems: DAY_SHEET_TEMPLATE.map(it => ({ key: it.key, label: it.label })),
      },
    });
  } catch (err) {
    console.error('[settings/venue GET]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/settings/venue', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const saved = await setVenueDefaults(req.body || {});
    res.json({ success: true, data: saved });
  } catch (err) {
    console.error('[settings/venue PUT]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

crudRoutes(app, '/api/schedule',        'schedule',  ['admin','production_manager','venue_management','promoter']);
crudRoutes(app, '/api/labor',           'labor',     ['admin','production_manager','stage_manager'], { afterCreate: notifyShiftAssigned });

// ── Per-show call sheet (contacts) ────────────────────────────────────────
// A real advance is coordinated across a dozen or more contacts. Standardized
// roles make the brief able to spot missing critical seats (e.g. no Tour PM
// listed) and let the print packet render a clean call sheet.
const SHOW_CONTACT_ROLES = Object.freeze([
  'Tour Manager', 'Tour Production Manager', 'Tour Accountant',
  'Artist Management', 'Booking Agent',
  'Promoter Rep', 'Promoter Runner',
  'FOH Engineer', 'Monitor Engineer', 'Lighting Designer', 'Backline Tech',
  'Bus Driver', 'Truck Driver',
  'Venue Production Manager', 'Venue Stage Manager', 'House Sound',
  'House Lighting', 'Local Crew Steward',
  'Security Chief', 'Medic', 'Box Office', 'Merch Lead', 'Catering Lead',
  'Runner', 'Other',
]);
app.get('/api/show-contact-roles', requireAuth, (_req, res) => {
  res.json({ success: true, data: SHOW_CONTACT_ROLES });
});
crudRoutes(app, '/api/show-contacts', 'showContacts',
  ['admin','production_manager','stage_manager','venue_management']);

// ── Waiting-on tracker (ShowAsks) ────────────────────────────────────────
// Explicit, PM-controlled log of "asked X for Y". Rows the PM creates are
// FACTs (they typed them). AI can propose asks from email intel; those enter
// with source='ai-proposed' and status='open' and require no separate
// approval step because they don't touch authoritative rows — but the PM can
// dismiss or edit any of them at will.
crudRoutes(app, '/api/show-asks',      'showAsks',
  ['admin','production_manager','stage_manager','venue_management']);

// Stage managers can create/edit maintenance items and project proposals, but
// only admin / production_manager may approve, reject, or delete them.
const APPROVAL_STATUSES = new Set(['approved', 'rejected']);
app.put('/api/maintenance/:id', requireAuth, (req, res, next) => {
  const role = req.user?.role;
  if (role === 'stage_manager') {
    if (req.body && APPROVAL_STATUSES.has(req.body.status)) {
      return res.status(403).json({ success: false, message: 'Only admin or production manager can approve or reject.' });
    }
    if (req.body && (req.body.approvedBy || req.body.approvedAt)) {
      return res.status(403).json({ success: false, message: 'Only admin or production manager can stamp approval.' });
    }
  }
  next();
});
crudRoutes(app, '/api/maintenance',     'maintenance',    ['admin','production_manager','stage_manager'], {
  deleteRoles: ['admin','production_manager'],
});
crudRoutes(app, '/api/budgets',         'budgets',        ['admin','production_manager']);
crudRoutes(app, '/api/vendors',         'vendors');
crudRoutes(app, '/api/vendor-bookings', 'vendorBookings');
crudRoutes(app, '/api/settlement',      'settlement');
crudRoutes(app, '/api/unavailability',  'unavailability', ['admin','production_manager']);

// ── Venue Intelligence ──────────────────────────────────────────────────────
// Persistent venue knowledge: permanent RULES (what the building can/can't do)
// and historical OBSERVATIONS (patterns we've seen across shows). This is the
// venue-scoped tier of the AI knowledge system. It is deliberately kept
// separate from advance/schedule data — those are current-show facts, not
// venue capabilities. See venueKnowledge.js for the taxonomy and the safety
// rule: `analyzeCapability` never fabricates missing information.
const venueKnowledge = require('./venueKnowledge');
const VENUE_WRITE_ROLES = ['admin','production_manager','venue_management'];
// Internal-staff roles that may read AI content (email excerpts, audit logs,
// proposals, briefs). Promoters and crew NEVER see raw AI content.
const AI_READ_ROLES = ['admin','production_manager','stage_manager','venue_management'];
// Roles that may read the AI change-log and correction audit trails.
const AI_AUDIT_ROLES = ['admin','production_manager'];

// Per-show ACL. Admin/PM/venue_management/stage_manager see every show.
// Promoters see shows they booked (Shows.promoter matches their name or
// email). Crew see shows they're scheduled on (Labor row for that show).
// Used to gate per-show AI reads so a promoter can view the brief for
// THEIR show without also seeing every other show in the workspace.
async function canUserAccessShow(user, showId) {
  if (!user || !showId) return false;
  const role = user.role || '';
  if (['admin','production_manager','stage_manager','venue_management'].includes(role)) return true;
  const shows = await sheets.getRows(config.googleSheets.sheets.shows);
  const show = shows.find(s => String(s.id) === String(showId));
  if (!show) return false;
  const name  = String(user.name  || '').trim().toLowerCase();
  const email = String(user.email || '').trim().toLowerCase();
  if (role === 'promoter') {
    const promoterField = String(show.promoter || '').trim().toLowerCase();
    if (!promoterField) return false;
    return (name  && promoterField.includes(name))
        || (email && promoterField.includes(email));
  }
  if (role === 'crew') {
    const labor = await sheets.getRows(config.googleSheets.sheets.labor);
    return labor.some(l =>
      String(l.showId) === String(showId) && (
        (name  && String(l.workerName || '').toLowerCase().includes(name)) ||
        (user.staffId && String(l.staffId || '') === String(user.staffId))
      )
    );
  }
  return false;
}

// Express middleware version — reads showId from route params. Attach after
// `requireAuth` on any per-show AI read endpoint that should be scoped.
function requireShowAccess(req, res, next) {
  const showId = req.params.showId || req.query.showId || '';
  if (!showId) return res.status(400).json({ success: false, message: 'showId required' });
  canUserAccessShow(req.user, showId).then(ok => {
    if (!ok) return res.status(403).json({ success: false, message: 'No access to this show' });
    next();
  }).catch(err => res.status(500).json({ success: false, message: err.message }));
}

app.get('/api/venue-knowledge', requireAuth, async (req, res) => {
  try {
    const filter = {};
    for (const k of ['kind','category','subcategory','scope','status','subject','attributePath']) {
      if (req.query[k]) filter[k] = String(req.query[k]);
    }
    const items = await venueKnowledge.listAll(filter);
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/venue-knowledge/observations', requireAuth, async (req, res) => {
  try {
    const items = await venueKnowledge.getObservations({
      subject:       req.query.subject       || null,
      attributePath: req.query.attributePath || null,
      category:      req.query.category      || null,
    });
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/venue-knowledge/:id', requireAuth, async (req, res) => {
  try {
    const item = await venueKnowledge.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/venue-knowledge/:id/history', requireAuth, async (req, res) => {
  try {
    const history = await venueKnowledge.getHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/venue-knowledge', requireAuth, requireRole(...VENUE_WRITE_ROLES), async (req, res) => {
  try {
    const item = await venueKnowledge.createItem(req.body || {}, req.user.id);
    res.json({ success: true, data: item });
  } catch (err) {
    const status = err.code === 'validation' ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

app.put('/api/venue-knowledge/:id', requireAuth, requireRole(...VENUE_WRITE_ROLES), async (req, res) => {
  try {
    const item = await venueKnowledge.updateItem(req.params.id, req.body || {}, req.user.id, (req.body || {}).note);
    res.json({ success: true, data: item });
  } catch (err) {
    const status = err.code === 'not_found' ? 404
                 : err.code === 'validation' || err.code === 'invalid_state' ? 400
                 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

app.delete('/api/venue-knowledge/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const item = await venueKnowledge.archiveItem(req.params.id, req.user.id, req.query.note || '');
    res.json({ success: true, data: item });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// Ask the venue: "Can we do X?" — Returns a structured comparison of the
// tour's request against what the venue can actually provide. Refuses to
// guess: when there's no rule on file it returns matches:'unknown'.
app.post('/api/venue-knowledge/analyze', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const result = await venueKnowledge.analyzeCapability(req.body || {});
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Email Intelligence ──────────────────────────────────────────────────────
// Reads production email threads as CONVERSATIONS. Extracts structured facts
// with provenance, detects supersession, questions, deadlines, conflicts, and
// stages every change as a PROPOSAL for PM review. Nothing is auto-applied.
// See emailIntelligence.js for the full contract.
const emailIntel = require('./emailIntelligence');
// Real LLM-backed extractor (Anthropic by default). Falls back to rules-v1
// when unconfigured or on any provider failure. Same Analysis shape.
const productionExtractor = require('./productionExtractor');
// Maps approved AI facts back into the existing Shows/Advancing/Schedule forms
// and writes to the immutable AiChangeLog audit trail.
const factMapping = require('./factMapping');

// Admin-only LLM status. Never returns the API key value — only whether the
// backend is configured, the provider/model, and a masked preview for
// human identification.
app.get('/api/llm/status', requireAuth, requireRole('admin'), (_req, res) => {
  try {
    const { publicStatus } = require('./llm/configCheck');
    res.json({ success: true, data: publicStatus() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Live-concert industry knowledge ontology + venue-extensible rules.
// Six-tier stratified knowledge model. Never fabricates values.
const industry = require('./industryKnowledge');

// Corrections log + candidate knowledge review. Repeated corrections become
// candidate rules that require PM authorization before promotion.
const learning = require('./learningSystem');

// Assembles the 12-section PM Show Brief. Deterministic, fully source-linked.
const showBrief = require('./showBrief');
const showPacket = require('./showPacket');

// ── Printable show packet ────────────────────────────────────────────────
// Zero-AI, source-of-truth packet a PM prints Friday afternoon. Composed
// from Shows + Advancing + Schedule + Labor + ShowContacts + ShowAsks +
// ArtistDocuments only. Per-show gated.
app.get('/api/show-packet/:showId', requireAuth, requireShowAccess, async (req, res) => {
  try {
    const data = await showPacket.buildPacketData(req.params.showId);
    const html = showPacket.renderPacketHtml(data);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    if (err.code === 'not_found') return res.status(404).send('Show not found.');
    console.error('[show-packet]', err);
    res.status(500).send('Error building show packet: ' + err.message);
  }
});

// Analyze an ad-hoc thread (messages posted in the request). No writes.
// Body: { messages: [...], shows?: [...], existingShowData?: {...}, threadContext?: {...} }
app.post('/api/email-intel/analyze', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    let { messages = [], shows, existingShowData, threadContext } = req.body || {};
    if (!Array.isArray(shows)) shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const analysis = await productionExtractor.extractOrFallback({
      messages, shows, existingShowData,
      showId: threadContext?.showId || null,
      config: config.llm,
    });
    res.json({ success: true, data: analysis });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Analyze an existing Gmail thread and stage its facts as proposals. PM only.
app.post('/api/email-intel/analyze-gmail-thread', requireAuth, requireRole('admin','production_manager','stage_manager'), async (req, res) => {
  try {
    const { threadId } = req.body || {};
    if (!threadId) return res.status(400).json({ success: false, message: 'threadId required' });

    const client = await gmail.getGmailClientForToken(req.user.id).catch(() => null);
    if (!client) return res.status(400).json({ success: false, message: 'Gmail not connected for this user' });

    const thread = await client.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    const messages = (thread.data.messages || []).map(m => {
      const parsed = gmail.parseMessage(m);
      return {
        id:        parsed.gmailMessageId,
        threadId:  parsed.gmailThreadId,
        from:      parsed.from,
        subject:   parsed.subject,
        date:      parsed.date,
        body:      parsed.textBody || parsed.htmlBody.replace(/<[^>]+>/g, ' '),
      };
    });
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const analysis = await productionExtractor.extractOrFallback({ messages, shows, config: config.llm });
    const written  = await emailIntel.proposeFromAnalysis(analysis, { actor: 'user:' + req.user.id });
    res.json({ success: true, data: { analysis, written } });
  } catch (err) {
    console.error('[email-intel gmail]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Stage a manually-supplied analysis (or its underlying messages) as proposals.
app.post('/api/email-intel/propose', requireAuth, requireRole('admin','production_manager','stage_manager'), async (req, res) => {
  try {
    let { analysis, messages, shows } = req.body || {};
    if (!analysis) {
      if (!Array.isArray(shows)) shows = await sheets.getRows(config.googleSheets.sheets.shows);
      analysis = await productionExtractor.extractOrFallback({ messages: messages || [], shows, config: config.llm });
    }
    const written = await emailIntel.proposeFromAnalysis(analysis, { actor: 'user:' + req.user.id });
    res.json({ success: true, data: written });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Review queue: proposed facts awaiting decision.
app.get('/api/email-intel/queue', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const items = await emailIntel.listQueue({
      status:   req.query.status || 'proposed',
      showId:   req.query.showId || null,
      threadId: req.query.threadId || null,
    });
    // Optional inline preview so the UI can render the FIELD/CURRENT/PROPOSED/
    // SOURCE/CONFIDENCE/REASON/STATUS row without an extra round-trip per fact.
    if (req.query.withPreview === '1') {
      const previews = await Promise.all(items.map(f => factMapping.preview(f).catch(err => ({ error: err.message }))));
      const merged = items.map((f, i) => ({ fact: f, preview: previews[i] }));
      return res.json({ success: true, data: merged });
    }
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/email-intel/facts/:id', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const fact = await emailIntel.getFactById(req.params.id);
    if (!fact) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: fact });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Field-diff preview: FIELD / CURRENT / PROPOSED / SOURCE / CONFIDENCE / REASON / STATUS.
app.get('/api/email-intel/facts/:id/preview', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const fact = await emailIntel.getFactById(req.params.id);
    if (!fact) return res.status(404).json({ success: false, message: 'Not found' });
    const preview = await factMapping.preview(fact);
    res.json({ success: true, data: preview });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/email-intel/facts/:id/approve', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    const body = req.body || {};
    const note = body.note || '';
    let fact = await emailIntel.approveFact(req.params.id, 'user:' + req.user.id, note);
    // If the PM overrode the proposed value, log it as a correction BEFORE
    // applying — the corrected value is what actually goes to the form.
    if (body.correctedValue !== undefined && !valuesEqualLoose(body.correctedValue, fact.newValue)) {
      const shows = await sheets.getRows(config.googleSheets.sheets.shows);
      const show = shows.find(s => s.id === fact.showId) || {};
      await learning.logCorrection({
        showId: fact.showId, showDate: show.date || '',
        venue: show.venue || '', promoter: show.promoter || '', artist: show.artist || '',
        tourName: show.tour || '',
        factId: fact.id, field: fact.field, source: 'email:' + (fact.threadId || ''),
        aiValue: fact.newValue, correctedValue: body.correctedValue,
        correctionType: body.correctionType || 'SHOW_SPECIFIC',
        reason: body.reason || '', note,
      }, req.user);
      fact = { ...fact, newValue: body.correctedValue };
    }
    const applied = await factMapping.applyApprovedFact(fact, req.user, { note });
    res.json({ success: true, data: { fact, applied } });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

function valuesEqualLoose(a, b) {
  if (a === b) return true;
  return String(a ?? '') === String(b ?? '');
}

// Batch approval — LOW-RISK, no-conflict, mapped facts only. Anything else
// is rejected up-front with a per-fact reason so the UI can surface it.
app.post('/api/email-intel/facts/batch-approve', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    const ids  = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const note = req.body?.note || '';
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'no ids' });

    const results = [];
    for (const id of ids) {
      try {
        const fact = await emailIntel.getFactById(id);
        if (!fact) { results.push({ id, ok: false, reason: 'not_found' }); continue; }
        const preview = await factMapping.preview(fact);
        if (!factMapping.eligibleForBatch(preview)) {
          // Spec: high-risk changes MUST NOT be batch-approvable. Refuse.
          results.push({ id, ok: false, reason: 'not_eligible_for_batch', risk: preview.risk, status: preview.status });
          continue;
        }
        const approved = await emailIntel.approveFact(id, 'user:' + req.user.id, note);
        const applied  = await factMapping.applyApprovedFact(approved, req.user, { note });
        results.push({ id, ok: true, applied });
      } catch (err) {
        results.push({ id, ok: false, reason: 'error', message: err.message });
      }
    }
    res.json({ success: true, data: results });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/email-intel/facts/:id/reject', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    const out = await emailIntel.rejectFact(req.params.id, 'user:' + req.user.id, (req.body || {}).note || '');
    res.json({ success: true, data: out });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// AI change audit log — every fact approval writes here. Never edited/deleted.
app.get('/api/ai-changes', requireAuth, requireRole(...AI_AUDIT_ROLES), async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.aiChangeLog);
    const filtered = rows.filter(r =>
      (!req.query.showId || r.showId === req.query.showId) &&
      (!req.query.status || r.status === req.query.status),
    );
    // Newest first
    filtered.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    res.json({ success: true, data: filtered });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Industry Knowledge Layer ────────────────────────────────────────────────
// Stratified domain ontology + venue-extensible rules. Never invents values.

app.get('/api/industry/domains', requireAuth, (req, res) => {
  res.json({ success: true, data: industry.listDomains() });
});

app.get('/api/industry/concepts', requireAuth, (req, res) => {
  res.json({ success: true, data: industry.listConcepts({ domain: req.query.domain }) });
});

app.get('/api/industry/concepts/:id', requireAuth, (req, res) => {
  const c = industry.getConcept(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'concept not found' });
  res.json({ success: true, data: c });
});

app.get('/api/industry/workflows', requireAuth, (req, res) => {
  res.json({ success: true, data: industry.listWorkflows() });
});

app.get('/api/industry/workflows/:id', requireAuth, (req, res) => {
  const w = industry.getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ success: false, message: 'workflow not found' });
  res.json({ success: true, data: w });
});

app.get('/api/industry/requirements/:domain', requireAuth, (req, res) => {
  res.json({ success: true, data: industry.informationRequirements(req.params.domain) });
});

// Context-aware term resolution. Body: { term, context? }.
app.post('/api/industry/resolve', requireAuth, async (req, res) => {
  try {
    const { term, context = '' } = req.body || {};
    if (!term) return res.status(400).json({ success: false, message: 'term required' });
    const userRules = await industry.loadUserRules();
    const result = industry.resolveTerm(term, { context, userRules });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// User-instructed ontology rules — the venue's local layer above industry standard.
app.get('/api/industry/user-rules', requireAuth, async (req, res) => {
  try {
    await industry.ensureUserRulesSheet();
    const rules = await industry.loadUserRules();
    res.json({ success: true, data: rules });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/industry/user-rules', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    await industry.ensureUserRulesSheet();
    const row = await industry.addUserRule(req.body || {}, req.user);
    res.json({ success: true, data: row });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

app.patch('/api/industry/user-rules/:id', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    const row = await industry.updateUserRule(req.params.id, req.body || {}, req.user);
    res.json({ success: true, data: row });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

app.delete('/api/industry/user-rules/:id', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    await industry.deleteUserRule(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

// ── Learning / Correction System ────────────────────────────────────────────
// Every PM correction is recorded here. Repeated corrections become
// candidate knowledge that must be authorized before promotion to VenueKnowledge.

app.post('/api/corrections', requireAuth, requireRole('admin','production_manager','stage_manager'), async (req, res) => {
  try {
    await learning.ensureSheets();
    const row = await learning.logCorrection(req.body || {}, req.user);
    res.json({ success: true, data: row });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

app.get('/api/corrections', requireAuth, requireRole(...AI_AUDIT_ROLES), async (req, res) => {
  try {
    const rows = await learning.listCorrections({
      showId: req.query.showId,
      field: req.query.field,
      correctionType: req.query.correctionType,
    });
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/corrections/scan', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    await learning.ensureSheets();
    const opts = {
      minOccurrences: Number(req.body?.minOccurrences) || 3,
      minShows:       Number(req.body?.minShows)       || 2,
    };
    const result = await learning.scanForPatterns(opts);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/knowledge-candidates', requireAuth, requireRole(...AI_AUDIT_ROLES), async (req, res) => {
  try {
    const rows = await learning.listCandidates({ status: req.query.status });
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/knowledge-candidates/:id/review', requireAuth, requireRole('admin','production_manager'), async (req, res) => {
  try {
    const { action, ...patch } = req.body || {};
    if (!action) return res.status(400).json({ success: false, message: 'action required' });
    const result = await learning.reviewCandidate(req.params.id, action, patch, req.user);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ── Show Brief — the PM's AI workspace for one show ─────────────────────────
app.get('/api/show-brief/:showId', requireAuth, requireShowAccess, async (req, res) => {
  try {
    const brief = await showBrief.buildBrief(req.params.showId, { since: req.query.since });
    res.json({ success: true, data: brief });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// Thread rows (assignment + participants), and their issue list.
app.get('/api/email-intel/threads', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.emailThreads);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/email-intel/issues', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.emailIssues);
    const filtered = rows.filter(r =>
      (!req.query.threadId || r.threadId === req.query.threadId) &&
      (!req.query.showId   || r.showId   === req.query.showId) &&
      (!req.query.status   || r.status   === req.query.status),
    );
    res.json({ success: true, data: filtered });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Show Advancement Intelligence ────────────────────────────────────────────
// Stateless engine that composes show + advance + schedule + labor + vendor
// bookings + approved email facts + venue knowledge into a per-show operational
// readiness report. See advancementEngine.js for the full contract.
const advancementEngine = require('./advancementEngine');

app.get('/api/advancement/dashboard', requireAuth, requireRole(...AI_READ_ROLES), async (req, res) => {
  try {
    const upcomingOnly = req.query.all !== '1';
    const summary = await advancementEngine.dashboardSummary({ upcomingOnly });
    res.json({ success: true, data: summary });
  } catch (err) {
    console.error('[advancement dashboard]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/advancement/:showId', requireAuth, requireShowAccess, async (req, res) => {
  try {
    const state = await advancementEngine.buildShowState(req.params.showId);
    const result = await advancementEngine.evaluate(state);
    res.json({ success: true, data: result });
  } catch (err) {
    if (err.code === 'not_found') return res.status(404).json({ success: false, message: 'show_not_found' });
    console.error('[advancement show]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/advancement/:showId/priorities', requireAuth, requireShowAccess, async (req, res) => {
  try {
    const state = await advancementEngine.buildShowState(req.params.showId);
    const result = await advancementEngine.evaluate(state);
    res.json({ success: true, data: {
      status: result.status,
      priorities: result.priorities,
      recommendedActions: result.recommendedActions,
    } });
  } catch (err) {
    if (err.code === 'not_found') return res.status(404).json({ success: false, message: 'show_not_found' });
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/advancement/:showId/rules', requireAuth, requireShowAccess, async (req, res) => {
  try {
    // Full rule catalog + applies/because for THIS show, so the PM can see
    // exactly why each requirement did or did not fire.
    const state = await advancementEngine.buildShowState(req.params.showId);
    const audit = [];
    for (const rule of advancementEngine.RULES) {
      const app = await Promise.resolve(rule.applies(state));
      audit.push({
        id: rule.id, category: rule.category, tier: rule.tier, title: rule.title,
        applies: !!(app && app.applies),
        because: app && app.applies ? app.because : null,
      });
    }
    res.json({ success: true, data: audit });
  } catch (err) {
    if (err.code === 'not_found') return res.status(404).json({ success: false, message: 'show_not_found' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Email Templates ──────────────────────────────────────────────────────────
// Reusable email templates with {{merge-tag}} placeholders and auto-resolving
// attachment recipes (e.g. "attach the venue tech pack for this show's stage").
// Rendered against a show + advance record at send time.

const EMAIL_TEMPLATE_DEFAULTS = [
  {
    name: 'Advance — Ask promoter for tour contact',
    description: 'When we don\'t yet have a tour advance contact, ping the promoter for one.',
    category: 'advance',
    subject: 'Advance contact for {{artist}} — {{date}} @ The Windjammer',
    body:
`<p>Hey {{promoter}},</p>
<p>Reaching out to start the advance for <strong>{{artist}}</strong> on <strong>{{date_long}}</strong> at The Windjammer ({{stage_label}}).</p>
<p>Could you point me to the tour's advance contact — name, email, phone — or forward this along to them? Happy to take it from there.</p>
<p>Thanks,<br/>{{sender.name}}<br/>The Windjammer</p>`,
    attachments: [],
  },
  {
    name: 'Advance — Initiate with tour',
    description: 'Kick off the advance with the known tour contact; attaches the full stage tech pack.',
    category: 'advance',
    subject: 'Advance — {{artist}} at The Windjammer, {{date_long}}',
    body:
`<p>Hi {{advanceContact}},</p>
<p>Reaching out to start the advance for <strong>{{artist}}</strong> at The Windjammer on <strong>{{date_long}}</strong> ({{stage_label}}, doors {{doors}}, show {{showTime}}).</p>
<p>Attached is our venue tech pack for the {{stage_label}}. When you have a moment, please send over:</p>
<ul>
  <li>Current technical and hospitality riders</li>
  <li>Input list and stage plot</li>
  <li>Preferred set times / any curfew notes</li>
  <li>Load-in / parking / bus and trailer needs</li>
</ul>
<p>Happy to jump on a call if easier. Looking forward to a great show.</p>
<p>Best,<br/>{{sender.name}}<br/>The Windjammer</p>`,
    attachments: [
      { type: 'techpack-pdf', stage: 'auto', label: 'Current tech pack PDF for the show\'s stage' },
    ],
  },
  {
    name: 'Advance — Reply to inbound tour',
    description: 'Warm reply when a tour reaches out first to start advancing.',
    category: 'advance',
    subject: 'Re: Advance — {{artist}} @ The Windjammer {{date}}',
    body:
`<p>Hi {{advanceContact}},</p>
<p>Thanks for reaching out — happy to lock this in. Confirming <strong>{{artist}}</strong> at The Windjammer on <strong>{{date_long}}</strong> ({{stage_label}}).</p>
<p>Attached is our current tech pack for the {{stage_label}}. When you have a chance, please send over the tour's most recent rider, input list, and stage plot and we'll get everything lined up on our end.</p>
<p>Talk soon,<br/>{{sender.name}}<br/>The Windjammer</p>`,
    attachments: [
      { type: 'techpack-pdf', stage: 'auto', label: 'Current tech pack PDF for the show\'s stage' },
    ],
  },
];

let _emailTemplatesSeeded = false;
async function seedDefaultEmailTemplatesIfEmpty() {
  if (_emailTemplatesSeeded) return 0;
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.emailTemplates);
    if (rows.length > 0) { _emailTemplatesSeeded = true; return 0; }
    const now = new Date().toISOString();
    let n = 0;
    for (const d of EMAIL_TEMPLATE_DEFAULTS) {
      await sheets.appendRow(config.googleSheets.sheets.emailTemplates, {
        id: `tpl_${Date.now()}_${++n}`,
        name: d.name, description: d.description, category: d.category,
        subject: d.subject, body: d.body,
        attachments: JSON.stringify(d.attachments || []),
        createdBy: 'system', createdAt: now, updatedAt: now,
      });
    }
    _emailTemplatesSeeded = true;
    return n;
  } catch (err) {
    console.warn('[email-templates seed] skipped:', err.message);
    return 0;
  }
}

// Custom GET runs before crudRoutes so we can lazy-seed defaults on first read.
app.get('/api/email-templates', requireAuth, async (req, res) => {
  try {
    await seedDefaultEmailTemplatesIfEmpty();
    const rows = await sheets.getRows(config.googleSheets.sheets.emailTemplates);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

crudRoutes(app, '/api/email-templates', 'emailTemplates', ['admin','production_manager']);

// Format a YYYY-MM-DD as e.g. "Tuesday, October 14, 2026".
function formatLongDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}
function escapeHtmlSafe(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Build the merge-tag map for a template rendered against a show + advance.
async function buildTemplateVars(showId, user) {
  const shows = await sheets.getRows(config.googleSheets.sheets.shows);
  const show  = shows.find(s => String(s.id) === String(showId)) || {};
  const advances = await sheets.getRows(config.googleSheets.sheets.advancing).catch(() => []);
  const advance  = advances.find(a => String(a.showId) === String(showId)) || {};
  const artists  = await sheets.getRows(config.googleSheets.sheets.artists).catch(() => []);
  const nameKey  = String(show.artist || '').toLowerCase().trim();
  const artist   = artists.find(a => String(a.name || '').toLowerCase().trim() === nameKey) || {};

  const stageLabel = show.stage === 'beach' ? 'Beach Stage' : 'Inside Stage';
  return {
    show, advance, artist,
    vars: {
      'artist':         show.artist || show.eventName || '',
      'eventName':      show.eventName || show.artist || '',
      'date':           show.date || '',
      'date_long':      formatLongDate(show.date),
      'stage':          show.stage || '',
      'stage_label':    stageLabel,
      'doors':          show.doorsTime || '',
      'showTime':       show.showTime  || '',
      'curfew':         advance.curfew || '',
      'capacity':       show.capacity  || '',
      'promoter':       show.promoter  || '',
      'tourManager':    show.tourManager || '',
      'advanceContact': advance.advanceContact || artist.advanceContact || 'there',
      'advanceEmail':   advance.advanceEmail   || artist.advanceEmail   || '',
      'advancePhone':   advance.advancePhone   || artist.advancePhone   || '',
      'venue':          'The Windjammer',
      'sender.name':    user?.name  || '',
      'sender.email':   user?.email || '',
    },
  };
}
function fillTemplate(str, vars) {
  return String(str || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });
}

// Resolve one attachment recipe into a real { filename, mimeType, data } payload.
async function resolveAttachmentSpec(spec, show) {
  if (!spec || !spec.type) return null;
  if (spec.type === 'techpack-section' || spec.type === 'techpack-full') {
    const stage = spec.stage === 'auto' || !spec.stage ? (show.stage || 'inside') : spec.stage;
    const rows = await sheets.getRows(config.googleSheets.sheets.techpack).catch(() => []);
    const doc  = rows.find(d => d.stage === stage);
    if (!doc) return null;
    let sections = [];
    try { sections = typeof doc.sections === 'string' ? JSON.parse(doc.sections || '[]') : (doc.sections || []); }
    catch { sections = []; }
    const stageLabel = stage === 'beach' ? 'Beach Stage' : 'Inside Stage';
    let inner, filename;
    if (spec.type === 'techpack-full') {
      const parts = sections
        .filter(s => (s.content || '').trim())
        .map(s => `<h2>${escapeHtmlSafe((s.icon || '') + ' ' + s.title)}</h2>${s.content}`);
      if (parts.length === 0) return null;
      inner = parts.join('<hr/>');
      filename = `${stageLabel} — Full Tech Pack.html`;
    } else {
      const section = sections.find(s => s.key === spec.section);
      if (!section || !(section.content || '').trim()) return null;
      inner = `<h1>${escapeHtmlSafe((section.icon || '') + ' ' + section.title)}</h1>${section.content}`;
      filename = `${stageLabel} — ${section.title}.html`;
    }
    const wrapped =
`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtmlSafe(filename)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:8.5in;margin:0.5in auto;color:#111}h1,h2{border-bottom:1px solid #ccc;padding-bottom:6px}img{max-width:100%;height:auto}</style>
</head><body>${inner}</body></html>`;
    return {
      filename,
      mimeType: 'text/html',
      data: Buffer.from(wrapped, 'utf8').toString('base64'),
    };
  }
  if (spec.type === 'techpack-pdf') {
    try {
      const stage = spec.stage === 'auto' || !spec.stage ? (show.stage || 'inside') : spec.stage;
      const rows = await sheets.getRows(config.googleSheets.sheets.techpack).catch(() => []);
      const doc  = rows.find(d => d.stage === stage && d.docType === 'stage');
      if (!doc || !doc.pdfFileId) return null;
      const drive = await sheets.getDriveClient();
      const bin = await drive.files.get({ fileId: doc.pdfFileId, alt: 'media' }, { responseType: 'arraybuffer' });
      return {
        filename: doc.pdfFilename || 'tech-pack.pdf',
        mimeType: doc.pdfMimeType || 'application/pdf',
        data: Buffer.from(bin.data).toString('base64'),
      };
    } catch (err) {
      console.warn('[resolveAttachmentSpec techpack-pdf]', err.message);
      return null;
    }
  }
  if (spec.type === 'drive-file' && spec.fileId) {
    try {
      const drive = await sheets.getDriveClient();
      const meta  = await drive.files.get({ fileId: spec.fileId, fields: 'name,mimeType' });
      const bin   = await drive.files.get({ fileId: spec.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      return {
        filename: spec.filename || meta.data.name || 'attachment',
        mimeType: spec.mimeType || meta.data.mimeType || 'application/octet-stream',
        data: Buffer.from(bin.data).toString('base64'),
      };
    } catch (err) {
      console.warn('[resolveAttachmentSpec drive-file]', err.message);
      return null;
    }
  }
  if (spec.type === 'artist-doc' && spec.docType) {
    try {
      const artists = await sheets.getRows(config.googleSheets.sheets.artists).catch(() => []);
      const nameKey = String(show.artist || '').toLowerCase().trim();
      const artist  = artists.find(a => String(a.name || '').toLowerCase().trim() === nameKey);
      if (!artist) return null;
      const docs = await sheets.getRows(config.googleSheets.sheets.artistDocuments).catch(() => []);
      const matches = docs
        .filter(d => d.artistId === artist.id && d.type === spec.docType && d.driveFileId)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const doc = matches[0];
      if (!doc) return null;
      const drive = await sheets.getDriveClient();
      const bin = await drive.files.get({ fileId: doc.driveFileId, alt: 'media' }, { responseType: 'arraybuffer' });
      return {
        filename: doc.name || `${spec.docType}.bin`,
        mimeType: doc.mimeType || 'application/octet-stream',
        data: Buffer.from(bin.data).toString('base64'),
      };
    } catch (err) {
      console.warn('[resolveAttachmentSpec artist-doc]', err.message);
      return null;
    }
  }
  return null;
}

// Render a template against a show — returns { subject, body, attachments, previewOnly? }.
app.post('/api/email-templates/:id/render', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.emailTemplates);
    const tpl  = rows.find(t => String(t.id) === String(req.params.id));
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });

    const { showId } = req.body || {};
    if (!showId) return res.status(400).json({ success: false, message: 'showId is required' });

    const { vars, show } = await buildTemplateVars(showId, req.user);
    const subject = fillTemplate(tpl.subject, vars);
    const body    = fillTemplate(tpl.body,    vars);

    let specs = [];
    try { specs = typeof tpl.attachments === 'string' ? JSON.parse(tpl.attachments || '[]') : (tpl.attachments || []); }
    catch { specs = []; }

    const skipAttachments = req.body?.skipAttachments === true;
    const attachments = [];
    const attachmentIssues = [];
    if (!skipAttachments) {
      for (const spec of specs) {
        const att = await resolveAttachmentSpec(spec, show);
        if (att) attachments.push(att);
        else attachmentIssues.push(spec.label || spec.type);
      }
    }
    res.json({ success: true, data: { subject, body, attachments, attachmentIssues } });
  } catch (err) {
    console.error('[email-templates render]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Artists: `staffNotes` is an internal-only field. Non-staff callers (currently
// just Promoter) never see it on GET and cannot set it on POST/PUT. Keep the
// role check in sync with client/src/utils/roles.js `isInternalStaff()`.
function isInternalStaffRole(role) {
  return !!role && role !== 'promoter';
}
app.get('/api/artists', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.artists);
    const data = isInternalStaffRole(req.user?.role)
      ? rows
      : rows.map(({ staffNotes, ...rest }) => rest);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
function stripArtistStaffNotesForNonStaff(req, res, next) {
  if (!isInternalStaffRole(req.user?.role) && req.body && typeof req.body === 'object') {
    delete req.body.staffNotes;
  }
  next();
}
app.post('/api/artists',      requireAuth, stripArtistStaffNotesForNonStaff, (req, res, next) => next());
app.put('/api/artists/:id',   requireAuth, stripArtistStaffNotesForNonStaff, (req, res, next) => next());

crudRoutes(app, '/api/artists',         'artists',        ['admin','production_manager','stage_manager','promoter'], { afterCreate: (row) => ensureArtistFolder(row.id) });
// Note: artist-documents writes go through the upload endpoint below (which handles Drive too).
// We expose only GET via crudRoutes-equivalent below to avoid orphaning Drive files on direct deletes.

// Staff: auto-provision a default user account when an admin adds a staff
// member with an email address. The account is created with a random unknown
// password and an invite token is emailed to the new hire so they can set
// their own password and complete their profile.
async function autoCreateUserForStaff(staff, req) {
  if (!staff?.email) return null;
  if (!['admin', 'production_manager'].includes(req.user?.role)) return null;
  try {
    const email = staff.email.trim().toLowerCase();
    const existingUsers = await sheets.getRows(config.googleSheets.sheets.users);
    if (existingUsers.some(u => (u.email || '').toLowerCase() === email)) {
      return null; // already has an account
    }
    // Create a placeholder account; the user will set their real password via the invite link.
    const placeholderHash = await bcrypt.hash(`pending-${Date.now()}-${Math.random()}`, 12);
    const user = {
      id:        Date.now().toString(),
      name:      staff.name || email.split('@')[0],
      email,
      role:      'crew',
      password:  placeholderHash,
      active:    'true',
      staffId:   staff.id,
      onboardingComplete: 'false',
      createdAt: new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.users, user);
    const inviteUrl = await sendInviteEmailIfPossible(user, staff, req);
    return { invited: { email, inviteUrl } };
  } catch (err) {
    console.error('[staff auto-user]', err.message);
    return null;
  }
}

// Determine the public base URL for invite links.
// Priority: PUBLIC_APP_URL env -> Railway public domain -> request host -> localhost.
function resolveAppBaseUrl(req) {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.get('host');
    if (host) return `${proto}://${host}`;
  }
  return `http://localhost:${config.port === 3001 ? 5173 : config.port}`;
}

// Build a signed invite token (7-day expiry) and return the onboarding URL.
function buildInviteUrl(user, req) {
  const token = jwt.sign({ uid: user.id, t: 'invite' }, config.jwtSecret, { expiresIn: '7d' });
  return `${resolveAppBaseUrl(req)}/onboard/${token}`;
}

// Send the invite email from the house mailbox if one is connected.
// Returns the invite URL whether or not the email was sent (admin can copy it).
async function sendInviteEmailIfPossible(user, staff, req) {
  const url = buildInviteUrl(user, req);
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const house = users.find(u => String(u.isHouseMailbox).toLowerCase() === 'true' && u.gmailRefreshToken);
    if (!house) {
      console.log(`[invite] No house mailbox configured. Share this link with ${user.email}: ${url}`);
      return url;
    }
    const client = gmail.getGmailClientForToken(house.gmailRefreshToken);
    const name = (user.name || '').split(' ')[0] || 'there';
    const appBase = resolveAppBaseUrl(req);
    const body = `
      <p>Hi ${name},</p>
      <p>Welcome to the Windjammer Production team! Please finish setting up your account by clicking the link below:</p>
      <p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Complete Your Profile</a></p>
      <p>Or copy and paste this URL into your browser:<br><code>${url}</code></p>
      <p>This link is valid for 7 days. You'll be asked to set a password and fill in a few details — once you log in successfully, you're all set.</p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <h3 style="margin:0 0 8px">Get the Windjammer app on your devices</h3>
      <p style="margin:0 0 8px">After you finish onboarding, you can access Windjammer any time at:<br>
        <a href="${appBase}">${appBase}</a>
      </p>
      <p style="margin:0 0 8px"><strong>Install it like an app</strong> (recommended):</p>
      <ul style="margin:0 0 8px;padding-left:20px">
        <li><strong>iPhone / iPad:</strong> Open the link in Safari → tap the Share button → <em>Add to Home Screen</em>.</li>
        <li><strong>Android:</strong> Open the link in Chrome → tap the ⋮ menu → <em>Install app</em> (or <em>Add to Home screen</em>).</li>
        <li><strong>Desktop (Chrome / Edge):</strong> Open the link → click the install icon (⊕) in the address bar, or use the ⋮ menu → <em>Install Windjammer</em>.</li>
      </ul>
      <p style="color:#6b7280;font-size:13px">Installing gives you a dedicated app icon and a full-screen experience — no app store required.</p>

      <p>— The Windjammer Production Team</p>
    `;
    await gmail.sendEmail({
      to: user.email,
      subject: 'Welcome to Windjammer — Complete Your Profile',
      body,
      client,
    });
    console.log(`[invite] Sent invite to ${user.email} (staff: ${staff?.id || '?'})`);
  } catch (err) {
    console.error(`[invite] Failed to email ${user.email}: ${err.message}. URL: ${url}`);
  }
  return url;
}

// POST /api/staff/:id/invite — resends an invite to an existing staff member.
app.post('/api/staff/:id/invite', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    const staff = staffRows.find(s => s.id === id);
    if (!staff)         return res.status(404).json({ success: false, message: 'Staff not found' });
    if (!staff.email)   return res.status(400).json({ success: false, message: 'Staff has no email on file' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    let user = users.find(u => (u.email || '').toLowerCase() === staff.email.toLowerCase());
    if (!user) {
      // Create the account on the fly so we always have something to invite.
      const placeholderHash = await bcrypt.hash(`pending-${Date.now()}-${Math.random()}`, 12);
      user = {
        id:        Date.now().toString(),
        name:      staff.name || staff.email.split('@')[0],
        email:     staff.email.toLowerCase(),
        role:      'crew',
        password:  placeholderHash,
        active:    'true',
        staffId:   staff.id,
        onboardingComplete: 'false',
        createdAt: new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.users, user);
    } else if (user.staffId !== staff.id) {
      // Backfill the link so onboarding updates the correct staff row.
      await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: staff.id });
      user.staffId = staff.id;
    }
    const inviteUrl = await sendInviteEmailIfPossible(user, staff, req);
    res.json({ success: true, inviteUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/onboard/:token — verify an invite token; return prefill data.
app.get('/api/onboard/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, config.jwtSecret);
    if (payload.t !== 'invite') return res.status(400).json({ success: false, message: 'Invalid invite link' });
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === payload.uid);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.onboardingComplete === 'true')
      return res.status(400).json({ success: false, message: 'Onboarding already complete. Please sign in normally.' });
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    const staff = staffRows.find(s => s.id === user.staffId) || {};
    res.json({
      success: true,
      prefill: {
        name:       user.name || staff.name || '',
        email:      user.email,
        phone:      staff.phone || '',
        department: staff.department || '',
        stage:      staff.stage || 'both',
        role:       staff.role || '',
      },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(400).json({ success: false, message: 'This invite link has expired. Ask an admin to resend.' });
    res.status(400).json({ success: false, message: 'Invalid invite link' });
  }
});

// POST /api/onboard/:token — complete onboarding. Body:
// { password, phone, address, emergencyContactName, emergencyContactPhone,
//   emergencyContactRelation, tshirtSize, stage, department, role, rates: [...] }
// Returns { token, user } so the client logs in immediately.
app.post('/api/onboard/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, config.jwtSecret);
    if (payload.t !== 'invite') return res.status(400).json({ success: false, message: 'Invalid invite link' });
    const { password, phone, address,
      emergencyContactName, emergencyContactPhone, emergencyContactRelation,
      tshirtSize, stage, department, role, rates,
    } = req.body || {};
    if (!password || password.length < 8)
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === payload.uid);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Update the user account: real password hash + onboardingComplete.
    const hash = await bcrypt.hash(password, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, user.id, {
      password: hash,
      onboardingComplete: 'true',
      onboardedAt: new Date().toISOString(),
    });

    // Update (or create) the linked staff record with everything they filled in.
    const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
    let staff = user.staffId ? staffRows.find(s => s.id === user.staffId) : null;
    // Fallback: match by email so we never create a duplicate staff row when
    // the user record was created without a staffId backlink.
    if (!staff && user.email) {
      staff = staffRows.find(s => (s.email || '').toLowerCase() === user.email.toLowerCase());
      if (staff && staff.id !== user.staffId) {
        await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: staff.id });
        user.staffId = staff.id;
      }
    }
    const ratesJson = (() => {
      try { return JSON.stringify(Array.isArray(rates) ? rates : JSON.parse(rates || '[]')); }
      catch { return '[]'; }
    })();
    const staffPatch = {
      name:       user.name || '',
      email:      user.email,
      phone:      phone || '',
      address:    address || '',
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelation,
      tshirtSize: tshirtSize || '',
      stage:      stage || 'both',
      department: department || '',
      role:       role || '',
      rates:      ratesJson,
      onboardingComplete: 'true',
      active:     'true',
    };
    if (staff) {
      await sheets.updateRowById(config.googleSheets.sheets.staff, staff.id, staffPatch);
    } else {
      const newStaff = {
        id: Date.now().toString(),
        ...staffPatch,
        startDate: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.staff, newStaff);
      await sheets.updateRowById(config.googleSheets.sheets.users, user.id, { staffId: newStaff.id });
    }

    // Sign them in.
    const token = signToken({ ...user, password: hash });
    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, role: user.role, email: user.email, staffId: user.staffId || '' },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(400).json({ success: false, message: 'This invite link has expired. Ask an admin to resend.' });
    console.error('Onboarding error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
crudRoutes(app, '/api/staff', 'staff', ['admin','production_manager'], { afterCreate: autoCreateUserForStaff, awaitAfterCreate: true, deleteRoles: ['admin'] });

// ── Users (admin + production_manager) ────────────────────────────────────────
// Production managers can list/create/invite non-admin users but cannot edit
// existing users or grant admin. Admin-only for PUT.
app.get('/api/users', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.users);
    res.json({ success: true, data: rows.map(({ password, ...u }) => u) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/users', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const { name, email, password, role, invite } = req.body;
    if (!name || !email || !role)
      return res.status(400).json({ success: false, message: 'Name, email, and role are required' });
    if (!invite && !password)
      return res.status(400).json({ success: false, message: 'Password is required (or enable invite mode)' });
    if (req.user.role !== 'admin' && role === 'admin')
      return res.status(403).json({ success: false, message: 'Only admin can grant the admin role.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await sheets.getRows(config.googleSheets.sheets.users);
    if (existing.some(u => (u.email || '').toLowerCase() === normalizedEmail))
      return res.status(400).json({ success: false, message: 'A user with that email already exists.' });

    // Invite flow: create a placeholder password; the invitee sets a real one via the onboarding link.
    const rawPassword = invite
      ? `pending-${Date.now()}-${Math.random()}`
      : password;
    const hashed = await bcrypt.hash(rawPassword, 12);
    const user = {
      id: Date.now().toString(),
      name,
      email: normalizedEmail,
      role,
      password: hashed,
      active: 'true',
      onboardingComplete: invite ? 'false' : 'true',
      createdAt: new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.users, user);

    let inviteUrl = null;
    if (invite) {
      inviteUrl = await sendInviteEmailIfPossible(user, null, req);
    }

    const { password: _, ...safe } = user;
    res.json({ success: true, data: safe, invited: invite ? { email: user.email, inviteUrl } : null });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/users/:id/invite — (re)send an invite email to an existing user.
// Used to re-issue the onboarding link if the user never completed setup or
// the original link expired.
app.post('/api/users/:id/invite', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const user  = users.find(u => u.id === req.params.id);
    if (!user)         return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.email)   return res.status(400).json({ success: false, message: 'User has no email on file' });
    if (req.user.role !== 'admin' && user.role === 'admin')
      return res.status(403).json({ success: false, message: 'Only admin can re-invite an admin.' });
    if (user.onboardingComplete === 'true')
      return res.status(400).json({ success: false, message: 'User has already completed onboarding. Reset their password via Edit instead.' });
    // Look up an optional linked staff record so onboarding can prefill.
    let staff = null;
    if (user.staffId) {
      const staffRows = await sheets.getRows(config.googleSheets.sheets.staff);
      staff = staffRows.find(s => s.id === user.staffId) || null;
    }
    const inviteUrl = await sendInviteEmailIfPossible(user, staff, req);
    res.json({ success: true, inviteUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.password) updates.password = await bcrypt.hash(updates.password, 12);
    await sheets.updateRowById(config.googleSheets.sheets.users, req.params.id, updates);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Push Notifications ────────────────────────────────────────────────────────
// Returns the VAPID public key so the client can call pushManager.subscribe().
app.get('/api/push/public-key', (req, res) => {
  res.json({ success: true, publicKey: push.publicKey(), enabled: push.isConfigured() });
});

// Persist a Web Push subscription for the authenticated user.
// One user may register many devices; one row per (userId, endpoint).
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription, userAgent } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, message: 'subscription.endpoint required' });
    }
    const result = await push.subscribe(req.user.id, subscription, userAgent || req.headers['user-agent'] || '');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('push.subscribe error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Remove a subscription (logout, or user disabled notifications).
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint required' });
    const result = await push.unsubscribe(endpoint);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Send a test push to the calling user — used by the Settings page to verify
// that notifications are wired correctly.
app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    if (!push.isConfigured()) {
      return res.json({ success: true, sent: 0, skipped: 'no-vapid',
        message: 'Server has no VAPID keys configured. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in your environment and restart.' });
    }
    const result = await push.sendToUser(req.user.id, {
      title: 'Windjammer test notification',
      body: 'Push is working on this device.',
      url: '/settings',
      tag: 'wj-test',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update notification preferences for the authenticated user.
app.put('/api/me/notification-prefs', requireAuth, async (req, res) => {
  try {
    const prefs = req.body || {};
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, {
      notificationPrefs: JSON.stringify(prefs),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/me/notification-prefs', requireAuth, async (req, res) => {
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users).catch(() => []);
    const u = users.find(r => String(r.id) === String(req.user.id));
    let prefs = {};
    if (u && u.notificationPrefs) {
      try { prefs = JSON.parse(u.notificationPrefs); } catch {}
    }
    res.json({ success: true, prefs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/me/pay — running-tally pay summary for the authenticated user.
// Only counts EARNED pay (labor rows whose show date is in the past) so a
// staff member never sees budgeted pay for a show that hasn't happened yet.
// Managers with financial access use the richer StaffDetail view for forecast.
app.get('/api/me/pay', requireAuth, async (req, res) => {
  try {
    const staffId = req.user?.staffId;
    const empty = {
      earned: { lifetime: 0, ytd: 0, last30: 0 },
      shifts: { past: 0, upcoming: 0 },
      nextCall: null,
    };
    if (!staffId) return res.json({ success: true, data: empty });

    const [laborRows, showRows] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.labor).catch(() => []),
      sheets.getRows(config.googleSheets.sheets.shows).catch(() => []),
    ]);
    const showById = new Map(showRows.map(s => [String(s.id), s]));

    const parseDate = d => {
      if (!d) return null;
      const s = String(d);
      const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
      return isNaN(dt.getTime()) ? null : dt;
    };
    const rowCost = row => {
      const rate = parseFloat(row?.rate);
      if (!Number.isFinite(rate)) return parseFloat(row?.total || 0) || 0;
      if ((row.payType || 'hour') === 'day') {
        const d = parseFloat(row.days || '1');
        return (Number.isFinite(d) ? d : 1) * rate;
      }
      const h = parseFloat(row.hours);
      return (Number.isFinite(h) ? h : 0) * rate;
    };

    const now    = new Date();
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const yStart = new Date(now.getFullYear(), 0, 1);
    const d30    = new Date(now.getTime() - 30 * 86400000);

    let lifetime = 0, ytd = 0, last30 = 0;
    let pastShifts = 0, upcomingShifts = 0;
    let nextCall = null;
    let nextDt   = null;

    for (const row of laborRows) {
      if (String(row.staffId) !== String(staffId)) continue;
      const show    = row.showId ? showById.get(String(row.showId)) : null;
      const dateStr = show?.date || (row.createdAt ? String(row.createdAt).slice(0, 10) : '');
      const dt      = parseDate(dateStr);
      // Facility rows (no show) with no date fall through as "past" so their
      // pay is included in the running tally rather than getting stuck in limbo.
      const isPast  = !dt || dt < today;
      if (isPast) {
        const c = rowCost(row);
        lifetime += c;
        if (dt && dt >= yStart) ytd    += c;
        if (dt && dt >= d30)    last30 += c;
        pastShifts++;
      } else {
        upcomingShifts++;
        if (!nextDt || dt < nextDt) {
          nextDt   = dt;
          nextCall = {
            date:     dateStr,
            showName: show?.artist || show?.eventName || row.showName || '',
            role:     row.role || '',
            callTime: row.callTime || '',
          };
        }
      }
    }

    res.json({
      success: true,
      data: {
        earned:   { lifetime, ytd, last30 },
        shifts:   { past: pastShifts, upcoming: upcomingShifts },
        nextCall,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Tech Pack ─────────────────────────────────────────────────────────────────
// One long-form document per stage. The sheet stores a single row per stage
// with a JSON `sections` blob (array of { key, title, icon, content }).
// Legacy rows (one per docType — overview/audio/lighting/etc.) are merged into
// the new shape on read; they stay in the sheet as backup and are ignored once
// a `docType='stage'` row exists.
const TECHPACK_STAGES = ['inside', 'beach'];
const TECHPACK_DEFAULT_SECTIONS = [
  { key: 'overview',    title: 'Venue Overview',            icon: '📍' },
  { key: 'staging',     title: 'Stage Dimensions & Specs',  icon: '📐' },
  { key: 'power',       title: 'Power Distribution',        icon: '⚡' },
  { key: 'audio',       title: 'Audio System',              icon: '🔊' },
  { key: 'lighting',    title: 'Lighting',                  icon: '💡' },
  { key: 'backline',    title: 'Backline / House Gear',     icon: '🎸' },
  { key: 'stagePlot',   title: 'Stage Plot & Photos',       icon: '🎥' },
  { key: 'loadIn',      title: 'Load-in / Parking / Push',  icon: '🗺' },
  { key: 'hospitality', title: 'Hospitality / Dressing Room', icon: '🍽' },
];
// docType key on a legacy row  →  section key in the new format
const TECHPACK_LEGACY_MAP = {
  overview:  'overview',
  techpack:  'overview',
  stageplot: 'stagePlot',
  lighting:  'lighting',
  audio:     'audio',
  power:     'power',
  catering:  'hospitality',
  loadinmap: 'loadIn',
};

function techpackBuildFromLegacy(stage, legacyRows) {
  const byKey = new Map();
  for (const row of legacyRows) {
    const sectionKey = TECHPACK_LEGACY_MAP[row.docType];
    if (!sectionKey || !row.content) continue;
    const prev = byKey.get(sectionKey) || '';
    byKey.set(sectionKey, prev + row.content);
  }
  return TECHPACK_DEFAULT_SECTIONS.map(s => ({ ...s, content: byKey.get(s.key) || '' }));
}

function techpackParseSections(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Merge in any defaults the user hasn't got yet (for future additions)
    const byKey = new Map(parsed.map(s => [s.key, s]));
    return TECHPACK_DEFAULT_SECTIONS.map(def => ({
      ...def,
      ...(byKey.get(def.key) || {}),
      content: byKey.get(def.key)?.content || '',
    }));
  } catch { return null; }
}

app.get('/api/techpack', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.techpack);
    const data = TECHPACK_STAGES.map(stage => {
      const stageRows = rows.filter(r => r.stage === stage);
      const modern = stageRows.find(r => r.docType === 'stage');
      if (modern) {
        const sections = techpackParseSections(modern.sections)
          || TECHPACK_DEFAULT_SECTIONS.map(s => ({ ...s, content: '' }));
        return {
          id: modern.id, stage, sections, updatedAt: modern.updatedAt || '',
          pdfFileId:      modern.pdfFileId      || '',
          pdfFilename:    modern.pdfFilename    || '',
          pdfMimeType:    modern.pdfMimeType    || '',
          pdfUrl:         modern.pdfUrl         || '',
          pdfUpdatedAt:   modern.pdfUpdatedAt   || '',
        };
      }
      const sections = techpackBuildFromLegacy(stage, stageRows);
      const latest = stageRows
        .map(r => r.updatedAt)
        .filter(Boolean)
        .sort()
        .pop() || '';
      return { id: null, stage, sections, updatedAt: latest };
    });
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/techpack/:stage', requireAuth, requireRole('admin', 'production_manager', 'stage_manager'), async (req, res) => {
  try {
    const stage = req.params.stage;
    if (!TECHPACK_STAGES.includes(stage))
      return res.status(400).json({ success: false, message: 'Unknown stage' });
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : null;
    if (!sections)
      return res.status(400).json({ success: false, message: 'sections array required' });
    // Only persist the fields we care about (drop transient UI state)
    const clean = sections.map(s => ({
      key:     String(s.key || ''),
      title:   String(s.title || ''),
      icon:    String(s.icon || ''),
      content: String(s.content || ''),
    }));
    const payload = {
      stage,
      docType: 'stage',
      sections: JSON.stringify(clean),
      updatedAt: new Date().toISOString(),
    };
    const rows = await sheets.getRows(config.googleSheets.sheets.techpack);
    const modern = rows.find(r => r.stage === stage && r.docType === 'stage');
    if (modern) {
      await sheets.updateRowById(config.googleSheets.sheets.techpack, modern.id, payload);
    } else {
      payload.id = 'tp_' + Date.now();
      payload.title = stage === 'beach' ? 'Beach Stage Tech Pack' : 'Inside Stage Tech Pack';
      await sheets.appendRow(config.googleSheets.sheets.techpack, payload);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Upload/replace the current PDF for a stage's tech pack. Uploads to Drive,
// makes it link-shareable, and stores fileId/url/name/type on the TechPack row.
app.post('/api/techpack/:stage/pdf',
  requireAuth, requireRole('admin', 'production_manager', 'stage_manager'),
  async (req, res) => {
    try {
      const stage = req.params.stage;
      if (!TECHPACK_STAGES.includes(stage))
        return res.status(400).json({ success: false, message: 'Unknown stage' });
      const { filename, mimeType, data } = req.body || {};
      if (!filename || !mimeType || !data)
        return res.status(400).json({ success: false, message: 'filename, mimeType, data required' });

      const drive = await sheets.getDriveClient();
      const buffer = Buffer.from(data, 'base64');
      const readable = Readable.from(buffer);
      const uploaded = await drive.files.create({
        requestBody: { name: filename, mimeType },
        media: { mimeType, body: readable },
        fields: 'id,webViewLink',
      });
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const rows = await sheets.getRows(config.googleSheets.sheets.techpack);
      const modern = rows.find(r => r.stage === stage && r.docType === 'stage');
      const patch = {
        pdfFileId:     uploaded.data.id,
        pdfFilename:   filename,
        pdfMimeType:   mimeType,
        pdfUrl:        uploaded.data.webViewLink || `https://drive.google.com/file/d/${uploaded.data.id}/view`,
        pdfUpdatedAt:  new Date().toISOString(),
      };
      if (modern) {
        // If there was a previous PDF, trash it so Drive doesn't accumulate junk.
        if (modern.pdfFileId && modern.pdfFileId !== uploaded.data.id) {
          drive.files.update({ fileId: modern.pdfFileId, requestBody: { trashed: true } })
            .catch(err => console.warn('[techpack pdf] could not trash old file:', err.message));
        }
        await sheets.updateRowById(config.googleSheets.sheets.techpack, modern.id, patch);
      } else {
        await sheets.appendRow(config.googleSheets.sheets.techpack, {
          id: 'tp_' + Date.now(),
          stage, docType: 'stage',
          title: stage === 'beach' ? 'Beach Stage Tech Pack' : 'Inside Stage Tech Pack',
          sections: JSON.stringify(TECHPACK_DEFAULT_SECTIONS.map(s => ({ ...s, content: '' }))),
          updatedAt: new Date().toISOString(),
          ...patch,
        });
      }
      res.json({ success: true, ...patch });
    } catch (err) {
      console.error('[techpack pdf upload]', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.delete('/api/techpack/:stage/pdf',
  requireAuth, requireRole('admin', 'production_manager', 'stage_manager'),
  async (req, res) => {
    try {
      const stage = req.params.stage;
      if (!TECHPACK_STAGES.includes(stage))
        return res.status(400).json({ success: false, message: 'Unknown stage' });
      const rows = await sheets.getRows(config.googleSheets.sheets.techpack);
      const modern = rows.find(r => r.stage === stage && r.docType === 'stage');
      if (!modern) return res.json({ success: true });
      if (modern.pdfFileId) {
        try {
          const drive = await sheets.getDriveClient();
          await drive.files.update({ fileId: modern.pdfFileId, requestBody: { trashed: true } });
        } catch (err) { console.warn('[techpack pdf delete] Drive trash failed:', err.message); }
      }
      await sheets.updateRowById(config.googleSheets.sheets.techpack, modern.id, {
        pdfFileId: '', pdfFilename: '', pdfMimeType: '', pdfUrl: '', pdfUpdatedAt: '',
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Patch Lists ───────────────────────────────────────────────────────────────
// A patch list is a per-show (or per-artist-as-template) I/O document for the
// audio console. Rows are stored one-per-list with the channel data as JSON
// blobs (inputs / outputs / inputPatchPoints / outputPatchPoints) so the whole
// list is one round-trip to load or save.
//
// REAL-TIME COLLABORATION
// -----------------------
// During a show multiple engineers can be editing the same patch list at once
// (FOH, monitors, stage tech). To make that safe:
//   1. Each cell edit goes through PATCH /api/patch-lists/:id/cell (not PUT).
//      That endpoint mutates just the one cell in the JSON blob so two
//      engineers hitting different rows don't clobber each other.
//   2. All writes to a given patch list are serialized through an in-memory
//      per-list promise chain (patchWriteQueues) — the second write reads
//      the row state produced by the first write, not the pre-write state.
//   3. GET /api/patch-lists/:id/stream is a Server-Sent Events endpoint;
//      after any successful write the server pushes the delta to every
//      connected client so their editors update within ~50ms. Presence
//      counts are broadcast on connect/disconnect for the "N engineers
//      editing" indicator.
//   4. Clients include a sourceId with each PATCH so they can suppress the
//      echo of their own change and avoid caret-jumping while typing.
//
// Note: the SSE fan-out is in-memory and therefore single-process. If the
// deployment ever scales to multiple app instances this needs a shared
// pub/sub (Redis, Pusher, etc.).
const PATCH_WRITE_ROLES = ['admin','production_manager','stage_manager'];

const patchSubscribers  = new Map(); // patchListId -> Set<res>
const patchWriteQueues  = new Map(); // patchListId -> Promise chain (serializes writes)

function broadcastPatch(patchListId, event) {
  const subs = patchSubscribers.get(String(patchListId));
  if (!subs || subs.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch { /* client vanished; will be cleaned on close */ }
  }
}

// Serialize writes for one patch list so overlapping edits merge sequentially
// instead of racing on stale reads. Returns the awaited result of `work()`.
function queuePatchWrite(patchListId, work) {
  const key  = String(patchListId);
  const prev = patchWriteQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(work);
  patchWriteQueues.set(key, next);
  next.finally(() => {
    if (patchWriteQueues.get(key) === next) patchWriteQueues.delete(key);
  });
  return next;
}

crudRoutes(app, '/api/patch-lists', 'patchLists', PATCH_WRITE_ROLES, {
  // Any full-document update (e.g. adding/removing a patch-point column,
  // renaming the list) tells all connected editors to refetch. Fire-and-forget.
  afterUpdate: (row) => broadcastPatch(row.id, {
    type: 'reload',
    at:   new Date().toISOString(),
  }),
});

// GET /api/patch-lists/:id/stream — Server-Sent Events channel for live
// updates. Clients pass ?access_token=<jwt> because EventSource can't set
// headers. Emits:
//   { type: 'cell',     path, value, sourceId, by, at }
//   { type: 'reload',   at }                          — after a full PUT
//   { type: 'presence', count }                       — active editor count
app.get('/api/patch-lists/:id/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx, Railway)
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);

  const id = String(req.params.id);
  if (!patchSubscribers.has(id)) patchSubscribers.set(id, new Set());
  const subs = patchSubscribers.get(id);
  subs.add(res);
  broadcastPatch(id, { type: 'presence', count: subs.size });

  // Heartbeat every 25s to defeat idle proxy timeouts.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); }
    catch { /* handled by close */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0) patchSubscribers.delete(id);
    else broadcastPatch(id, { type: 'presence', count: subs.size });
  });
});

// PATCH /api/patch-lists/:id/cell — apply ONE cell change and broadcast it.
// Body: { path, value, sourceId? }
// `path` grammar (dot-delimited):
//   inputs.<index>.name                       — string
//   inputs.<index>.phantom                    — 'true' | 'false'
//   inputs.<index>.patch.<Patch Point Name>   — string (channel # on device)
//   outputs.<index>.name                      — string
//   outputs.<index>.patch.<Patch Point Name>  — string
//   name                                      — string (rename the whole list)
//   inputPatchPoints                          — value must be an array
//   outputPatchPoints                         — value must be an array
app.patch('/api/patch-lists/:id/cell',
  requireAuth, requireRole(...PATCH_WRITE_ROLES),
  async (req, res) => {
    try {
      const { path, value, sourceId } = req.body || {};
      if (!path || typeof path !== 'string')
        return res.status(400).json({ success: false, message: 'path is required' });

      const patchListId = req.params.id;
      const now = new Date().toISOString();
      const by  = req.user?.name || req.user?.email || '';

      await queuePatchWrite(patchListId, async () => {
        const rows = await sheets.getRows(config.googleSheets.sheets.patchLists);
        const row  = rows.find(r => r.id === patchListId);
        if (!row) throw Object.assign(new Error('Patch list not found'), { status: 404 });

        const parts   = path.split('.');
        const updates = { updatedAt: now, updatedBy: by };

        if (parts[0] === 'inputs' || parts[0] === 'outputs') {
          const blobField = parts[0];
          const index     = parseInt(parts[1], 10);
          if (Number.isNaN(index))
            throw Object.assign(new Error('index required'), { status: 400 });
          const subfield = parts[2];
          // Patch-point names can theoretically contain dots — rejoin everything
          // after parts[2] so "patch.Sub Snake A.1" style names survive.
          const subkey   = parts.slice(3).join('.') || null;

          let arr;
          try { arr = JSON.parse(row[blobField] || '[]'); }
          catch { arr = []; }
          if (!Array.isArray(arr)) arr = [];
          while (arr.length <= index) arr.push({ n: arr.length + 1 });

          const item = { ...(arr[index] || { n: index + 1 }) };
          if (subfield === 'patch') {
            item.patch = { ...(item.patch || {}) };
            if (subkey) item.patch[subkey] = value;
          } else if (subfield) {
            item[subfield] = value;
          }
          arr[index] = item;
          updates[blobField] = JSON.stringify(arr);
        } else if (['name', 'inputPatchPoints', 'outputPatchPoints'].includes(parts[0])) {
          updates[parts[0]] = typeof value === 'string' ? value : JSON.stringify(value);
        } else {
          throw Object.assign(new Error('Unknown path: ' + path), { status: 400 });
        }

        await sheets.updateRowById(config.googleSheets.sheets.patchLists, patchListId, updates);
      });

      broadcastPatch(patchListId, {
        type:     'cell',
        path,
        value,
        sourceId: sourceId || null,
        by,
        at:       now,
      });

      res.json({ success: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[patch-lists/cell]', err.message);
      res.status(status).json({ success: false, message: err.message });
    }
  }
);

// POST /api/patch-lists/from-template/:templateId
// Duplicate an artist template into a brand-new show patch list. Body: { showId, name? }
app.post('/api/patch-lists/from-template/:templateId',
  requireAuth, requireRole(...PATCH_WRITE_ROLES),
  async (req, res) => {
    try {
      const { showId, name } = req.body || {};
      if (!showId) return res.status(400).json({ success: false, message: 'showId is required' });
      const rows = await sheets.getRows(config.googleSheets.sheets.patchLists);
      const tpl  = rows.find(r => r.id === req.params.templateId);
      if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
      const copy = {
        id: Date.now().toString(),
        showId,
        artistId:          tpl.artistId || '',
        artistName:        tpl.artistName || '',
        name:              name || tpl.name || 'Patch List',
        inputPatchPoints:  tpl.inputPatchPoints  || '[]',
        outputPatchPoints: tpl.outputPatchPoints || '[]',
        inputs:            tpl.inputs  || '[]',
        outputs:           tpl.outputs || '[]',
        isTemplate:        'false',
        createdBy:         req.user?.name || req.user?.email || '',
        createdAt:         new Date().toISOString(),
        updatedAt:         new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.patchLists, copy);
      res.json({ success: true, data: copy });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/patch-lists/:id/save-as-template
// Snapshot a show's patch list into a reusable artist template.
// Body: { artistId, artistName?, name? } — creates a NEW row with isTemplate='true'.
app.post('/api/patch-lists/:id/save-as-template',
  requireAuth, requireRole(...PATCH_WRITE_ROLES),
  async (req, res) => {
    try {
      const { artistId, artistName, name } = req.body || {};
      if (!artistId) return res.status(400).json({ success: false, message: 'artistId is required' });
      const rows = await sheets.getRows(config.googleSheets.sheets.patchLists);
      const src  = rows.find(r => r.id === req.params.id);
      if (!src) return res.status(404).json({ success: false, message: 'Patch list not found' });
      const tpl = {
        id: Date.now().toString(),
        showId:            '',
        artistId,
        artistName:        artistName || '',
        name:              name || src.name || 'Template',
        inputPatchPoints:  src.inputPatchPoints  || '[]',
        outputPatchPoints: src.outputPatchPoints || '[]',
        inputs:            src.inputs  || '[]',
        outputs:           src.outputs || '[]',
        isTemplate:        'true',
        createdBy:         req.user?.name || req.user?.email || '',
        createdAt:         new Date().toISOString(),
        updatedAt:         new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.patchLists, tpl);
      res.json({ success: true, data: tpl });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Image Upload (Google Drive) ───────────────────────────────────────────────
const { Readable } = require('stream');

async function uploadToDrive(filename, mimeType, base64Data) {
  const drive = await sheets.getDriveClient();
  const buffer = Buffer.from(base64Data, 'base64');
  const readable = Readable.from(buffer);
  const fileRes = await drive.files.create({
    requestBody: { name: filename, mimeType },
    media: { mimeType, body: readable },
    fields: 'id',
  });
  const fileId = fileRes.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/uc?id=${fileId}&export=view`;
}

app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { filename, mimeType, data } = req.body;
    if (!filename || !mimeType || !data)
      return res.status(400).json({ success: false, message: 'filename, mimeType and data required' });
    const url = await uploadToDrive(filename, mimeType, data);
    res.json({ success: true, url });
  } catch (err) {
    console.error('Upload error:', err.message);
    const raw = String(err.message || '');
    let message = raw;
    if (raw.includes('invalid_grant')) {
      const usingOAuth = !!(
        process.env.GMAIL_CLIENT_ID &&
        process.env.GMAIL_CLIENT_SECRET &&
        process.env.GMAIL_REFRESH_TOKEN
      );
      message = usingOAuth
        ? 'Google rejected the Drive credentials (invalid_grant). The OAuth refresh token has been revoked or expired — an admin needs to re-run scripts/setup-gmail-oauth.js and update GMAIL_REFRESH_TOKEN in Railway.'
        : 'Google rejected the Drive credentials (invalid_grant). The service-account private key is stale — an admin needs to rotate the key in GCP and update GOOGLE_SERVICE_ACCOUNT in Railway.';
    }
    res.status(500).json({ success: false, message });
  }
});

// ── Production Notes — send via Gmail ────────────────────────────────────────
app.post('/api/production-notes/send', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const { to, cc, subject, html } = req.body;
    if (!to || !subject || !html)
      return res.status(400).json({ success: false, message: 'to, subject, and html are required' });
    await gmail.sendEmail({ to, cc, subject, body: html });
    res.json({ success: true });
  } catch (err) {
    console.error('Production notes send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Google Drive — create / get show folder ───────────────────────────────────
app.post('/api/shows/:id/drive-folder', requireAuth, async (req, res) => {
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show = shows.find(s => s.id === req.params.id);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    // Return existing folder if already created
    if (show.driveFolderId) {
      return res.json({
        success: true,
        folderId:  show.driveFolderId,
        folderUrl: `https://drive.google.com/drive/folders/${show.driveFolderId}`,
      });
    }

    const drive = await sheets.getDriveClient();
    const folderName = `Windjammer — ${show.date} — ${show.artist || show.eventName || 'Show'}`;

    const folder = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    const folderId = folder.data.id;

    // Make readable by anyone with the link
    await drive.permissions.create({
      fileId: folderId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // Persist folder ID back to Shows sheet
    await sheets.updateRowById(config.googleSheets.sheets.shows, req.params.id, { driveFolderId: folderId });

    res.json({
      success:   true,
      folderId,
      folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    });
  } catch (err) {
    console.error('Drive folder error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Save Gmail attachment to show's Drive folder ──────────────────────────────
app.post('/api/emails/save-to-drive', requireAuth, async (req, res) => {
  try {
    const { messageId, attachmentId, filename, mimeType, showId } = req.body;
    if (!messageId || !attachmentId || !filename || !showId)
      return res.status(400).json({ success: false, message: 'messageId, attachmentId, filename, showId required' });

    // Get or create the show's Drive folder
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show  = shows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    let folderId = show.driveFolderId;
    const drive  = await sheets.getDriveClient();

    if (!folderId) {
      const folderName = `Windjammer — ${show.date} — ${show.artist || show.eventName || 'Show'}`;
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      folderId = folder.data.id;
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      await sheets.updateRowById(config.googleSheets.sheets.shows, showId, { driveFolderId: folderId });
    }

    // Download from Gmail
    const base64 = await gmail.getAttachmentData(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');

    const { Readable } = require('stream');
    const readable = Readable.from(buffer);

    const uploaded = await drive.files.create({
      requestBody: {
        name:    filename,
        mimeType: mimeType || 'application/octet-stream',
        parents: [folderId],
      },
      media: { mimeType: mimeType || 'application/octet-stream', body: readable },
      fields: 'id,webViewLink',
    });

    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    res.json({
      success:     true,
      fileId:      uploaded.data.id,
      webViewLink: uploaded.data.webViewLink,
      folderUrl:   `https://drive.google.com/drive/folders/${folderId}`,
    });
  } catch (err) {
    console.error('Save-to-drive error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/save-to-artist  — pull a Gmail attachment and add it to
// an artist's document library (ArtistDocuments + the artist's Drive folder).
// Body: { messageId, attachmentId, filename, mimeType,
//         artistId?, showId?, type?, notes?, year? }
// If artistId is missing but showId is provided, we resolve the artist from
// the show (same logic used by the email assign handler).
app.post('/api/emails/save-to-artist',
  requireAuth, requireRole('admin','production_manager','stage_manager'),
  async (req, res) => {
    try {
      const {
        messageId, attachmentId, filename, mimeType,
        artistId: bodyArtistId, showId, type, notes, year,
      } = req.body || {};
      if (!messageId || !attachmentId || !filename)
        return res.status(400).json({ success: false, message: 'messageId, attachmentId, filename required' });

      let artistId = bodyArtistId || '';
      let showDate = '';
      if (!artistId && showId) {
        const [shows, artists] = await Promise.all([
          sheets.getRows(config.googleSheets.sheets.shows),
          sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
        ]);
        const show = shows.find(s => s.id === showId);
        if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
        const artist = findArtistForShow(show, artists);
        if (!artist) return res.status(400).json({ success: false, message: 'Show has no linked artist — pick an artist explicitly.' });
        artistId = artist.id;
        showDate = show.date || '';
      }
      if (!artistId) return res.status(400).json({ success: false, message: 'artistId or showId required' });

      const { artist, folderId } = await ensureArtistFolder(artistId);
      if (!artist) return res.status(404).json({ success: false, message: 'Artist not found' });

      const base64 = await gmail.getAttachmentData(messageId, attachmentId);
      const buffer = Buffer.from(base64, 'base64');
      const readable = Readable.from(buffer);

      const drive = await sheets.getDriveClient();
      const uploaded = await drive.files.create({
        requestBody: {
          name:    filename,
          mimeType: mimeType || 'application/octet-stream',
          parents: [folderId],
        },
        media: { mimeType: mimeType || 'application/octet-stream', body: readable },
        fields: 'id,webViewLink',
      });
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const record = {
        id:          Date.now().toString(),
        artistId,
        artistName:  artist.name || '',
        name:        filename,
        type:        type || 'email-attachment',
        year:        year ? String(year) : '',
        notes:       notes || `Saved from email (Gmail message ${messageId})`,
        showId:      showId || '',
        showDate,
        console:     '',
        consoleFirmware: '',
        engineerRole:    '',
        mimeType:    mimeType || 'application/octet-stream',
        driveFileId: uploaded.data.id,
        webViewLink: uploaded.data.webViewLink || `https://drive.google.com/file/d/${uploaded.data.id}/view`,
        uploadedBy:  req.user?.name || req.user?.email || '',
        createdAt:   new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.artistDocuments, record);

      res.json({ success: true, data: record });
    } catch (err) {
      console.error('Save-to-artist error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Artist Registry — Document storage (Drive-backed) ────────────────────────
// One folder per artist (lazily created). Each document is a row in the
// ArtistDocuments sheet referencing a Drive fileId. Everyone can read; PM+
// uploads and deletes (which also removes the Drive file).
async function ensureArtistFolder(artistId) {
  const artists = await sheets.getRows(config.googleSheets.sheets.artists);
  const artist  = artists.find(a => a.id === artistId);
  if (!artist) return { artist: null, folderId: null };
  if (artist.driveFolderId) return { artist, folderId: artist.driveFolderId };

  const drive = await sheets.getDriveClient();
  const folder = await drive.files.create({
    requestBody: {
      name: `Windjammer — Artist — ${artist.name || artist.id}`,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  const folderId = folder.data.id;
  await drive.permissions.create({
    fileId: folderId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  await sheets.updateRowById(config.googleSheets.sheets.artists, artistId, { driveFolderId: folderId });
  return { artist: { ...artist, driveFolderId: folderId }, folderId };
}

// List all documents for an artist (auth-only)
app.get('/api/artists/:id/documents', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
    const docs = rows.filter(d => d.artistId === req.params.id);
    res.json({ success: true, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Upload a document to an artist's folder (PM+ / Stage Manager)
// Body: { filename, mimeType, data (base64), type, year, notes, showId, showDate,
//         console, consoleFirmware, engineerRole }
// The console-* fields are optional metadata used for console scene/showfiles
// (e.g. type: 'consoleFile', console: 'Digico SD10', engineerRole: 'FOH').
app.post('/api/artists/:id/documents',
  requireAuth, requireRole('admin','production_manager','stage_manager'),
  async (req, res) => {
    try {
      const {
        filename, mimeType, data, type, year, notes, showId, showDate,
        console: consoleModel, consoleFirmware, engineerRole,
      } = req.body || {};
      if (!filename || !mimeType || !data)
        return res.status(400).json({ success: false, message: 'filename, mimeType, data required' });

      const { artist, folderId } = await ensureArtistFolder(req.params.id);
      if (!artist) return res.status(404).json({ success: false, message: 'Artist not found' });

      const drive  = await sheets.getDriveClient();
      const buffer = Buffer.from(data, 'base64');
      const readable = Readable.from(buffer);
      const uploaded = await drive.files.create({
        requestBody: { name: filename, mimeType, parents: [folderId] },
        media: { mimeType, body: readable },
        fields: 'id,webViewLink',
      });
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const record = {
        id:          Date.now().toString(),
        artistId:    req.params.id,
        artistName:  artist.name || '',
        name:        filename,
        type:        type || 'other',
        year:        year ? String(year) : '',
        notes:       notes || '',
        showId:      showId || '',
        showDate:    showDate || '',
        console:     consoleModel || '',
        consoleFirmware: consoleFirmware || '',
        engineerRole:    engineerRole || '',
        mimeType,
        driveFileId: uploaded.data.id,
        webViewLink: uploaded.data.webViewLink || `https://drive.google.com/file/d/${uploaded.data.id}/view`,
        uploadedBy:  req.user?.name || req.user?.email || '',
        createdAt:   new Date().toISOString(),
      };
      await sheets.appendRow(config.googleSheets.sheets.artistDocuments, record);

      // Notify the production team that a new document landed.
      const labelBits = [];
      if (type) labelBits.push(type);
      if (consoleModel) labelBits.push(consoleModel);
      const label = labelBits.length ? ` (${labelBits.join(' · ')})` : '';
      push.sendToRole(
        ['admin', 'production_manager'],
        {
          title: type === 'consoleFile' ? 'Console file uploaded' : 'Document uploaded',
          body: `${artist.name || 'Artist'}: ${filename}${label}`,
          url: showId ? `/shows/${showId}` : `/artists`,
          tag: `doc-${record.id}`,
        },
        'docUploads'
      ).catch(err => console.warn('[push] doc-upload notify failed:', err.message));

      res.json({ success: true, data: record });
    } catch (err) {
      console.error('Artist doc upload error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Stream a document straight from Drive with a Content-Disposition so
// browsers save the original file (needed for binary console showfiles that
// Drive's viewer can't preview). Accepts ?access_token= for <a download> flows.
app.get('/api/artist-documents/:id/download', requireAuth, async (req, res) => {
  try {
    const rows = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
    const doc = rows.find(d => d.id === req.params.id);
    if (!doc)              return res.status(404).json({ success: false, message: 'Document not found' });
    if (!doc.driveFileId)  return res.status(404).json({ success: false, message: 'No Drive file for this document' });

    const drive = await sheets.getDriveClient();
    const meta = await drive.files.get({
      fileId: doc.driveFileId,
      fields: 'name,mimeType,size',
    });
    const filename = doc.name || meta.data.name || 'download';
    const mimeType = meta.data.mimeType || doc.mimeType || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (meta.data.size) res.setHeader('Content-Length', meta.data.size);
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = await drive.files.get(
      { fileId: doc.driveFileId, alt: 'media' },
      { responseType: 'stream' },
    );
    stream.data
      .on('error', err => {
        console.error('Artist doc download stream error:', err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    console.error('Artist doc download error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// Delete a document — removes both the sheet row and the Drive file (PM+ / Stage Manager)
app.delete('/api/artist-documents/:id',
  requireAuth, requireRole('admin','production_manager','stage_manager'),
  async (req, res) => {
    try {
      const rows = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
      const doc = rows.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

      if (doc.driveFileId) {
        try {
          const drive = await sheets.getDriveClient();
          await drive.files.delete({ fileId: doc.driveFileId });
        } catch (e) {
          console.warn(`[artist-doc] Drive delete failed for ${doc.driveFileId}: ${e.message}`);
        }
      }
      await sheets.deleteRowById(config.googleSheets.sheets.artistDocuments, req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('Artist doc delete error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/artists/:id/promote-from-advance
// Copy production-defaults fields from an Advancing record up to the artist.
// Body: { advanceId, fields: ['riderNotes','productionNeeds',...] }
// Only the listed fields are written; anything not in ARTIST_DEFAULT_FIELDS is ignored.
app.post('/api/artists/:id/promote-from-advance',
  requireAuth, requireRole('admin','production_manager','stage_manager'),
  async (req, res) => {
    try {
      const { advanceId, fields } = req.body || {};
      if (!advanceId || !Array.isArray(fields) || fields.length === 0)
        return res.status(400).json({ success: false, message: 'advanceId and fields[] required' });

      const [advances, artists] = await Promise.all([
        sheets.getRows(config.googleSheets.sheets.advancing),
        sheets.getRows(config.googleSheets.sheets.artists),
      ]);
      const adv    = advances.find(a => a.id === advanceId);
      const artist = artists.find(a => a.id === req.params.id);
      if (!adv)    return res.status(404).json({ success: false, message: 'Advance record not found' });
      if (!artist) return res.status(404).json({ success: false, message: 'Artist not found' });

      const updates = {};
      for (const k of fields) {
        if (!ARTIST_DEFAULT_FIELDS.includes(k)) continue;
        if (adv[k] !== undefined && String(adv[k]).trim()) updates[k] = adv[k];
      }
      if (Object.keys(updates).length === 0)
        return res.json({ success: true, updated: 0, message: 'Nothing to promote.' });

      await sheets.updateRowById(config.googleSheets.sheets.artists, req.params.id, updates);
      res.json({ success: true, updated: Object.keys(updates).length, fields: updates });
    } catch (err) {
      console.error('Promote-to-artist error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/shows/:id/migrate-attachments-to-artist
// Move every file currently in the show's Drive folder into the matched
// artist's folder, and record an ArtistDocuments row for each so the file
// appears in the artist history (still tagged with this show).
async function migrateOneShowToArtist(show, artists, drive, uploadedBy) {
  if (!show || !show.driveFolderId) return { skipped: 'no-folder' };
  const artist = findArtistForShow(show, artists);
  if (!artist) return { skipped: 'no-artist-match' };

  // Make sure artist folder exists
  const { folderId: artistFolderId } = await ensureArtistFolder(artist.id);
  if (!artistFolderId) return { skipped: 'artist-folder-failed' };

  // List files in the show folder
  const listed = await drive.files.list({
    q: `'${show.driveFolderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,webViewLink,parents)',
    pageSize: 200,
  });
  const files = listed.data.files || [];
  if (files.length === 0) return { skipped: 'no-files', artist: artist.id };

  // Avoid double-inserting ArtistDocument rows
  const existingDocs = await sheets.getRows(config.googleSheets.sheets.artistDocuments);
  const knownFileIds = new Set(existingDocs.map(d => d.driveFileId).filter(Boolean));

  // Heuristic doc-type classifier based on filename
  function classifyType(name) {
    const n = (name || '').toLowerCase();
    if (/(^|[\s_\-])rider/.test(n) && /hosp/.test(n)) return 'hospitality';
    if (/hospitality/.test(n))                         return 'hospitality';
    if (/rider/.test(n))                               return 'rider';
    if (/stage[\s_\-]?plot/.test(n))                   return 'stagePlot';
    if (/input[\s_\-]?list|patch/.test(n))             return 'inputList';
    if (/contract|deal[\s_\-]?memo/.test(n))           return 'contract';
    if (/w[\s_\-]?9/.test(n))                          return 'w9';
    return 'other';
  }

  let moved = 0;
  for (const f of files) {
    try {
      // Move (re-parent) the file: remove the show folder as parent, add the artist folder.
      const parentsList = (f.parents || []).join(',');
      await drive.files.update({
        fileId: f.id,
        addParents:    artistFolderId,
        removeParents: parentsList || show.driveFolderId,
        fields: 'id, parents',
      });
      if (!knownFileIds.has(f.id)) {
        const record = {
          id:          `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          artistId:    artist.id,
          artistName:  artist.name || '',
          name:        f.name,
          type:        classifyType(f.name),
          year:        (show.date || '').slice(0, 4),
          notes:       `Migrated from show folder (${show.date || ''})`,
          showId:      show.id,
          showDate:    show.date || '',
          mimeType:    f.mimeType || 'application/octet-stream',
          driveFileId: f.id,
          webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
          uploadedBy:  uploadedBy || 'migration',
          createdAt:   new Date().toISOString(),
        };
        await sheets.appendRow(config.googleSheets.sheets.artistDocuments, record);
        knownFileIds.add(f.id);
      }
      moved++;
    } catch (err) {
      console.warn(`[migrate] file ${f.id} (${f.name}) failed: ${err.message}`);
    }
  }
  return { moved, total: files.length, artist: artist.id, artistName: artist.name };
}

app.post('/api/shows/:id/migrate-attachments-to-artist',
  requireAuth, requireRole('admin','production_manager','stage_manager'),
  async (req, res) => {
    try {
      const [shows, artists] = await Promise.all([
        sheets.getRows(config.googleSheets.sheets.shows),
        sheets.getRows(config.googleSheets.sheets.artists),
      ]);
      const show = shows.find(s => s.id === req.params.id);
      if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
      const drive = await sheets.getDriveClient();
      const result = await migrateOneShowToArtist(show, artists, drive, req.user?.name || req.user?.email || '');
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('Migrate attachments error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Admin: migrate every show's folder into its matched artist folder in one shot.
app.post('/api/admin/migrate-all-show-attachments',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const [shows, artists] = await Promise.all([
        sheets.getRows(config.googleSheets.sheets.shows),
        sheets.getRows(config.googleSheets.sheets.artists),
      ]);
      const drive = await sheets.getDriveClient();
      const eligible = shows.filter(s => s.driveFolderId);
      const summary = { totalShows: eligible.length, migrated: 0, files: 0, skipped: [] };
      for (const show of eligible) {
        const r = await migrateOneShowToArtist(show, artists, drive, req.user?.name || req.user?.email || '');
        if (r.skipped) {
          summary.skipped.push({ showId: show.id, artist: show.artist || show.eventName || '', reason: r.skipped });
        } else {
          summary.migrated++;
          summary.files += r.moved || 0;
        }
      }
      res.json({ success: true, ...summary });
    } catch (err) {
      console.error('Migrate-all error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Gmail / Email Integration ────────────────────────────────────────────────

// Helper: safely get stored emails, returns [] if sheet doesn't exist yet
async function getStoredEmails() {
  try {
    return await sheets.getRows(config.googleSheets.sheets.emails);
  } catch {
    return [];
  }
}

// Fetch full bodies for every stored message on a thread and (re-)run the
// analyzer with the given showId so freshly-linked emails produce pending
// facts the bot can actually use. proposeFromAnalysis dedupes by
// (messageId, field, scope, showId), so replays never spam duplicates.
// Best-effort — callers must not fail if this throws.
async function analyzeLinkedThread({ threadId, showId, shows, allEmails, actor }) {
  if (!threadId || !showId) return { analyzed: 0, proposed: 0, skipped: 'missing_ids' };
  if (!gmail.isConfigured())  return { analyzed: 0, proposed: 0, skipped: 'gmail_not_configured' };
  const rows = allEmails.filter(e => e.gmailThreadId === threadId && e.gmailMessageId);
  if (rows.length === 0) return { analyzed: 0, proposed: 0, skipped: 'no_messages' };
  const messages = [];
  for (const r of rows) {
    try {
      const raw = await gmail.getMessage(r.gmailMessageId);
      const parsed = gmail.parseMessage(raw);
      messages.push({
        id:       r.gmailMessageId,
        threadId: threadId,
        from:     parsed.from || r.from || '',
        subject:  parsed.subject || r.subject || '',
        date:     parsed.date || r.date || '',
        body:     parsed.textBody || (parsed.htmlBody || '').replace(/<[^>]+>/g, ' '),
      });
    } catch (err) {
      console.warn(`[analyzeLinkedThread] fetch ${r.gmailMessageId} failed: ${err.message}`);
    }
  }
  if (messages.length === 0) return { analyzed: 0, proposed: 0, skipped: 'body_fetch_failed' };
  const analysis = await productionExtractor.extractOrFallback({
    messages, shows, showId,
    config: config.llm,
  });
  const written  = await emailIntel.proposeFromAnalysis(analysis, { actor: actor || 'manual-link' });
  return { analyzed: 1, proposed: (written?.written || []).length, source: analysis.source, extractor: analysis.extractor };
}

// ── Windjammer relevance filter ───────────────────────────────────────────────
// Every Gmail query is AND-ed with this so we only ingest show-related mail.
const WINDJAMMER_KEYWORDS = [
  'windjammer',
  '"isle of palms"',
  'IOP',
  'advance',
  'rider',
  '"load-in"',
  'load-in',
  'settlement',
];

function quoteToken(t) {
  const s = (t || '').trim();
  if (!s) return null;
  return /\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

async function getAllShowNameTokens() {
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const set = new Set();
    for (const s of shows) {
      const a = quoteToken(s.artist);     if (a) set.add(a);
      const e = quoteToken(s.eventName);  if (e) set.add(e);
    }
    return [...set];
  } catch { return []; }
}

// Filter for the whole-inbox sync — any Windjammer keyword or any show artist/event.
async function buildInboxRelevanceFilter() {
  const showTokens = await getAllShowNameTokens();
  const tokens = [...WINDJAMMER_KEYWORDS, ...showTokens];
  return `(${tokens.join(' OR ')})`;
}

// Filter for one specific show — must reference THIS show's artist/event, or
// fall back to the general Windjammer keywords if no artist/event is recorded.
async function buildShowRelevanceFilter(showId) {
  let artist = '', eventName = '';
  try {
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const s = shows.find(x => x.id === showId);
    if (s) { artist = s.artist || ''; eventName = s.eventName || ''; }
  } catch {}
  const tokens = [];
  const a = quoteToken(artist);    if (a) tokens.push(a);
  const e = quoteToken(eventName); if (e) tokens.push(e);
  tokens.push('windjammer');
  return `(${tokens.join(' OR ')})`;
}

// Build searchable date variants for a YYYY-MM-DD date string.
// Returns lowercase strings to match against email subject + snippet.
function dateVariants(dateStr) {
  if (!dateStr) return [];
  const d = new Date(dateStr);
  if (isNaN(d)) return [];
  const months    = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthsAbb = ['jan','feb','mar','apr','may','jun','jul','aug','sep','sept','oct','nov','dec'];
  const m  = d.getUTCMonth(), day = d.getUTCDate(), y = d.getUTCFullYear();
  const pad = n => String(n).padStart(2, '0');
  return [
    dateStr.toLowerCase(),
    `${pad(m+1)}/${pad(day)}/${y}`,
    `${m+1}/${day}/${y}`,
    `${m+1}/${day}`,
    `${months[m]} ${day}`,
    `${months[m]} ${day}, ${y}`,
    `${monthsAbb[m]} ${day}`,
    `${monthsAbb[m]} ${day}, ${y}`,
    `${day} ${months[m]}`,
    `${day} ${monthsAbb[m]}`,
  ].map(s => s.toLowerCase());
}

// Classify a parsed email to the most likely show.
// Thin wrapper around bot.classifyEmailToShow so server callers don't change.
function classifyEmailToShow(parsed, shows, advances = [], artists = []) {
  return bot.classifyEmailToShow(parsed, shows, advances, artists);
}

// Build a Gmail search clause from a list of label mappings. Returns either
// '' (no mappings) or ' OR label:"X" OR label:"Y"'. Used to extend the base
// (in:inbox OR in:sent) query so labels living outside the inbox still sync.
function buildLabelOrClause(mappings) {
  if (!mappings || mappings.length === 0) return '';
  const seen = new Set();
  const parts = [];
  for (const m of mappings) {
    if (!m.labelName || seen.has(m.labelName)) continue;
    seen.add(m.labelName);
    // Gmail label syntax: label:"My Label/Sub" — quote to allow spaces & slashes
    parts.push(`label:"${String(m.labelName).replace(/"/g, '')}"`);
  }
  return parts.length ? ' OR ' + parts.join(' OR ') : '';
}

// Expand a list of synced-label rows so that any "parent" label (e.g. "Tours")
// also pulls in every child ("Tours/2026", "Tours/2026/Artist", …).
// `allLabels` is the full label listing fetched once from Gmail.
function expandParentLabels(syncedRows, allLabels) {
  if (!syncedRows?.length || !allLabels?.length) return syncedRows || [];
  const byId = new Map(allLabels.map(l => [l.id, l]));
  const out = [];
  const seenIds = new Set();
  for (const row of syncedRows) {
    const lbl = byId.get(row.labelId);
    if (!lbl) { // label deleted in Gmail — still try by name
      if (!seenIds.has(row.labelId)) { seenIds.add(row.labelId); out.push(row); }
      continue;
    }
    if (!seenIds.has(lbl.id)) { seenIds.add(lbl.id); out.push({ labelId: lbl.id, labelName: lbl.name }); }
    const prefix = lbl.name + '/';
    for (const cand of allLabels) {
      if (cand.id === lbl.id) continue;
      if (cand.name.startsWith(prefix) && !seenIds.has(cand.id)) {
        seenIds.add(cand.id);
        out.push({ labelId: cand.id, labelName: cand.name });
      }
    }
  }
  return out;
}

// Combined search clause for a user: mapped labels + opted-in synced labels.
// When `client` is supplied we expand parent labels via a live Gmail label list.
async function buildUserLabelClause(userId, client) {
  let mappings = [];
  let synced   = [];
  try { mappings = await getLabelMappings(userId); } catch {}
  try { synced   = await getSyncedLabels(userId); } catch {}
  if (client && synced.length) {
    try {
      const allLabels = await gmail.listLabels(client);
      synced = expandParentLabels(synced, allLabels);
    } catch { /* best-effort — fall back to literal list */ }
  }
  return buildLabelOrClause([...mappings, ...synced]);
}

// If a parsed message carries any label mapped to a show, return that mapping.
function matchLabelMapping(parsedLabelIds, mappings) {
  if (!mappings || mappings.length === 0 || !parsedLabelIds) return null;
  const set = new Set(parsedLabelIds);
  return mappings.find(m => set.has(m.labelId)) || null;
}

async function getSyncedLabels(userId) {
  try {
    const all = await sheets.getRows(config.googleSheets.sheets.gmailSyncedLabels);
    return userId ? all.filter(r => r.userId === userId) : all;
  } catch { return []; }
}

// Helper: sync Gmail for one show. If an advance contact email is known,
// scope to messages to/from that address. Otherwise fall back to a
// show-relevance search across the user's inbox + sent mail.
async function syncEmailsForShow(showId, advanceEmail, showName, client = null, sourceUserId = '', sourceEmail = '', storedKeys = null) {
  if (!gmail.isConfigured() && !client) return 0;

  const relevance = await buildShowRelevanceFilter(showId);
  const query = advanceEmail
    ? `({to:${advanceEmail} from:${advanceEmail}}) ${relevance}`
    : `(in:inbox OR in:sent) ${relevance}`;
  let messageRefs;
  try {
    messageRefs = await gmail.searchEmails(query, 100, client);
  } catch (err) {
    console.error('Gmail search error for show', showId, err.message);
    return 0;
  }

  // Resolve the show's artist once so every appended row tags it.
  let artistId = '', artistName = '';
  try {
    const [shows, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    const show = shows.find(s => s.id === showId);
    const artist = findArtistForShow(show, artists);
    if (artist) { artistId = artist.id; artistName = artist.name || ''; }
  } catch { /* artist lookup is best-effort */ }

  // Dedup by source+messageId so the same message in two mailboxes is stored separately.
  if (!storedKeys) {
    const existing = await getStoredEmails();
    storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
  }
  const dupKey = (id) => `${sourceUserId}|${id}`;

  let newCount = 0;
  const toAppend = [];
  const analyzable = [];
  for (const ref of messageRefs) {
    if (storedKeys.has(dupKey(ref.id))) continue;
    try {
      const msg = await gmail.getMessage(ref.id, client);
      const parsed = gmail.parseMessage(msg);

      const meEmail = (sourceEmail || process.env.GMAIL_USER || '').toLowerCase();
      const direction = meEmail && parsed.from.toLowerCase().includes(meEmail)
        ? 'outbound' : 'inbound';

      const emailRecord = {
        id:              `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        showId,
        showName:        showName || '',
        artistId,
        artistName,
        gmailThreadId:   parsed.gmailThreadId,
        gmailMessageId:  parsed.gmailMessageId,
        from:            parsed.from,
        to:              parsed.to,
        cc:              parsed.cc,
        subject:         parsed.subject,
        snippet:         parsed.snippet.slice(0, 300),
        date:            parsed.date,
        direction,
        attachmentMeta:  JSON.stringify(parsed.attachments),
        syncedAt:        new Date().toISOString(),
        sourceUserId,
        sourceEmail,
      };

      toAppend.push(emailRecord);
      if (direction === 'inbound' && showId) {
        analyzable.push({
          showId,
          parsed: {
            id:       parsed.gmailMessageId,
            threadId: parsed.gmailThreadId,
            from:     parsed.from,
            subject:  parsed.subject,
            date:     parsed.date,
            body:     parsed.textBody || (parsed.htmlBody || '').replace(/<[^>]+>/g, ' '),
          },
        });
      }
      storedKeys.add(dupKey(ref.id));
      newCount++;
    } catch (e) {
      console.error('Error syncing message', ref.id, e.message);
    }
  }
  if (toAppend.length) {
    await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
  }
  // Charter-safe: staged as pending — PM must approve. Same guardrails as auto-sync.
  if (analyzable.length) {
    try {
      const shows = await sheets.getRows(config.googleSheets.sheets.shows);
      await analyzeInboundThreads(analyzable, shows, 'sync-for-show');
    } catch (err) {
      console.error(`[sync-for-show] analyze failed for show=${showId}: ${err.message}`);
    }
  }
  return newCount;
}

// Group a list of {showId, parsed} into (showId,threadId) buckets and run
// the LLM extractor on each. proposeFromAnalysis dedupes so re-runs are safe.
async function analyzeInboundThreads(analyzable, shows, actor) {
  if (!analyzable || !analyzable.length) return { threads: 0, proposed: 0 };
  const groups = new Map();
  for (const a of analyzable) {
    const key = `${a.showId}|${a.parsed.threadId}`;
    if (!groups.has(key)) groups.set(key, { showId: a.showId, parsed: [] });
    groups.get(key).parsed.push(a.parsed);
  }
  let proposed = 0;
  for (const { showId, parsed } of groups.values()) {
    try {
      const analysis = await productionExtractor.extractOrFallback({
        messages: parsed, shows, showId, config: config.llm,
      });
      const written = await emailIntel.proposeFromAnalysis(analysis, { actor });
      const n = (written?.written || []).length;
      proposed += n;
      console.log(`[${actor}] analyzed show=${showId} thread=${parsed[0]?.threadId} source=${analysis.source} proposed=${n}`);
    } catch (err) {
      console.error(`[${actor}] analyze failed for show=${showId} thread=${parsed[0]?.threadId}: ${err.message}`);
    }
  }
  return { threads: groups.size, proposed };
}

// GET /api/emails?showId=xxx | ?artistId=xxx  — list stored emails
app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const { showId, artistId } = req.query;
    const all = await getStoredEmails();
    const visible = await filterEmailsByVisibility(all, req.user);
    let data = visible;
    if (showId)   data = data.filter(e => e.showId === showId);
    if (artistId) data = data.filter(e => e.artistId === artistId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/:id/assign  — manually link a stored email to a show
// body: { showId, setAdvanceEmail?: boolean }
// If setAdvanceEmail is true, the email's sender (or recipient if outbound)
// is also written into the Advancing record's advanceEmail so future syncs
// pick up the contact automatically.
app.post('/api/emails/:id/assign', requireAuth, requireRole('admin', 'production_manager', 'stage_manager', 'promoter'), async (req, res) => {
  try {
    const { id } = req.params;
    const { showId, artistId: bodyArtistId, setAdvanceEmail } = req.body;
    if (!showId && !bodyArtistId) return res.status(400).json({ success: false, message: 'showId or artistId required' });

    // Look up the email row
    const all = await getStoredEmails();
    const email = all.find(e => e.id === id);
    if (!email) return res.status(404).json({ success: false, message: 'Email not found' });

    const [shows, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);

    let updates = {};
    let show = null;
    let showName = '';
    if (showId) {
      show = shows.find(s => s.id === showId);
      if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
      showName = `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim();
      updates.showId = showId;
      updates.showName = showName;
    }

    // Resolve the artist: prefer explicit body value, else derive from the show.
    let artist = null;
    if (bodyArtistId) artist = artists.find(a => a.id === bodyArtistId) || null;
    if (!artist && show) artist = findArtistForShow(show, artists);
    if (artist) {
      updates.artistId = artist.id;
      updates.artistName = artist.name || '';
    } else if (bodyArtistId && !showId) {
      // artistId was provided but didn't match — fail loudly
      return res.status(404).json({ success: false, message: 'Artist not found' });
    }

    await sheets.updateRowById(config.googleSheets.sheets.emails, id, updates);

    // The Emails sheet stores the Gmail thread ID under gmailThreadId, but
    // EmailFacts / EmailIssues store the same underlying value under
    // threadId — both come from Gmail's thread id.
    const gTid = email.gmailThreadId || email.threadId || '';

    // Propagate the assignment to EmailFacts + EmailIssues so the show brief,
    // waiting-on tracker, and email-intel views actually see the newly linked
    // thread. Without this step, facts extracted at scrape time keep their
    // old (often empty) showId and remain invisible to the show.
    let factsUpdated = 0;
    let issuesUpdated = 0;
    if (showId && gTid) {
      try {
        const [facts, issues] = await Promise.all([
          sheets.getRows(config.googleSheets.sheets.emailFacts).catch(() => []),
          sheets.getRows(config.googleSheets.sheets.emailIssues).catch(() => []),
        ]);
        for (const f of facts) {
          if (f.threadId === gTid && f.showId !== showId) {
            await sheets.updateRowById(config.googleSheets.sheets.emailFacts, f.id, { showId });
            factsUpdated++;
          }
        }
        for (const i of issues) {
          if (i.threadId === gTid && i.showId !== showId) {
            await sheets.updateRowById(config.googleSheets.sheets.emailIssues, i.id, { showId });
            issuesUpdated++;
          }
        }
      } catch (err) {
        console.warn('[assign email] fact/issue propagation failed:', err.message);
      }
    }

    // Auto-analyze the freshly-linked thread so the bot pulls real facts out
    // of it — even if it was never analyzed at scrape time. Best-effort.
    let autoAnalyzed = 0, autoProposed = 0;
    if (showId && gTid) {
      try {
        const r = await analyzeLinkedThread({
          threadId: gTid, showId, shows, allEmails: all, actor: 'manual-link:' + req.user.id,
        });
        autoAnalyzed = r.analyzed || 0;
        autoProposed = r.proposed || 0;
      } catch (err) {
        console.warn('[assign email] auto-analyze failed:', err.message);
      }
    }

    // Optionally set advance email on the Advancing record
    let advanceEmailSet = null;
    if (setAdvanceEmail && showId) {
      // Extract just the address from "Name <addr@x.com>" if present
      const raw = email.direction === 'outbound' ? email.to : email.from;
      const m = (raw || '').match(/<([^>]+)>/);
      const addr = (m ? m[1] : raw || '').trim();
      if (addr) {
        const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
        const adv = advances.find(a => a.showId === showId);
        if (adv) {
          await sheets.updateRowById(config.googleSheets.sheets.advancing, adv.id, { advanceEmail: addr });
          advanceEmailSet = addr;
        }
      }
    }

    res.json({
      success: true,
      showId: updates.showId || '',
      showName,
      artistId: updates.artistId || '',
      artistName: updates.artistName || '',
      advanceEmailSet,
      factsUpdated,
      issuesUpdated,
      autoAnalyzed,
      autoProposed,
    });
  } catch (err) {
    console.error('Assign email error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/assign-bulk — link many stored emails to one show OR one
// artist in a single request. Body: { ids: string[], showId?: string, artistId?: string }
// At least one of showId / artistId must be provided. If both are supplied,
// the show's matched artist is used (body artistId is ignored when showId is set).
// Returns: { success, showId, showName, artistId, artistName, linked, missing }
app.post('/api/emails/assign-bulk', requireAuth, requireRole('admin', 'production_manager', 'stage_manager', 'promoter'), async (req, res) => {
  try {
    const { ids, showId, artistId: bodyArtistId } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'ids[] required' });
    if (!showId && !bodyArtistId) return res.status(400).json({ success: false, message: 'showId or artistId required' });

    const [shows, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);

    const updates = {};
    let show = null, showName = '';
    if (showId) {
      show = shows.find(s => s.id === showId);
      if (!show) return res.status(404).json({ success: false, message: 'Show not found' });
      showName = `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim();
      updates.showId = showId;
      updates.showName = showName;
    }

    let artist = null;
    if (bodyArtistId) artist = artists.find(a => a.id === bodyArtistId) || null;
    if (!artist && show) artist = findArtistForShow(show, artists);
    if (artist) {
      updates.artistId = artist.id;
      updates.artistName = artist.name || '';
    } else if (bodyArtistId && !showId) {
      return res.status(404).json({ success: false, message: 'Artist not found' });
    }

    const all = await getStoredEmails();
    const present = new Set(all.map(e => e.id));
    const valid = ids.filter(id => present.has(id));
    const missing = ids.filter(id => !present.has(id));

    // Sheets API has no bulk update; run sequentially to stay under quota.
    for (const id of valid) {
      await sheets.updateRowById(config.googleSheets.sheets.emails, id, updates);
    }

    // Propagate to EmailFacts + EmailIssues for every touched thread. Without
    // this, previously-scraped facts/issues stay tagged to their old showId
    // (often empty) and never appear in the show brief.
    let factsUpdated = 0, issuesUpdated = 0;
    let threadIds = new Set();
    if (showId && valid.length) {
      try {
        threadIds = new Set(
          valid
            .map(id => all.find(e => e.id === id))
            .filter(Boolean)
            .map(e => e.gmailThreadId || e.threadId)
            .filter(Boolean),
        );
        const [facts, issues] = await Promise.all([
          sheets.getRows(config.googleSheets.sheets.emailFacts).catch(() => []),
          sheets.getRows(config.googleSheets.sheets.emailIssues).catch(() => []),
        ]);
        for (const f of facts) {
          if (threadIds.has(f.threadId) && f.showId !== showId) {
            await sheets.updateRowById(config.googleSheets.sheets.emailFacts, f.id, { showId });
            factsUpdated++;
          }
        }
        for (const i of issues) {
          if (threadIds.has(i.threadId) && i.showId !== showId) {
            await sheets.updateRowById(config.googleSheets.sheets.emailIssues, i.id, { showId });
            issuesUpdated++;
          }
        }
      } catch (err) {
        console.warn('[bulk assign email] fact/issue propagation failed:', err.message);
      }
    }

    // Auto-analyze each newly-linked thread so the bot pulls real facts from
    // the underlying Gmail bodies. Best-effort per thread — one bad thread
    // must not kill the batch response.
    let autoAnalyzed = 0, autoProposed = 0;
    if (showId && threadIds.size) {
      for (const tid of threadIds) {
        try {
          const r = await analyzeLinkedThread({
            threadId: tid, showId, shows, allEmails: all, actor: 'manual-link-bulk:' + req.user.id,
          });
          autoAnalyzed += r.analyzed || 0;
          autoProposed += r.proposed || 0;
        } catch (err) {
          console.warn(`[bulk assign email] auto-analyze thread ${tid} failed: ${err.message}`);
        }
      }
    }

    res.json({
      success: true,
      showId: updates.showId || '',
      showName,
      artistId: updates.artistId || '',
      artistName: updates.artistName || '',
      linked: valid.length,
      missing,
      factsUpdated,
      issuesUpdated,
      autoAnalyzed,
      autoProposed,
    });
  } catch (err) {
    console.error('Bulk assign email error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/advancement/:showId/reanalyze-emails — re-run the AI analyzer
// on every email currently linked to this show. Useful for shows whose
// emails were linked before auto-analyze-on-assign existed, or when the
// PM wants to refresh proposals after re-linking. proposeFromAnalysis
// dedupes so replays never spam duplicates.
app.post('/api/advancement/:showId/reanalyze-emails', requireAuth, requireShowAccess, requireRole('admin','production_manager','stage_manager'), async (req, res) => {
  try {
    const { showId } = req.params;
    const [shows, allEmails] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      getStoredEmails(),
    ]);
    const show = shows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found' });

    const threadIds = new Set(
      allEmails.filter(e => e.showId === showId).map(e => e.gmailThreadId).filter(Boolean),
    );
    if (threadIds.size === 0) {
      return res.json({ success: true, threads: 0, analyzed: 0, proposed: 0, message: 'No linked emails on this show.' });
    }

    let analyzed = 0, proposed = 0;
    for (const tid of threadIds) {
      try {
        const r = await analyzeLinkedThread({
          threadId: tid, showId, shows, allEmails, actor: 'reanalyze:' + req.user.id,
        });
        analyzed += r.analyzed || 0;
        proposed += r.proposed || 0;
      } catch (err) {
        console.warn(`[reanalyze] thread ${tid}: ${err.message}`);
      }
    }
    res.json({ success: true, threads: threadIds.size, analyzed, proposed });
  } catch (err) {
    console.error('Reanalyze emails error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/email-intel/reanalyze-all — one-click catch-up. Runs the LLM
// extractor on EVERY (show, thread) pair currently stored. Throttled to be
// gentle on Anthropic. Admin only. proposeFromAnalysis dedupes so re-running
// is a safe no-op if nothing changed.
app.post('/api/email-intel/reanalyze-all', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [shows, allEmails] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      getStoredEmails(),
    ]);
    const bucket = new Map(); // showId -> Set(threadId)
    for (const e of allEmails) {
      if (!e.showId || !e.gmailThreadId) continue;
      if (!bucket.has(e.showId)) bucket.set(e.showId, new Set());
      bucket.get(e.showId).add(e.gmailThreadId);
    }
    let shows_touched = 0, threads = 0, analyzed = 0, proposed = 0;
    for (const [showId, tids] of bucket.entries()) {
      shows_touched++;
      for (const tid of tids) {
        threads++;
        try {
          const r = await analyzeLinkedThread({
            threadId: tid, showId, shows, allEmails, actor: 'reanalyze-all:' + req.user.id,
          });
          analyzed += r.analyzed || 0;
          proposed += r.proposed || 0;
        } catch (err) {
          console.warn(`[reanalyze-all] show=${showId} thread=${tid}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
    res.json({ success: true, shows: shows_touched, threads, analyzed, proposed });
  } catch (err) {
    console.error('Reanalyze-all error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/relink-all  — clear all show links and re-classify every
// stored email against the current shows + advances + artist registry.
// Body: { mode?: 'reset' | 'fill' }
//   - 'reset' (default): unlinks everything first, then re-matches.
//   - 'fill': only assigns links to emails that don't currently have a showId.
app.post('/api/emails/relink-all', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const mode = (req.body?.mode || 'reset').toLowerCase();
    const [all, shows, advances, artists] = await Promise.all([
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);

    let cleared = 0, linked = 0, unchanged = 0, processed = 0;
    for (const row of all) {
      processed++;
      const had = !!row.showId;
      // Build a "parsed-like" object from the stored row for the classifier
      const parsed = {
        subject: row.subject || '',
        snippet: row.snippet || '',
        from:    row.from    || '',
        to:      row.to      || '',
        cc:      row.cc      || '',
        date:    row.date    || '',
      };
      const match = classifyEmailToShow(parsed, shows, advances, artists);
      const targetShowId     = match?.showId     || '';
      const targetShowName   = match?.showName   || '';
      const targetArtistId   = match?.artistId   || '';
      const targetArtistName = match?.artistName || '';

      if (mode === 'fill' && had) { unchanged++; continue; }

      const changed = (row.showId     || '') !== targetShowId
                    || (row.showName   || '') !== targetShowName
                    || (row.artistId   || '') !== targetArtistId
                    || (row.artistName || '') !== targetArtistName;
      if (!changed) { unchanged++; continue; }

      try {
        await sheets.updateRowById(config.googleSheets.sheets.emails, row.id, {
          showId:     targetShowId,
          showName:   targetShowName,
          artistId:   targetArtistId,
          artistName: targetArtistName,
        });
        if (targetShowId || targetArtistId) linked++;
        else if (had) cleared++;
      } catch (e) {
        console.error('relink-all row update failed', row.id, e.message);
      }
    }

    res.json({ success: true, processed, linked, cleared, unchanged, mode });
  } catch (err) {
    console.error('relink-all error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/emails/suggest-links  — let the bot suggest a show for every
// currently-unlinked stored email. Read-only: returns suggestions for the
// UI to display so the user can accept/reject in bulk.
// Query: ?minConfidence=high|medium|low (default 'medium')
//        ?fetchBody=1                  (fetch full Gmail body for the top 50
//                                       suggestions so context drives matches
//                                       — slower; default off)
// Returns: { suggestions: [{ emailId, subject, from, date, snippet,
//             suggestion: { showId, showName, confidence, reason, score } }] }
app.get('/api/emails/suggest-links', requireAuth, async (req, res) => {
  try {
    const minConf = String(req.query.minConfidence || 'medium').toLowerCase();
    const fetchBody = req.query.fetchBody === '1' || req.query.fetchBody === 'true';
    const order = { low: 1, medium: 2, high: 3 };
    const threshold = order[minConf] || 2;

    const [allEmails, shows, advances, artists] = await Promise.all([
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    const visible  = await filterEmailsByVisibility(allEmails, req.user);
    const unlinked = visible.filter(e => !e.showId);

    // Optional: pull full body for the most recent unlinked messages to give
    // the bot real "context" beyond the 300-char snippet.
    const enriched = new Map(); // emailId -> { textBody, htmlBody }
    if (fetchBody) {
      const picked = await pickGmailClient(req);
      if (picked) {
        const top = [...unlinked]
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 50);
        for (const e of top) {
          try {
            const msg = await gmail.getMessage(e.gmailMessageId, picked.client);
            const parsed = gmail.parseMessage(msg);
            enriched.set(e.id, { textBody: parsed.textBody, htmlBody: parsed.htmlBody });
          } catch { /* skip on per-message failure */ }
        }
      }
    }

    const suggestions = [];
    for (const e of unlinked) {
      const extra = enriched.get(e.id) || {};
      const parsed = {
        subject: e.subject || '',
        snippet: e.snippet || '',
        from:    e.from    || '',
        to:      e.to      || '',
        cc:      e.cc      || '',
        date:    e.date    || '',
        textBody: extra.textBody || '',
        htmlBody: extra.htmlBody || '',
      };
      const match = bot.classifyEmailToShow(parsed, shows, advances, artists);
      if (!match) continue;
      const conf = order[match.confidence] || 1;
      if (conf < threshold) continue;
      suggestions.push({
        emailId: e.id,
        subject: e.subject,
        from:    e.from,
        date:    e.date,
        snippet: e.snippet,
        showName: e.showName || '',
        suggestion: match,
      });
    }
    // Sort: highest confidence first, then most recent
    suggestions.sort((a, b) => {
      const cd = (order[b.suggestion.confidence] || 0) - (order[a.suggestion.confidence] || 0);
      if (cd !== 0) return cd;
      return new Date(b.date) - new Date(a.date);
    });
    res.json({
      success: true,
      total: unlinked.length,
      suggestionCount: suggestions.length,
      bodyEnriched: fetchBody,
      suggestions,
    });
  } catch (err) {
    console.error('suggest-links error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/sync  — pull Gmail for one advance record
app.post('/api/emails/sync', requireAuth, async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured. Connect your Gmail in Settings.' });
    const { showId, advanceEmail, showName } = req.body;
    const count = await syncEmailsForShow(showId, advanceEmail, showName, picked.client, picked.user?.id || '', picked.user?.gmailEmail || '');
    res.json({ success: true, newEmails: count, mailbox: picked.source });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/sync-all  — sync all open advances (also called by auto-sync)
app.post('/api/emails/sync-all', requireAuth, requireRole('admin', 'production_manager', 'stage_manager', 'promoter'), async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured.' });
    const advances = await sheets.getRows(config.googleSheets.sheets.advancing);
    const open = advances.filter(a => a.advancingComplete !== 'true' && a.advanceEmail);
    // Pre-fetch emails sheet once to avoid burning per-minute read quota in the loop.
    const existing = await getStoredEmails();
    const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
    let total = 0;
    for (const adv of open) {
      total += await syncEmailsForShow(adv.showId, adv.advanceEmail, adv.showName, picked.client, picked.user?.id || '', picked.user?.gmailEmail || '', storedKeys);
      // Small delay to avoid Gmail rate limits
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ success: true, synced: open.length, newEmails: total });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/emails/send  — compose or reply to an email
app.post('/api/emails/send', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured. See .env.example.' });
  try {
    const { showId, showName, to, cc, subject, body, attachments, inReplyToMsgId, threadId } = req.body;
    if (!to || !subject || !body)
      return res.status(400).json({ success: false, message: 'to, subject, and body are required' });

    const sent = await gmail.sendEmail({ to, cc, subject, body, attachments, inReplyToMsgId, threadId });

    // Store the sent email in Sheets
    const emailRecord = {
      id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      showId:         showId || '',
      showName:       showName || '',
      gmailThreadId:  sent.threadId,
      gmailMessageId: sent.id,
      from:           gmail.GMAIL_USER,
      to,
      cc:             cc || '',
      subject,
      snippet:        body.replace(/<[^>]+>/g, '').slice(0, 200),
      date:           new Date().toISOString(),
      direction:      'outbound',
      attachmentMeta: JSON.stringify((attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, size: 0 }))),
      syncedAt:       new Date().toISOString(),
    };

    await sheets.appendRow(config.googleSheets.sheets.emails, emailRecord);
    res.json({ success: true, data: emailRecord });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/emails/message/:gmailMessageId  — fetch full body + attachments from Gmail
app.get('/api/emails/message/:gmailMessageId', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const msg = await gmail.getMessage(req.params.gmailMessageId);
    const parsed = gmail.parseMessage(msg);
    res.json({
      htmlBody:    parsed.htmlBody,
      textBody:    parsed.textBody,
      attachments: parsed.attachments,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/emails/attachment  — proxy a Gmail attachment to the browser
app.get('/api/emails/attachment', requireAuth, async (req, res) => {
  if (!gmail.isConfigured())
    return res.status(503).json({ success: false, message: 'Gmail not configured.' });
  try {
    const { messageId, attachmentId, filename } = req.query;
    if (!messageId || !attachmentId)
      return res.status(400).json({ success: false, message: 'messageId and attachmentId are required' });

    const base64 = await gmail.getAttachmentData(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');

    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'attachment'}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Auto-sync Gmail every 15 minutes ─────────────────────────────────────────
// For every user with a connected Gmail, runs ONE broad inbox/sent search and
// uses content-based classification (artist name, event name, date, contact
// email) to bucket each new message into the right show. This replaces the
// older N-shows × N-users search pattern, so it's both faster and finds
// emails that don't reference a known advance contact.
async function runAutoSync() {
  try {
    const users = await sheets.getRows(config.googleSheets.sheets.users);
    const connected = users.filter(u => u.gmailRefreshToken);
    if (connected.length === 0) return;
    const [shows, advances, existing, artists] = await Promise.all([
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    if (shows.length === 0) return;
    const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));
    const relevance  = await buildInboxRelevanceFilter();

    let grandTotal = 0, grandLinked = 0;
    let grandAnalyzed = 0, grandProposed = 0;
    const affectedShowIds = new Set();
    for (const user of connected) {
      const tag = user.isHouseMailbox === 'true' ? '🏠 ' : '';
      console.log(`[auto-sync] ${tag}Scanning ${user.gmailEmail || user.username}…`);
      const userMappings = await getLabelMappings(user.id);
      let client;
      try {
        client = gmail.getGmailClientForToken(user.gmailRefreshToken);
      } catch (err) {
        console.error(`[auto-sync] Failed to build client for ${user.gmailEmail}: ${err.message}`);
        continue;
      }
      const labelClause = await buildUserLabelClause(user.id, client);
      let messageRefs = [];
      try {
        messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent${labelClause}) ${relevance}`, 150, client);
      } catch (err) {
        if (String(err.message || '').includes('invalid_grant')) {
          console.warn(`[auto-sync] ${user.gmailEmail} token expired — user must reconnect.`);
          continue;
        }
        console.error(`[auto-sync] search failed for ${user.gmailEmail}: ${err.message}`);
        continue;
      }
      const toAppend = [];
      // Parallel array of full parsed messages for AI analysis. Only inbound
      // messages with an assigned showId are candidates — outbound doesn't
      // need extraction (it's ours) and unassigned messages have no show
      // context to attach facts to.
      const analyzable = [];
      let linked = 0;
      for (const ref of messageRefs) {
        if (storedKeys.has(`${user.id}|${ref.id}`)) continue;
        try {
          const msg = await gmail.getMessage(ref.id, client);
          const parsed = gmail.parseMessage(msg);
          const meEmail = (user.gmailEmail || '').toLowerCase();
          const direction = meEmail && parsed.from.toLowerCase().includes(meEmail) ? 'outbound' : 'inbound';
          let match = classifyEmailToShow(parsed, shows, advances, artists);
          if (!match) {
            const mapped = matchLabelMapping(parsed.labelIds, userMappings);
            if (mapped) match = { showId: mapped.showId, showName: mapped.showName };
          }
          if (match) linked++;
          if (match?.showId) affectedShowIds.add(match.showId);
          toAppend.push({
            id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
            showId:         match?.showId     || '',
            showName:       match?.showName   || '',
            artistId:       match?.artistId   || '',
            artistName:     match?.artistName || '',
            gmailThreadId:  parsed.gmailThreadId,
            gmailMessageId: parsed.gmailMessageId,
            from:           parsed.from,
            to:             parsed.to,
            cc:             parsed.cc,
            subject:        parsed.subject,
            snippet:        (parsed.snippet || '').slice(0, 300),
            date:           parsed.date,
            direction,
            attachmentMeta: JSON.stringify(parsed.attachments),
            syncedAt:       new Date().toISOString(),
            sourceUserId:   user.id,
            sourceEmail:    user.gmailEmail || '',
          });
          if (direction === 'inbound' && match?.showId) {
            analyzable.push({
              showId: match.showId,
              parsed: {
                id:       parsed.gmailMessageId,
                threadId: parsed.gmailThreadId,
                from:     parsed.from,
                subject:  parsed.subject,
                date:     parsed.date,
                body:     parsed.textBody || (parsed.htmlBody || '').replace(/<[^>]+>/g, ' '),
              },
            });
          }
          storedKeys.add(`${user.id}|${ref.id}`);
        } catch (err) {
          console.error(`[auto-sync] message ${ref.id}: ${err.message}`);
        }
      }
      if (toAppend.length) {
        try {
          await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
          console.log(`[auto-sync] ${user.gmailEmail}: +${toAppend.length} new (${linked} auto-linked).`);
        } catch (err) {
          console.error(`[auto-sync] append failed for ${user.gmailEmail}: ${err.message}`);
        }
        if (analyzable.length === 0) {
          // Every "new email(s), analyzed 0 thread(s)" report ends up here.
          // Emit the *why* so the operator doesn't have to guess.
          const inbound  = toAppend.filter(r => r.direction === 'inbound').length;
          const outbound = toAppend.length - inbound;
          const unlinked = toAppend.filter(r => r.direction === 'inbound' && !r.showId).length;
          console.log(`[auto-sync] ${user.gmailEmail}: 0 threads analyzable — inbound=${inbound} outbound=${outbound} inbound-without-show=${unlinked}. Only inbound emails auto-linked to a show are analyzed.`);
        }
      }
      // ── Charter-safe auto-analysis ─────────────────────────────────────
      // Group new inbound messages by (showId, gmailThreadId) and stage
      // proposals in EmailFacts. Proposals are ALWAYS pending — the PM must
      // approve each one before it becomes an authoritative row. This
      // preserves the "PM is final authority" invariant while removing the
      // hand-crank of clicking "analyze" on every arriving thread.
      // proposeFromAnalysis dedupes by (messageId, field, scope, showId), so
      // re-syncs never produce duplicate proposals. One bad thread must not
      // stop the sync; each is wrapped independently.
      if (analyzable.length) {
        try {
          const r = await analyzeInboundThreads(analyzable, shows, 'auto-sync');
          grandAnalyzed += r.threads;
          grandProposed += r.proposed;
          console.log(`[auto-sync] ${user.gmailEmail}: analyzed ${r.threads} thread(s) from ${analyzable.length} inbound message(s), proposed=${r.proposed}.`);
        } catch (err) {
          console.error(`[auto-sync] analyze batch failed for ${user.gmailEmail}: ${err.message}`);
        }
      }
      grandTotal  += toAppend.length;
      grandLinked += linked;
      await new Promise(r => setTimeout(r, 1000)); // brief pause between users
    }
    if (grandTotal > 0)
      console.log(`[auto-sync] Done — ${grandTotal} new email(s), ${grandLinked} auto-linked; analyzed ${grandAnalyzed} thread(s), staged ${grandProposed} pending fact(s) across ${connected.length} mailbox(es).`);
  } catch (err) {
    console.error('[auto-sync] Error:', err.message);
  }
}

// Kick off the first run shortly after startup, then every N minutes.
// Opt-in via env: AUTO_SYNC_MINUTES=15 enables 15-minute polling. Anything
// falsy/zero/non-numeric keeps auto-sync disabled and forces PM-triggered
// manual analysis (the original charter-safe default). Auto-analysis inside
// runAutoSync still stages proposals as `pending` — the PM approval gate is
// unchanged whether or not the schedule is enabled.
{
  const mins = Number(process.env.AUTO_SYNC_MINUTES || 0);
  if (Number.isFinite(mins) && mins > 0) {
    console.log(`[auto-sync] scheduled every ${mins} min (proposals stay pending; PM must approve)`);
    setTimeout(runAutoSync, 30 * 1000);
    setInterval(runAutoSync, mins * 60 * 1000);
  }
}

// ── Inbox sync — pull entire Gmail inbox regardless of advance contact ────────
app.post('/api/emails/sync-inbox', requireAuth, async (req, res) => {
  try {
    const picked = await pickGmailClient(req);
    if (!picked) return res.status(503).json({ success: false, message: 'Gmail not configured.' });
    const userMappings = await getLabelMappings(picked.user?.id || '');
    const labelClause = await buildUserLabelClause(picked.user?.id || '', picked.client);
    const relevance = await buildInboxRelevanceFilter();
    const messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent${labelClause}) ${relevance}`, 150, picked.client);
    const [existing, shows, advances, artists] = await Promise.all([
      getStoredEmails(),
      sheets.getRows(config.googleSheets.sheets.shows),
      sheets.getRows(config.googleSheets.sheets.advancing),
      sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
    ]);
    const storedIds = new Set(existing.map(e => e.gmailMessageId));

    let newCount = 0, linked = 0;
    for (const ref of messageRefs) {
      if (storedIds.has(ref.id)) continue;
      try {
        const msg = await gmail.getMessage(ref.id, picked.client);
        const parsed = gmail.parseMessage(msg);
        const sourceEmail = picked.user?.gmailEmail || process.env.GMAIL_USER || '';
        const direction = parsed.from.toLowerCase().includes(sourceEmail.toLowerCase())
          ? 'outbound' : 'inbound';
        // Prefer an explicit label mapping, otherwise let the bot classify
        // using subject + body + artist/date context.
        let match = null;
        const mapped = matchLabelMapping(parsed.labelIds, userMappings);
        if (mapped) match = { showId: mapped.showId, showName: mapped.showName };
        else        match = bot.classifyEmailToShow(parsed, shows, advances, artists);
        if (match) linked++;
        const emailRecord = {
          id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          showId:         match?.showId     || '',
          showName:       match?.showName   || '',
          artistId:       match?.artistId   || '',
          artistName:     match?.artistName || '',
          gmailThreadId:  parsed.gmailThreadId,
          gmailMessageId: parsed.gmailMessageId,
          from:           parsed.from,
          to:             parsed.to,
          cc:             parsed.cc,
          subject:        parsed.subject,
          snippet:        (parsed.snippet || '').slice(0, 300),
          date:           parsed.date,
          direction,
          attachmentMeta: JSON.stringify(parsed.attachments),
          syncedAt:       new Date().toISOString(),
          sourceUserId:   picked.user?.id || '',
          sourceEmail,
        };
        await sheets.appendRow(config.googleSheets.sheets.emails, emailRecord);
        storedIds.add(ref.id);
        newCount++;
      } catch (e) {
        console.error('Error syncing inbox message', ref.id, e.message);
      }
    }
    res.json({ success: true, newEmails: newCount, autoLinked: linked, mailbox: picked.source });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Your Gmail connection has expired. Reconnect in Settings.' });
    console.error('Inbox sync error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Per-user Gmail OAuth ──────────────────────────────────────────────────────────────
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI
  || `http://localhost:${config.port}/api/gmail/callback`;

async function getUserById(userId) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);
  return users.find(u => u.id === userId);
}

// Pick a Gmail OAuth client to use for an outbound API call (sync / send / fetch).
// Order of preference:
//   1. The requesting user's own connected Gmail (if any).
//   2. Any user marked isHouseMailbox === 'true' (shared "house" account).
//   3. The legacy shared mailbox configured via env vars (may have stale token).
// Returns { client, user, source } or null if nothing usable.
async function pickGmailClient(req) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);

  // 1. Requester's own Gmail
  if (req?.user?.id) {
    const me = users.find(u => u.id === req.user.id);
    if (me?.gmailRefreshToken) {
      return { client: gmail.getGmailClientForToken(me.gmailRefreshToken), user: me, source: 'self' };
    }
  }

  // 2. House mailbox
  const house = users.find(u => String(u.isHouseMailbox).toLowerCase() === 'true' && u.gmailRefreshToken);
  if (house) {
    return { client: gmail.getGmailClientForToken(house.gmailRefreshToken), user: house, source: 'house' };
  }

  // 3. Legacy env-based client (may be invalid)
  if (gmail.isConfigured()) {
    return { client: null, user: null, source: 'legacy' };
  }
  return null;
}

// Decide which stored-email rows the requesting user is allowed to see.
// Rules:
//   - rows with no sourceUserId (legacy/shared mailbox)  → visible to everyone
//   - rows whose sourceUser is flagged isHouseMailbox=true → visible to everyone
//   - rows whose sourceUserId equals the requester        → visible to that user
async function filterEmailsByVisibility(rows, requester) {
  const users = await sheets.getRows(config.googleSheets.sheets.users);
  const houseIds = new Set(users.filter(u => String(u.isHouseMailbox).toLowerCase() === 'true').map(u => u.id));
  return rows.filter(r => {
    if (!r.sourceUserId) return true;
    if (houseIds.has(r.sourceUserId)) return true;
    return r.sourceUserId === requester.id;
  });
}

// GET /api/gmail/me — current user's connection status
app.get('/api/gmail/me', requireAuth, async (req, res) => {
  try {
    if (!gmail.hasClientCredentials())
      return res.json({ success: true, configured: false });
    const u = await getUserById(req.user.id);
    res.json({
      success: true,
      configured: true,
      connected: !!(u && u.gmailRefreshToken),
      gmailEmail: u?.gmailEmail || '',
      isHouseMailbox: String(u?.isHouseMailbox).toLowerCase() === 'true',
      connectedAt: u?.gmailConnectedAt || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gmail/auth-url — returns the Google consent URL for this user
app.get('/api/gmail/auth-url', requireAuth, (req, res) => {
  if (!gmail.hasClientCredentials())
    return res.status(503).json({ success: false, message: 'Gmail client credentials not configured.' });
  // Short-lived signed state so the callback can prove which user authorized.
  const state = jwt.sign({ uid: req.user.id, t: 'gmail-oauth' }, config.jwtSecret, { expiresIn: '10m' });
  const url = gmail.buildAuthUrl({ state, redirectUri: OAUTH_REDIRECT_URI });
  res.json({ success: true, url });
});

// GET /api/gmail/callback — Google redirects here with ?code & ?state
app.get('/api/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const closeHtml = (title, body, ok) => `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0b1220;color:${ok?'#86efac':'#fca5a5'}"><h2>${title}</h2><p>${body}</p><p style="color:#94a3b8">You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`;
  if (error) return res.status(400).send(closeHtml('Authorization denied', String(error), false));
  if (!code || !state) return res.status(400).send(closeHtml('Missing code or state', '', false));
  try {
    const decoded = jwt.verify(state, config.jwtSecret);
    if (decoded.t !== 'gmail-oauth') throw new Error('Bad state token');
    const userId = decoded.uid;
    const { refreshToken, email } = await gmail.exchangeCodeForTokens({ code, redirectUri: OAUTH_REDIRECT_URI });
    if (!refreshToken) {
      return res.status(400).send(closeHtml('No refresh token returned',
        'Google did not issue a refresh token. Revoke the app at myaccount.google.com/permissions and try again.', false));
    }
    await sheets.updateRowById(config.googleSheets.sheets.users, userId, {
      gmailRefreshToken: refreshToken,
      gmailEmail:        email || '',
      gmailConnectedAt:  new Date().toISOString(),
    });
    res.send(closeHtml('✅ Gmail connected', `Connected as <code>${email}</code>.`, true));
  } catch (err) {
    console.error('Gmail callback error:', err.message);
    res.status(400).send(closeHtml('Authorization failed', err.message, false));
  }
});

// POST /api/gmail/disconnect — current user revokes their connection
app.post('/api/gmail/disconnect', requireAuth, async (req, res) => {
  try {
    await sheets.updateRowById(config.googleSheets.sheets.users, req.user.id, {
      gmailRefreshToken: '',
      gmailEmail:        '',
      gmailConnectedAt:  '',
      isHouseMailbox:    'false',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/gmail/house/:userId — admin sets/unsets the "house" mailbox flag
app.post('/api/gmail/house/:userId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { isHouse } = req.body;
    const target = await getUserById(userId);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (isHouse && !target.gmailRefreshToken)
      return res.status(400).json({ success: false, message: 'User has not connected Gmail.' });
    await sheets.updateRowById(config.googleSheets.sheets.users, userId, {
      isHouseMailbox: isHouse ? 'true' : 'false',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Per-user Gmail label → show mappings ──────────────────────────────────────
// Any synced email carrying one of these labels gets auto-linked to the show,
// and the label is included in the sync search so messages outside the inbox
// (filtered straight into a folder) are still picked up.
async function getLabelMappings(userId) {
  try {
    const all = await sheets.getRows(config.googleSheets.sheets.gmailLabelMappings);
    return userId ? all.filter(m => m.userId === userId) : all;
  } catch { return []; }
}

// GET /api/gmail/labels — list current user's Gmail labels
app.get('/api/gmail/labels', requireAuth, async (req, res) => {
  try {
    const u = await getUserById(req.user.id);
    if (!u || !u.gmailRefreshToken)
      return res.status(400).json({ success: false, message: 'Connect your Gmail first.' });
    const client = gmail.getGmailClientForToken(u.gmailRefreshToken);
    const labels = await gmail.listLabels(client);
    // Drop the noisy system-only labels users don't care about
    const hidden = new Set(['CHAT', 'SPAM', 'TRASH', 'DRAFT', 'UNREAD', 'STARRED', 'IMPORTANT',
      'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
    const cleaned = labels
      .filter(l => !hidden.has(l.id))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ success: true, labels: cleaned });
  } catch (err) {
    if (String(err.message || '').includes('invalid_grant'))
      return res.status(401).json({ success: false, message: 'Gmail connection expired. Reconnect in Settings.' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gmail/label-mappings — list mappings for current user
app.get('/api/gmail/label-mappings', requireAuth, async (req, res) => {
  try {
    const mine = await getLabelMappings(req.user.id);
    res.json({ success: true, mappings: mine });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/gmail/label-mappings — { labelId, labelName, showId }
app.post('/api/gmail/label-mappings', requireAuth, async (req, res) => {
  try {
    const { labelId, labelName, showId } = req.body || {};
    if (!labelId || !labelName || !showId)
      return res.status(400).json({ success: false, message: 'labelId, labelName, and showId are required.' });
    const shows = await sheets.getRows(config.googleSheets.sheets.shows);
    const show = shows.find(s => s.id === showId);
    if (!show) return res.status(404).json({ success: false, message: 'Show not found.' });
    const showName = `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim().replace(/^—\s*/, '');
    // Prevent duplicate (userId, labelId) mappings
    const existing = await getLabelMappings(req.user.id);
    if (existing.some(m => m.labelId === labelId && m.showId === showId))
      return res.json({ success: true, duplicate: true });
    const row = {
      id:        `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      userId:    req.user.id,
      labelId,
      labelName,
      showId,
      showName,
      createdAt: new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.gmailLabelMappings, row);
    res.json({ success: true, mapping: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/gmail/label-mappings/:id
app.delete('/api/gmail/label-mappings/:id', requireAuth, async (req, res) => {
  try {
    const all = await getLabelMappings();
    const row = all.find(m => m.id === req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Mapping not found.' });
    if (row.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Not your mapping.' });
    await sheets.deleteRowById(config.googleSheets.sheets.gmailLabelMappings, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Per-user opt-in labels to sync (no auto-link — just bring them in) ──────
// GET /api/gmail/synced-labels
app.get('/api/gmail/synced-labels', requireAuth, async (req, res) => {
  try { res.json({ success: true, labels: await getSyncedLabels(req.user.id) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/gmail/synced-labels  { labelId, labelName }
app.post('/api/gmail/synced-labels', requireAuth, async (req, res) => {
  try {
    const { labelId, labelName } = req.body || {};
    if (!labelId || !labelName)
      return res.status(400).json({ success: false, message: 'labelId and labelName are required.' });
    const existing = await getSyncedLabels(req.user.id);
    if (existing.some(r => r.labelId === labelId))
      return res.json({ success: true, duplicate: true });
    const row = {
      id:        `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      userId:    req.user.id,
      labelId,
      labelName,
      createdAt: new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.gmailSyncedLabels, row);
    res.json({ success: true, label: row });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/gmail/synced-labels/:id
app.delete('/api/gmail/synced-labels/:id', requireAuth, async (req, res) => {
  try {
    const all = await getSyncedLabels();
    const row = all.find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found.' });
    if (row.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Not yours.' });
    await sheets.deleteRowById(config.googleSheets.sheets.gmailSyncedLabels, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Shared helper: sync one user's connected Gmail mailbox into our emails sheet.
// Returns { ok, reason?, newEmails, autoLinked, affectedShowIds, affectedAdvanceIds }.
async function syncUserMailbox(userId) {
  const u = await getUserById(userId);
  if (!u || !u.gmailRefreshToken)
    return { ok: false, reason: 'not_connected', newEmails: 0, autoLinked: 0, affectedShowIds: [], affectedAdvanceIds: [] };

  let client;
  try { client = gmail.getGmailClientForToken(u.gmailRefreshToken); }
  catch (e) { return { ok: false, reason: 'bad_token', newEmails: 0, autoLinked: 0, affectedShowIds: [], affectedAdvanceIds: [] }; }

  const userMappings = await getLabelMappings(userId);
  const labelClause  = await buildUserLabelClause(userId, client);
  const relevance    = await buildInboxRelevanceFilter();
  let messageRefs = [];
  try {
    messageRefs = await gmail.searchEmails(`(in:inbox OR in:sent${labelClause}) ${relevance}`, 150, client);
  } catch (e) {
    if (String(e.message || '').includes('invalid_grant'))
      return { ok: false, reason: 'token_expired', newEmails: 0, autoLinked: 0, affectedShowIds: [], affectedAdvanceIds: [] };
    throw e;
  }

  const [existing, shows, advances, artists] = await Promise.all([
    getStoredEmails(),
    sheets.getRows(config.googleSheets.sheets.shows),
    sheets.getRows(config.googleSheets.sheets.advancing),
    sheets.getRows(config.googleSheets.sheets.artists).catch(() => []),
  ]);
  const storedKeys = new Set(existing.map(e => `${e.sourceUserId || ''}|${e.gmailMessageId}`));

  const toAppend = [];
  const affectedShowIds = new Set();
  let classified = 0;
  for (const ref of messageRefs) {
    if (storedKeys.has(`${userId}|${ref.id}`)) continue;
    try {
      const msg = await gmail.getMessage(ref.id, client);
      const parsed = gmail.parseMessage(msg);
      const meEmail = (u.gmailEmail || '').toLowerCase();
      const direction = meEmail && parsed.from.toLowerCase().includes(meEmail) ? 'outbound' : 'inbound';
      let match = classifyEmailToShow(parsed, shows, advances, artists);
      if (!match) {
        const mapped = matchLabelMapping(parsed.labelIds, userMappings);
        if (mapped) match = { showId: mapped.showId, showName: mapped.showName };
      }
      if (match) classified++;
      if (match?.showId) affectedShowIds.add(match.showId);
      toAppend.push({
        id:             `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        showId:         match?.showId     || '',
        showName:       match?.showName   || '',
        artistId:       match?.artistId   || '',
        artistName:     match?.artistName || '',
        gmailThreadId:  parsed.gmailThreadId,
        gmailMessageId: parsed.gmailMessageId,
        from:           parsed.from,
        to:             parsed.to,
        cc:             parsed.cc,
        subject:        parsed.subject,
        snippet:        (parsed.snippet || '').slice(0, 300),
        date:           parsed.date,
        direction,
        attachmentMeta: JSON.stringify(parsed.attachments),
        syncedAt:       new Date().toISOString(),
        sourceUserId:   userId,
        sourceEmail:    u.gmailEmail || '',
      });
      storedKeys.add(`${userId}|${ref.id}`);
    } catch (e) {
      console.error('[syncUserMailbox] message error', ref.id, e.message);
    }
  }
  if (toAppend.length) {
    await sheets.appendRows(config.googleSheets.sheets.emails, toAppend);
  }
  const affectedAdvanceIds = advances
    .filter(a => affectedShowIds.has(a.showId))
    .map(a => a.id);
  return {
    ok: true,
    newEmails: toAppend.length,
    autoLinked: classified,
    affectedShowIds: [...affectedShowIds],
    affectedAdvanceIds,
  };
}

// POST /api/emails/sync-mine — sync current user's connected mailbox
app.post('/api/emails/sync-mine', requireAuth, async (req, res) => {
  try {
    const result = await syncUserMailbox(req.user.id);
    if (!result.ok) {
      const code = result.reason === 'not_connected' ? 400 : 401;
      return res.status(code).json({ success: false, message: result.reason });
    }
    res.json({ success: true, newEmails: result.newEmails, autoLinked: result.autoLinked });
  } catch (err) {
    console.error('sync-mine error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/sync/login-kickoff — fired by the client right after login (and
// on app mount, gated client-side). Syncs the current user's Gmail so new
// mail is available to browse. For admins / production managers it also runs
// the venue-calendar scrubber (throttled server-side to 1x/hour).
// Designed to be called fire-and-forget.
app.post('/api/sync/login-kickoff', requireAuth, async (req, res) => {
  const started = Date.now();
  try {
    const isProdManager = req.user.role === 'admin' || req.user.role === 'production_manager';
    const [sync, scrub] = await Promise.all([
      syncUserMailbox(req.user.id),
      isProdManager
        ? runScrubberIfDue().catch(err => ({ ran: false, reason: 'error', error: err.message }))
        : Promise.resolve(null),
    ]);
    res.json({
      success: true,
      gmail:   sync.ok ? 'synced' : sync.reason,
      newEmails:  sync.newEmails  || 0,
      autoLinked: sync.autoLinked || 0,
      scrubber:   scrub,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error('login-kickoff error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Event scraper — fetch upcoming shows from the-windjammer.com ──────────────
// Shared helper: fetch + parse + dedupe + duplicate-flag against Shows sheet.
// Returns [{ title, date, time, stage, url, isDuplicate }].
async function scrapeWindjammerEvents() {
  const VENUE_URL = 'https://the-windjammer.com/events/';
  const html = await fetch(VENUE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  }).then(r => r.text());

  // Site uses a custom WordPress theme — events are <div class="event-content-row"> blocks.
  //   Date:      <div class="event-content-date"><p><b> 23 </b> April, 2026</p></div>
  //   URL/Title: <h2><a href="https://the-windjammer.com/event/SLUG">Title text</a></h2>
  //   Time:      <ul><li>Thursday</li><li>9:30 pm</li></ul>
  const MO = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
               july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
  const decodeHtml = s => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…').replace(/&quot;/g, '"');

  const events = [];
  const seen   = new Set();
  const rows = html.split('<div class="event-content-row">');
  rows.shift();

  for (const row of rows) {
    const urlM = row.match(/href="(https?:\/\/the-windjammer\.com\/event\/[^"]+)"/i);
    if (!urlM) continue;
    const url = urlM[1].replace(/\/$/, '');
    if (seen.has(url)) continue;
    seen.add(url);

    const h2M = row.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
    const title = decodeHtml(h2M ? h2M[1].trim() : url.split('/event/')[1]?.replace(/-/g,' ') || '');
    if (!title) continue;

    let date = '';
    const dateDivM = row.match(/<div[^>]*event-content-date[^>]*>([\s\S]*?)<\/div>/i);
    if (dateDivM) {
      const dateText = dateDivM[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const dmy = dateText.match(/(\d{1,2})\s+([a-z]+),?\s+(\d{4})/i);
      if (dmy) {
        const mo = MO[dmy[2].toLowerCase()] || '01';
        date = `${dmy[3]}-${mo}-${dmy[1].padStart(2, '0')}`;
      }
    }

    const ulM = row.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
    let showTime = '';
    if (ulM) {
      const liM = [...ulM[1].matchAll(/<li[^>]*>([^<]+)<\/li>/gi)];
      showTime = liM[1]?.[1]?.trim() || '';
    }

    const stage = detectStage(title);
    events.push({ title, date, time: showTime, stage, url });
  }

  // Sort by date (earliest first). Multi-night runs stay as separate events —
  // each URL is its own night — but we group them by a runKey derived from the
  // cleaned artist title so the app can render "night 1 / 2 / 3" badges later.
  events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);

  // Guard against the same (date, cleanTitle) appearing twice — the site
  // occasionally lists a duplicate row for a single night.
  const seenNight = new Set();
  const cleaned = [];
  for (const ev of events) {
    const clean = cleanArtistTitle(ev.title);
    const key = `${ev.date}|${clean.toLowerCase()}`;
    if (seenNight.has(key)) continue;
    seenNight.add(key);
    const { headliner, support, artistAliases } = splitHeadlinerAndSupport(clean);
    cleaned.push({
      ...ev,
      title: clean,
      artist: headliner,
      support,
      artistAliases,
      runKey: clean.toLowerCase(),
    });
  }

  // Attach run metadata (nightIndex is 1-based within its run, ordered by date).
  const runCounts = new Map();
  for (const ev of cleaned) runCounts.set(ev.runKey, (runCounts.get(ev.runKey) || 0) + 1);
  const runSeen = new Map();
  const withRuns = cleaned.map(ev => {
    const total = runCounts.get(ev.runKey) || 1;
    const idx = (runSeen.get(ev.runKey) || 0) + 1;
    runSeen.set(ev.runKey, idx);
    return { ...ev, multiNight: total > 1, runNights: total, nightIndex: idx };
  });

  const existingShows   = await sheets.getRows(config.googleSheets.sheets.shows);
  const existingArtists = await sheets.getRows(config.googleSheets.sheets.artists).catch(() => []);
  const isDupOfExisting = buildDuplicateChecker(existingShows, existingArtists);
  return withRuns.map(ev => ({ ...ev, isDuplicate: isDupOfExisting(ev) }));
}

// Normalize an artist / event name for cross-matching. Lowercases, expands "&"
// to " and " so "Mark Bryan & Friends" matches "Mark Bryan and Friends",
// strips punctuation, and collapses whitespace.
function normalizeArtistKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a fast duplicate detector against the current Shows sheet. Considers a
// scraped event a duplicate of an existing show when either:
//   (a) an existing show's notes already contain the scraped event URL, or
//   (b) an existing show shares the same date AND its artist/eventName matches
//       the scraped headliner — checked via the Artist Registry so any alias
//       of the headliner also counts. Fuzzy fallback requires ≥6 shared chars
//       to keep short prefixes from causing false positives.
function buildDuplicateChecker(existingShows, existingArtists) {
  // Registry-driven alias map: any normalized name (real or alias) maps to
  // the full list of alternates for that artist row.
  const alternates = new Map();
  for (const a of existingArtists || []) {
    const names = [a.name, ...String(a.aliases || '').split(',')]
      .map(normalizeArtistKey)
      .filter(Boolean);
    if (names.length === 0) continue;
    for (const n of names) alternates.set(n, names);
  }

  const showsByUrl  = new Map();
  const showsByDate = new Map();
  const URL_RE = /https?:\/\/the-windjammer\.com\/event\/[^\s"'>]+/i;
  for (const s of existingShows || []) {
    const noteUrlM = String(s.notes || '').match(URL_RE);
    if (noteUrlM) {
      const clean = noteUrlM[0].replace(/\/$/, '');
      if (!showsByUrl.has(clean)) showsByUrl.set(clean, []);
      showsByUrl.get(clean).push(s);
    }
    const d = s.date || '';
    if (!d) continue;
    if (!showsByDate.has(d)) showsByDate.set(d, []);
    showsByDate.get(d).push({
      key: normalizeArtistKey(s.artist || s.eventName || ''),
    });
  }

  return function isDupOf(ev) {
    if (ev.url && showsByUrl.has(ev.url.replace(/\/$/, ''))) return true;
    if (!ev.date) return false;
    const dayShows = showsByDate.get(ev.date);
    if (!dayShows || dayShows.length === 0) return false;

    const evKeys = new Set();
    for (const raw of [ev.artist, ev.title]) {
      const k = normalizeArtistKey(raw);
      if (!k) continue;
      evKeys.add(k);
      for (const alt of alternates.get(k) || []) evKeys.add(alt);
    }

    for (const key of evKeys) {
      if (!key) continue;
      for (const { key: existingKey } of dayShows) {
        if (!existingKey) continue;
        if (existingKey === key) return true;
        if (existingKey.length >= 6 && key.includes(existingKey)) return true;
        if (key.length      >= 6 && existingKey.includes(key))    return true;
      }
    }
    return false;
  };
}

// Stage classifier. Reads the *title* (not the URL — some URLs are misleading,
// e.g. an act originally booked for the Beach later relocated to Inside keeps
// its "beach" URL slug). Order matters: "Inside Stage" wins if both terms
// appear.
function detectStage(title) {
  const t = String(title || '').toLowerCase();
  if (/inside stage/.test(t)) return 'inside';
  if (/beach stage|on the beach|n[uü]trl/.test(t)) return 'beach';
  return 'inside';
}

// Turn a venue event title into a clean artist name suitable for the Artist
// Registry: strips " – on the NÜTRL Beach Stage", " – Saturday", " – Night 2",
// "(Friday)", etc. Leaves the core artist billing intact ("Artist w/ Support").
// Order matters — the outermost trailing tokens (day / night qualifiers) must
// be removed first so the stage-suffix strip can match at the end anchor.
function cleanArtistTitle(t) {
  return String(t || '')
    // Trailing admission-policy suffix ("– 21Up or with their parent", etc.).
    // Must be stripped before the support-split regex or "with their parent"
    // gets misread as a support act.
    .replace(/\s*[-–]\s*21\s*(?:up|&\s*up|and\s*up)\b.*$/i, '')
    // Trailing "Night N" run qualifier
    .replace(/\s*[-–]\s*night\s*\d+\s*$/i, '')
    // Trailing day-of-week qualifier (with optional part-of-day)
    .replace(/\s*[-–]\s*(mon|tues|wednes|thurs|fri|satur|sun)day(\s+(morning|afternoon|evening|night))?\s*$/i, '')
    .replace(/\s*\((mon|tues|wednes|thurs|fri|satur|sun)day\)\s*$/i, '')
    // Trailing stage suffix
    .replace(/\s*[-–]?\s*on the\s+(n[uü]trl\s+)?beach(\s+stage)?\s*$/i, '')
    .replace(/\s*[-–]?\s*on the\s+inside\s+stage\s*$/i, '')
    // Any dangling separator left behind after other strips
    .replace(/\s*[-–]\s*$/, '')
    .trim();
}

// Split a cleaned title into headliner + support + aliases.
//
//  " with " / " w/ "                → support act (separate opening/co-billed act)
//  " featuring " / " feat. " / " ft. " → guest performing as part of the SAME act
//                                     → attached to the headliner as an alias
//
// Deliberately does NOT split on "&" or "and" — those appear inside single band
// names like "Mark Bryan & Friends" and "Ax and The Hatchetmen".
function splitHeadlinerAndSupport(title) {
  let headliner = String(title || '').trim();
  let support   = '';
  let aliases   = '';
  if (!headliner) return { headliner: '', support: '', artistAliases: '' };

  const wm = headliner.match(/^(.+?)\s+(?:with|w\/)\s+(.+)$/i);
  if (wm) { headliner = wm[1].trim(); support = wm[2].trim(); }

  const fm = headliner.match(/^(.+?)\s+(?:featuring|feat\.?|ft\.?)\s+(.+)$/i);
  if (fm) { headliner = fm[1].trim(); aliases = fm[2].trim(); }

  return { headliner, support, artistAliases: aliases };
}

// Shared helper: append the given events to the Shows sheet and fire
// kickoffAdvanceForShow (which also runs ensureArtistsFromShow -> new Artist
// Registry entries for any bands we don't already know about).
async function importScrapedShows(events) {
  const createdShows = [];
  const aliasJobs    = []; // { headliner, aliasesText }
  for (const ev of events) {
    const show = {
      id:          `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      date:        ev.date,
      artist:      ev.artist || ev.title,
      eventName:   '',
      stage:       ev.stage,
      status:      'pending',
      showTime:    ev.time || '',
      doorsTime:   '',
      capacity:    '',
      ticketPrice: '',
      guarantee:   '',
      promoter:    '',
      tourManager: '',
      support:     ev.support || '',
      notes:       `Scraped from the-windjammer.com/events — ${ev.url || ''}`,
      createdAt:   new Date().toISOString(),
    };
    await sheets.appendRow(config.googleSheets.sheets.shows, show);
    createdShows.push(show);
    if (ev.artistAliases) aliasJobs.push({ headliner: show.artist, aliasesText: ev.artistAliases });
  }

  // Fire-and-forget kickoff for every imported show (advance row + Drive folder + artist registry).
  // After the kickoff has ensured the headliner artist exists, merge any parsed
  // "featuring" names as aliases on that registry row.
  Promise.resolve()
    .then(async () => {
      for (const s of createdShows) {
        try { await kickoffAdvanceForShow(s); }
        catch (err) { console.error('[scrape-import kickoff]', err.message); }
      }
      for (const job of aliasJobs) {
        try { await mergeHeadlinerAliases(job.headliner, job.aliasesText); }
        catch (err) { console.error('[scrape-import aliases]', err.message); }
      }
    })
    .catch(err => console.error('[scrape-import kickoff]', err.message));

  return { created: createdShows.length, createdShows };
}

// Merge "featuring" names onto the headliner's Artist Registry entry as
// aliases. Idempotent — never duplicates an existing alias. Silent no-op if
// the headliner row can't be located (rare — ensureArtistsFromShow should
// have created it in the same tick).
async function mergeHeadlinerAliases(headlinerName, aliasesText) {
  const name = String(headlinerName || '').trim();
  const additions = String(aliasesText || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!name || additions.length === 0) return;

  const all = await sheets.getRows(config.googleSheets.sheets.artists);
  const nameLc = name.toLowerCase();
  const artist = all.find(a => (a.name || '').trim().toLowerCase() === nameLc);
  if (!artist) return;

  const current = String(artist.aliases || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const currentLc = new Set(current.map(s => s.toLowerCase()));
  const toAdd = additions.filter(a => !currentLc.has(a.toLowerCase()));
  if (toAdd.length === 0) return;

  const merged = [...current, ...toAdd].join(', ');
  await sheets.updateRowById(config.googleSheets.sheets.artists, artist.id, { aliases: merged });
  console.log(`[scrape] merged aliases into "${name}": ${toAdd.join(', ')}`);
}

// Automatic scrubber: runs at most once per SCRUB_THROTTLE_MS across all logins.
// Called from /api/sync/login-kickoff when the user is admin or production_manager.
const SCRUB_THROTTLE_MS = 60 * 60 * 1000;
let lastScrubAt = 0;
let scrubInFlight = null;
async function runScrubberIfDue() {
  const now = Date.now();
  if (now - lastScrubAt < SCRUB_THROTTLE_MS) {
    return { ran: false, reason: 'throttled', nextEligibleAt: new Date(lastScrubAt + SCRUB_THROTTLE_MS).toISOString() };
  }
  if (scrubInFlight) return scrubInFlight;

  scrubInFlight = (async () => {
    lastScrubAt = now;
    const all = await scrapeWindjammerEvents();
    const fresh = all.filter(e => !e.isDuplicate && e.date && e.title);
    let created = 0;
    if (fresh.length) {
      const result = await importScrapedShows(fresh);
      created = result.created;
      console.log(`[scrubber] imported ${created} new show(s): ${fresh.map(e => `${e.date} ${e.title}`).join(' | ')}`);
    } else {
      console.log(`[scrubber] no new shows (scanned ${all.length} events)`);
    }
    return { ran: true, scanned: all.length, imported: created, ranAt: new Date(now).toISOString() };
  })().catch(err => {
    console.error('[scrubber] failed:', err.message);
    lastScrubAt = 0; // allow retry on next login after a failure
    return { ran: false, reason: 'error', error: err.message };
  }).finally(() => { scrubInFlight = null; });

  return scrubInFlight;
}

app.get('/api/scrape/shows', requireAuth, async (req, res) => {
  try {
    const data = await scrapeWindjammerEvents();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ success: false, message: 'Scrape failed: ' + err.message });
  }
});

// ── Import scraped events as shows ───────────────────────────────────────────
app.post('/api/scrape/import', requireAuth, requireRole('admin', 'production_manager'), async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0)
      return res.status(400).json({ success: false, message: 'No events provided' });
    const { created } = await importScrapedShows(events);
    res.json({ success: true, created });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── SPA catch-all (production) ────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
  });
}

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Windjammer server running on port ${PORT}`);
  // Fire-and-forget: log Google credential health so failures show up in
  // Railway logs immediately at boot rather than at first user action.
  try {
    const { checkGoogleAuth } = require('./scripts/check-google-auth');
    checkGoogleAuth().catch(err => console.error('[auth-check] unexpected:', err.message));
  } catch (err) {
    console.error('[auth-check] failed to load:', err.message);
  }
  // LLM key sanity check — never prints the key value.
  try {
    require('./llm/configCheck').validateAtStartup();
  } catch (err) {
    console.error('[llm] startup check failed:', err.message);
  }
});
