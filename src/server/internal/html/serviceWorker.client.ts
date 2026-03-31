export async function submitCredential(credential: string): Promise<void> {
  const url = new URL(location.href)
  url.searchParams.set('__mppx_worker', '')

  const registration = await navigator.serviceWorker.register(url.pathname + url.search)

  const serviceWorker = await new Promise<ServiceWorker>((resolve) => {
    const mppxWorker = registration.installing ?? registration.waiting ?? registration.active
    if (mppxWorker?.state === 'activated') return resolve(mppxWorker)
    const target = mppxWorker ?? registration
    target.addEventListener('statechange', function handler() {
      const active = registration.active
      if (active?.state === 'activated') {
        target.removeEventListener('statechange', handler)
        resolve(active)
      }
    })
  })

  serviceWorker.postMessage({ credential })
  location.reload()
}
