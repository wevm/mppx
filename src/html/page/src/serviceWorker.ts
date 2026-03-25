/// <reference lib="webworker" />

let credential: string | null = null

const serviceWorker = self as unknown as ServiceWorkerGlobalScope
serviceWorker.addEventListener('install', () => {
  serviceWorker.skipWaiting()
})
serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(serviceWorker.clients.claim())
})
serviceWorker.addEventListener('message', (event) => {
  credential = event.data
})
serviceWorker.addEventListener('fetch', (event) => {
  if (!credential) return
  const headers = new Headers(event.request.headers)
  headers.set('Authorization', credential)
  credential = null
  event.respondWith(fetch(new Request(event.request, { headers })))
})
