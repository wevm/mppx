export async function submitCredential(credential: string): Promise<void> {
  const url = new URL(location.href)
  url.searchParams.set('__mppx_worker', '')

  const registration = await navigator.serviceWorker.register(url.pathname + url.search)

  const sw = await new Promise<ServiceWorker>((resolve) => {
    const worker = registration.installing ?? registration.waiting ?? registration.active
    if (worker?.state === 'activated') return resolve(worker)
    const target = worker ?? registration
    target.addEventListener('statechange', function handler() {
      const active = registration.active
      if (active?.state === 'activated') {
        target.removeEventListener('statechange', handler)
        resolve(active)
      }
    })
  })

  sw.postMessage({ credential })
  location.reload()
}
