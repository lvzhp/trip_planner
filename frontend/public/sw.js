/* Trace Planner PWA service worker —— 只缓存应用外壳，不碰 /api 与第三方地图瓦片。 */
const CACHE = 'trace-planner-shell-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api')) return

  // 页面导航：网络优先，离线回退到缓存的外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()
          caches.open(CACHE).then(cache => cache.put('/', copy)).catch(() => undefined)
          return response
        })
        .catch(() => caches.match('/').then(hit => hit || caches.match('/index.html'))),
    )
    return
  }

  // 静态资源：命中缓存立即返回，同时后台更新
  event.respondWith(
    caches.match(request).then(hit => {
      const network = fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => undefined)
          }
          return response
        })
        .catch(() => hit)
      return hit || network
    }),
  )
})
