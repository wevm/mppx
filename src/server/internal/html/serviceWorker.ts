const sw = self as unknown as ServiceWorkerGlobalScope

let credential: string | undefined

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim())
})

sw.addEventListener('message', (event) => {
  credential = event.data?.credential
})

sw.addEventListener('fetch', (event) => {
  if (!credential || event.request.mode !== 'navigate') return

  const headers = new Headers(event.request.headers)
  headers.set('Authorization', credential)
  credential = undefined

  event.respondWith(fetch(event.request, { headers }))
  sw.registration.unregister()
})
