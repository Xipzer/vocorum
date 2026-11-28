// App shell cache only. API, events and attachments always go to the network.
const CACHE = 'vocorum-shell-v7'
// What another app shared (Web Share Target), kept on this device until the app sends or drops it.
const SHARE = 'vocorum-share'
const SHELL = ['/', '/theme.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/fonts/inter-latin-wght.woff2']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== SHARE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  )
})

// The share sheet POSTs here (see share_target in the manifest). The hub never sees it:
// the files stay in Cache Storage and the app opens on its "Share to…" screen.
async function stashShare(request) {
  const form = await request.formData().catch(() => null)
  await caches.delete(SHARE)
  if (form) {
    const cache = await caches.open(SHARE)
    const files = form.getAll('files').filter((f) => typeof f !== 'string' && (f.size > 0 || f.name))
    await Promise.all(
      files.map((file, i) =>
        cache.put(`/share/file/${i}`, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || `file-${i + 1}`) } })),
      ),
    )
    const field = (name) => String(form.get(name) ?? '')
    await cache.put('/share/meta', new Response(JSON.stringify({ title: field('title'), text: field('text'), url: field('url'), files: files.length }), { headers: { 'content-type': 'application/json' } }))
  }
  return Response.redirect(new URL('/#/share', self.location.origin).href, 303)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share') {
    event.respondWith(stashShare(event.request))
    return
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/client/') || url.pathname.startsWith('/attachments/') || url.pathname.startsWith('/api/')) return
  if (event.request.mode === 'navigate') {
    // Network first so a new build shows up; the cached shell works offline.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          if (response.ok) caches.open(CACHE).then((cache) => cache.put('/', copy))
          return response
        })
        .catch(() => caches.match('/')),
    )
    return
  }
  // The theme script runs before the first paint: fresh when online, cached when not.
  if (url.pathname === '/theme.js') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          if (response.ok) caches.open(CACHE).then((cache) => cache.put('/theme.js', copy))
          return response
        })
        .catch(() => caches.match('/theme.js')),
    )
    return
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/emoji/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((response) => {
            const copy = response.clone()
            if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, copy))
            return response
          }),
      ),
    )
  }
})

// Web Push from the hub (encrypted end to end; see src/notifications.ts for the payload).
// iOS revokes a subscription whose pushes do not show a notification, so every push shows one.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Vocorum', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
    }),
  )
})

// Focus an open window and tell it where to go, or open one at the target URL.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = new URL(data.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (!open) return self.clients.openWindow(url)
      open.postMessage({ type: 'notification-click', channel_id: data.channel_id, message_id: data.message_id, url: data.url })
      return open.focus()
    }),
  )
})
