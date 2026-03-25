import * as Credential from '../../../Credential.js'
import { dataElementId, serviceWorkerPathname } from '../../../server/Html.js'

const dataElement = document.getElementById(dataElementId)
if (!dataElement) throw new Error(`Missing #${dataElementId} element`)

const data = JSON.parse(dataElement.textContent!) as Pick<typeof mppx, 'challenge' | 'config'>
if (!data.challenge) throw new Error('Missing challenge')

window.mppx = Object.freeze({
  challenge: data.challenge,
  config: data.config,
  dispatch(payload: unknown, source?: string): void {
    dispatchEvent(
      new CustomEvent('mppx:complete', {
        detail: mppx.serializeCredential(payload, source),
      }),
    )
  },
  serializeCredential(payload: unknown, source?: string): string {
    return Credential.serialize({
      challenge: mppx.challenge,
      payload,
      ...(source && { source }),
    })
  },
})

const challengeElement = document.getElementById('mppx-challenge')
if (challengeElement) challengeElement.textContent = JSON.stringify(data.challenge, null, 2)

if (data.challenge.description) {
  const element = document.createElement('p')
  element.textContent = data.challenge.description
  document.querySelector('header')!.appendChild(element)
}

function activateServiceWorker(reg: ServiceWorkerRegistration): Promise<void> {
  const serviceWorker = reg.installing || reg.waiting || reg.active
  return new Promise((resolve) => {
    if (serviceWorker!.state === 'activated') return resolve()
    serviceWorker!.addEventListener('statechange', () => {
      if (serviceWorker!.state === 'activated') resolve()
    })
  })
}

addEventListener('mppx:complete', (event) => {
  const statusElement = document.getElementById('status')
  const authorization = event.detail
  if (statusElement) {
    statusElement.textContent = 'Verifying payment'
    statusElement.style.color = ''
  }

  navigator.serviceWorker
    .register(serviceWorkerPathname)
    .then(activateServiceWorker)
    .then(() => {
      function sendAndReload() {
        navigator.serviceWorker.controller!.postMessage(authorization)
        window.location.reload()
      }
      if (navigator.serviceWorker.controller) sendAndReload()
      else navigator.serviceWorker.addEventListener('controllerchange', sendAndReload)
    })
    .catch(() => {
      fetch(window.location.href, {
        headers: { Authorization: authorization },
      })
        .then((response) => {
          if (!response.ok) {
            if (statusElement) {
              statusElement.textContent = `Verification failed (${response.status})`
              statusElement.style.color = 'red'
            }
            return
          }
          return response.blob().then((blob) => {
            window.location = URL.createObjectURL(blob) as any
          })
        })
        .catch((error) => {
          if (statusElement) {
            statusElement.textContent = error.message || 'Request failed'
            statusElement.style.color = 'red'
          }
        })
    })
})
