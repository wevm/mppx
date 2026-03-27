/// <reference lib="webworker" />

const serviceWorker = self as unknown as ServiceWorkerGlobalScope

// Activate immediately on install, skipping the waiting phase.
serviceWorker.addEventListener('install', () => {
  serviceWorker.skipWaiting()
})

// Claim all clients so the service worker intercepts fetches right away.
serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(serviceWorker.clients.claim())
})

// Holds the pending payment credential to attach to the next matching request.
let pending: { credential: string; url: string } | null = null

// Receive a credential + target URL from the payment page via `postMessage`.
serviceWorker.addEventListener('message', (event) => {
  pending = event.data
  event.ports[0]?.postMessage({ ok: true })
})

// Intercept the matching fetch and inject the `Authorization` header with the
// payment credential, then clear the pending state so it's used only once.
serviceWorker.addEventListener('fetch', (event) => {
  if (!pending) return
  if (event.request.url !== pending.url) return
  const headers = new Headers(event.request.headers)
  headers.set('Authorization', pending.credential)
  pending = null
  event.respondWith(fetch(new Request(event.request, { headers })))
})
