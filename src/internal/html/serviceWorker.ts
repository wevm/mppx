const serviceWorker = self as unknown as ServiceWorkerGlobalScope

let credential: string | undefined
let credentialHeader = 'Authorization'

serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(serviceWorker.clients.claim())
})

serviceWorker.addEventListener('message', (event) => {
  if (!event.source) return
  const value = event.data?.credential
  if (typeof value !== 'string' || !value.startsWith('Payment ')) return
  credential = value
  if (typeof event.data?.header === 'string') credentialHeader = event.data.header
  event.ports[0]?.postMessage('ack')
})

serviceWorker.addEventListener('fetch', (event) => {
  if (!credential || event.request.mode !== 'navigate') return
  if (new URL(event.request.url).origin !== serviceWorker.location.origin) return

  const headers = new Headers(event.request.headers)
  headers.set(credentialHeader, credential)
  credential = undefined

  event.respondWith(fetch(event.request, { headers }))
  serviceWorker.registration.unregister()
})
