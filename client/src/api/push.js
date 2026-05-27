// Client-side helpers for Web Push (VAPID) subscription.
import api from './index'

function urlBase64ToUint8Array(base64String) {
  // Strip whitespace/quotes and keep only valid base64url chars.
  const clean = String(base64String || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^A-Za-z0-9_\-]/g, '')
  if (!clean) throw new Error('Empty VAPID public key from server')
  const padding = '='.repeat((4 - clean.length % 4) % 4)
  const base64 = (clean + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function isPushSupported() {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
}

export function notificationPermission() {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}

// Returns the current PushSubscription if one exists, or null.
export async function getCurrentSubscription() {
  if (!isPushSupported()) return null
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

// Asks for permission, subscribes via the service worker, and POSTs the
// subscription to the server. Resolves to the new subscription, or throws.
export async function enablePush() {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notification permission was denied')

  const { data } = await api.get('/push/public-key')
  if (!data?.publicKey) throw new Error('Server has no VAPID public key configured')

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    })
  }

  await api.post('/push/subscribe', {
    subscription: sub.toJSON(),
    userAgent: navigator.userAgent,
  })
  return sub
}

// Unsubscribes locally and notifies the server.
export async function disablePush() {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }) } catch {}
    try { await sub.unsubscribe() } catch {}
  }
}

export async function sendTestPush() {
  return api.post('/push/test')
}
