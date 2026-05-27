// push.js — Web Push (VAPID) helper.
//
// Subscriptions are stored in the "push_subscriptions" sheet, one row per
// (userId, endpoint) pair so a single user can have many devices.
//
// Notification preferences live in the Users sheet under `notificationPrefs`
// as JSON: { showUpdates, docUploads, shiftAssigned, emailReceived,
// dayOfShow }. Missing = treated as enabled.

require('dotenv').config();
const webpush = require('web-push');
const sheets = require('./sheets');

const SUBS_SHEET = 'push_subscriptions';
let vapidConfigured = false;

function configure() {
  if (vapidConfigured) return true;
  const clean = v => String(v || '').trim().replace(/^['"]|['"]$/g, '');
  const pub = clean(process.env.VAPID_PUBLIC_KEY);
  const priv = clean(process.env.VAPID_PRIVATE_KEY);
  const sub = clean(process.env.VAPID_SUBJECT) || 'mailto:admin@example.com';
  if (!pub || !priv) {
    console.warn('[push] VAPID keys not set — push notifications disabled');
    return false;
  }
  try {
    webpush.setVapidDetails(sub, pub, priv);
  } catch (e) {
    console.warn('[push] Invalid VAPID keys:', e.message);
    return false;
  }
  vapidConfigured = true;
  return true;
}

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function publicKey() {
  // Strip surrounding whitespace/quotes — Railway/dotenv can leave these in.
  const raw = process.env.VAPID_PUBLIC_KEY || '';
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

async function subscribe(userId, subscription, userAgent = '') {
  if (!userId || !subscription || !subscription.endpoint) {
    throw new Error('userId and subscription.endpoint required');
  }
  const all = await sheets.getRows(SUBS_SHEET).catch(() => []);
  // Replace any existing row with the same endpoint (user re-subscribing)
  const existing = all.find(r => r.endpoint === subscription.endpoint);
  if (existing) {
    await sheets.updateRowById(SUBS_SHEET, existing.id, {
      userId: String(userId),
      endpoint: subscription.endpoint,
      keys: JSON.stringify(subscription.keys || {}),
      userAgent,
      updatedAt: new Date().toISOString(),
    });
    return { updated: true };
  }
  await sheets.appendRow(SUBS_SHEET, {
    id: String(Date.now()) + Math.floor(Math.random() * 1000),
    userId: String(userId),
    endpoint: subscription.endpoint,
    keys: JSON.stringify(subscription.keys || {}),
    userAgent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { created: true };
}

async function unsubscribe(endpoint) {
  const all = await sheets.getRows(SUBS_SHEET).catch(() => []);
  const row = all.find(r => r.endpoint === endpoint);
  if (row) await sheets.deleteRowById(SUBS_SHEET, row.id);
  return { removed: !!row };
}

async function getSubscriptionsForUser(userId) {
  if (!userId) return [];
  const all = await sheets.getRows(SUBS_SHEET).catch(() => []);
  return all
    .filter(r => String(r.userId) === String(userId))
    .map(r => ({
      id: r.id,
      endpoint: r.endpoint,
      keys: safeJson(r.keys) || {},
    }));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function prefAllows(user, eventKey) {
  if (!user) return false;
  const raw = user.notificationPrefs || user.notification_prefs;
  if (!raw) return true; // default ON
  const prefs = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!prefs) return true;
  return prefs[eventKey] !== false && prefs[eventKey] !== 'false';
}

// Send a push to a single user (all their devices).
// payload: { title, body, url, tag, icon }
// eventKey: optional pref key; if set, respects user.notificationPrefs[eventKey]
async function sendToUser(userId, payload, eventKey) {
  if (!configure()) return { sent: 0, skipped: 'no-vapid' };
  if (!userId) return { sent: 0, skipped: 'no-user' };

  // Check user prefs
  if (eventKey) {
    try {
      const users = await sheets.getRows('users').catch(() => []);
      const user = users.find(u => String(u.id) === String(userId));
      if (user && !prefAllows(user, eventKey)) {
        return { sent: 0, skipped: 'pref-off' };
      }
    } catch {}
  }

  const subs = await getSubscriptionsForUser(userId);
  if (!subs.length) return { sent: 0, skipped: 'no-subs' };

  const body = JSON.stringify({
    title: payload.title || 'Windjammer',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag,
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body);
      sent++;
    } catch (err) {
      // 404/410 = subscription gone; clean it up
      const code = err.statusCode || err.status;
      if (code === 404 || code === 410) {
        try { await sheets.deleteRowById(SUBS_SHEET, s.id); } catch {}
      } else {
        console.warn('[push] send failed:', code, err.body || err.message);
      }
    }
  }));
  return { sent };
}

// Send a push to many users in parallel.
async function sendToUsers(userIds, payload, eventKey) {
  const unique = Array.from(new Set((userIds || []).filter(Boolean).map(String)));
  const results = await Promise.all(unique.map(uid => sendToUser(uid, payload, eventKey)));
  return { total: results.reduce((a, r) => a + (r.sent || 0), 0), perUser: results.length };
}

// Send a push to every user with a given role (or any role in an array).
async function sendToRole(roles, payload, eventKey) {
  if (!configure()) return { sent: 0, skipped: 'no-vapid' };
  const list = Array.isArray(roles) ? roles : [roles];
  const users = await sheets.getRows('users').catch(() => []);
  const ids = users
    .filter(u => list.includes(u.role) && String(u.active) !== 'false')
    .map(u => u.id);
  return sendToUsers(ids, payload, eventKey);
}

module.exports = {
  configure,
  isConfigured,
  publicKey,
  subscribe,
  unsubscribe,
  sendToUser,
  sendToUsers,
  sendToRole,
};
