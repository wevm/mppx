import './page.css'
import { Json } from 'ox'

import * as Credential from '../../../Credential.js'
import * as Html from '../../internal/constants.js'
import type * as Runtime from '../../internal/runtime.js'
import type { ShellState } from '../../mount.js'

const dataElement = document.getElementById(Html.elements.data)
if (!dataElement) throw new Error(`Missing #${Html.elements.data} element`)

type Data = {
  method?: {
    challenge: Runtime.Mppx['challenge']
    config?: Runtime.Config | undefined
    actions?: Runtime.Actions | undefined
  }
  methods?: Record<
    string,
    {
      challenge: Runtime.Mppx['challenge']
      config?: Runtime.Config | undefined
      actions?: Runtime.Actions | undefined
    }
  >
  shell?: Runtime.Shell | undefined
  support: {
    serviceWorkerUrl: string
  }
}

const data = Json.parse(dataElement.textContent!) as Data
const methods = data.methods ?? (data.method ? { default: data.method } : undefined)
const methodEntries = methods ? Object.entries(methods) : []
const firstMethod = methodEntries[0]?.[1]
const firstMethodKey = methodEntries[0]?.[0]
const isComposed = methodEntries.length > 1
const allChallenges = isComposed
  ? (Object.fromEntries(
      methodEntries.map(([key, method]) => [key, method.challenge]),
    ) as typeof mppx.challenges)
  : undefined
const composeMethodSearchParam = 'mppx_method'

if (!firstMethod || !firstMethodKey) throw new Error('Missing challenge')

let activeMethodKey = firstMethodKey

function composeMethodFromUrl(): string | null {
  return new URL(window.location.href).searchParams.get(composeMethodSearchParam)
}

function navigationUrl(): string {
  const url = new URL(window.location.href)
  url.hash = ''
  return url.toString()
}

function methodFor(key: string) {
  return methods?.[key] ?? firstMethod!
}

function serializeCredential(
  challenge: Runtime.Mppx['challenge'],
  payload: unknown,
  source?: string,
): string {
  return Credential.serialize({
    challenge,
    payload,
    ...(source && { source }),
  })
}

const runtimeCache = new Map<string, Runtime.ScopedMppx>()

function scopedRuntime(key: string): Runtime.ScopedMppx {
  const existing = runtimeCache.get(key)
  if (existing) return existing

  const method = methodFor(key)
  const challenge = method.challenge
  const config = (method.config ?? {}) as Runtime.Config
  const actions = (method.actions ?? {}) as Runtime.Actions
  const runtime = Object.freeze({
    challenge,
    challenges: allChallenges,
    config,
    actions,
    dispatch(payload: unknown, source?: string): void {
      dispatchEvent(
        new CustomEvent('mppx:complete', {
          detail: serializeCredential(challenge, payload, source),
        }),
      )
    },
    serializeCredential(payload: unknown, source?: string): string {
      return serializeCredential(challenge, payload, source)
    },
  })
  runtimeCache.set(key, runtime)
  return runtime
}

window.mppx = Object.freeze({
  get challenge() {
    return scopedRuntime(activeMethodKey).challenge
  },
  challenges: allChallenges,
  get config() {
    return scopedRuntime(activeMethodKey).config
  },
  get actions() {
    return scopedRuntime(activeMethodKey).actions
  },
  dispatch(payload: unknown, source?: string): void {
    scopedRuntime(activeMethodKey).dispatch(payload, source)
  },
  serializeCredential(payload: unknown, source?: string): string {
    return scopedRuntime(activeMethodKey).serializeCredential(payload, source)
  },
  scope(key: string): Runtime.ScopedMppx {
    return scopedRuntime(key)
  },
})

const summaryElement = document.getElementById(Html.elements.challenge)
const summaryAmounts = new Map<string, string>()

function updateSummary(challenge: Runtime.Mppx['challenge']) {
  if (!summaryElement) return
  const amountEl = summaryElement.querySelector(`.${Html.classNames.summaryAmount}`)
  const descEl = summaryElement.querySelector(`.${Html.classNames.description}`)
  const expiresEl = summaryElement.querySelector(`.${Html.classNames.summaryLabel}`)

  // Update amount from registered method amounts
  const activeTab = document.querySelector(
    '[role="tab"][aria-selected="true"]',
  ) as HTMLElement | null
  const key = isComposed ? activeTab?.dataset.method : undefined
  const registeredAmount = key ? summaryAmounts.get(key) : summaryAmounts.values().next().value
  if (amountEl && registeredAmount) {
    amountEl.textContent = registeredAmount
    ;(amountEl as HTMLElement).style.opacity = ''
  }

  // Update description
  if (descEl) descEl.textContent = challenge.description ?? ''

  // Update expires
  if (expiresEl)
    expiresEl.textContent = challenge.expires
      ? `Expires at ${new Date(challenge.expires).toLocaleString()}`
      : ''
}

if (summaryElement) {
  if (!summaryElement.querySelector(`.${Html.classNames.summaryAmount}`)) {
    const amountEl = document.createElement('div')
    amountEl.className = Html.classNames.summaryAmount
    summaryElement.appendChild(amountEl)

    const descEl = document.createElement('p')
    descEl.className = Html.classNames.description
    summaryElement.appendChild(descEl)

    const expiresEl = document.createElement('p')
    expiresEl.className = Html.classNames.summaryLabel
    summaryElement.appendChild(expiresEl)
  }

  updateSummary(firstMethod.challenge)
}

// Methods call this to register shell state such as the formatted amount.
window.addEventListener(
  'mppx:set' as any,
  ((e: CustomEvent<Runtime.SetEvent<ShellState>>) => {
    if (e.detail.name !== 'amount') return
    summaryAmounts.set(e.detail.key, e.detail.value)
    // Update if this is the active method (check actual selected tab, not __mppx_active)
    const activeTab = document.querySelector(
      '[role="tab"][aria-selected="true"]',
    ) as HTMLElement | null
    const activeKey = isComposed ? activeTab?.dataset.method : e.detail.key
    if (activeKey === e.detail.key) {
      const amountEl = summaryElement?.querySelector(`.${Html.classNames.summaryAmount}`)
      if (amountEl) {
        amountEl.textContent = e.detail.value
        ;(amountEl as HTMLElement).style.opacity = ''
      }
    }
  }) as EventListener,
)

// Apply text overrides
const text = data.shell?.text
const titleElement = document.querySelector<HTMLElement>(`.${Html.classNames.title}`)
const methodElement = document.getElementById(Html.elements.method)
const defaultTitle = text?.title ?? 'Payment Required'
const successText = text?.success ?? 'Verified payment'
const verifyingText = text?.verifying ?? 'Verifying payment'

type DebugState = 'default' | 'verifying' | 'success' | 'failed'

if (titleElement) titleElement.textContent = defaultTitle

const statePaneElement = document.createElement('div')
statePaneElement.role = 'status'

let detachedMethodNodes: Node[] | undefined

function statusElement() {
  return document.getElementById('status')
}

function hideMethodStateOverlay() {
  if (!methodElement) return
  methodElement.classList.remove(Html.classNames.methodOverlay)
  statePaneElement.remove()
}

function restoreMethodContent() {
  hideMethodStateOverlay()
  if (!methodElement || !detachedMethodNodes) return
  methodElement.replaceChildren(...detachedMethodNodes)
  detachedMethodNodes = undefined
}

function replaceMethodWithState(parameters: { className: string; message: string }) {
  const { className, message } = parameters
  if (!methodElement) return false
  hideMethodStateOverlay()
  if (!detachedMethodNodes) detachedMethodNodes = Array.from(methodElement.childNodes)
  statePaneElement.className = className
  statePaneElement.textContent = message
  methodElement.replaceChildren(statePaneElement)
  return true
}

function overlayMethodWithState(parameters: { className: string; message: string }) {
  const { className, message } = parameters
  if (!methodElement) return false
  if (detachedMethodNodes) restoreMethodContent()
  statePaneElement.className = `${className} mppx-state-pane--overlay`
  statePaneElement.textContent = message
  methodElement.classList.add(Html.classNames.methodOverlay)
  if (statePaneElement.parentElement !== methodElement) methodElement.appendChild(statePaneElement)
  return true
}

function setPageState(state: DebugState, message?: string) {
  if (titleElement) titleElement.textContent = defaultTitle

  const paneClassName =
    state === 'success'
      ? Html.classNames.statePaneSuccess
      : state === 'failed'
        ? Html.classNames.statePaneError
        : Html.classNames.statePane
  const paneMessage =
    state === 'success'
      ? successText
      : state === 'verifying'
        ? verifyingText
        : (message ?? text?.error ?? 'Verification failed')

  if (state === 'success') {
    if (replaceMethodWithState({ className: paneClassName, message: paneMessage })) return

    const element = statusElement()
    if (!element) return
    element.textContent = paneMessage
    element.className = Html.classNames.statusSuccess
    return
  }

  if (state === 'failed') {
    if (methodElement) {
      if (detachedMethodNodes) restoreMethodContent()
      hideMethodStateOverlay()
      statePaneElement.className = paneClassName
      statePaneElement.textContent = paneMessage
      methodElement.after(statePaneElement)
    } else {
      const element = statusElement()
      if (!element) return
      element.textContent = paneMessage
      element.className = Html.classNames.statusError
    }
    return
  }

  if (state !== 'default') {
    if (overlayMethodWithState({ className: paneClassName, message: paneMessage })) return

    const element = statusElement()
    if (!element) return
    element.textContent = paneMessage
    element.className = Html.classNames.status
    return
  }

  restoreMethodContent()

  const element = statusElement()

  if (!element) return
  element.textContent = ''
  element.className = Html.classNames.status
}

window.addEventListener(
  'mppx:debug-state' as any,
  ((event: CustomEvent<{ state: DebugState }>) => {
    setPageState(event.detail.state)
  }) as EventListener,
)

// Apply logo
const theme = data.shell?.theme
if (theme?.logo) {
  const header = document.querySelector(`.${Html.classNames.header}`)
  if (header) {
    if (typeof theme.logo === 'string') {
      const img = document.createElement('img')
      img.src = theme.logo
      img.alt = ''
      img.className = Html.classNames.logo
      header.insertBefore(img, header.firstChild)
    } else {
      const lightImg = document.createElement('img')
      lightImg.src = theme.logo.light
      lightImg.alt = ''
      lightImg.className = Html.classNames.logoLight
      header.insertBefore(lightImg, header.firstChild)
      const darkImg = document.createElement('img')
      darkImg.src = theme.logo.dark
      darkImg.alt = ''
      darkImg.className = Html.classNames.logoDark
      header.insertBefore(darkImg, lightImg.nextSibling)
    }
  }
}

// Tab switching for composed pages (WAI-ARIA tabs pattern)
if (isComposed) {
  const tabList = document.querySelector('[role="tablist"]')
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
  const panels = document.querySelectorAll(`.${Html.classNames.tabPanel}`)
  const defaultKey = tabs[0]?.dataset.method

  function syncComposeUrl(key: string) {
    const url = new URL(window.location.href)
    if (key === defaultKey) url.searchParams.delete(composeMethodSearchParam)
    else url.searchParams.set(composeMethodSearchParam, key)
    history.replaceState(null, '', url)
  }

  function activateTab(tab: HTMLElement, options?: { focus?: boolean; syncUrl?: boolean }) {
    const key = tab.dataset.method
    if (!key) return
    activeMethodKey = key
    tabs.forEach((t) => {
      t.className = 'mppx-tab'
      t.setAttribute('aria-selected', 'false')
      t.tabIndex = -1
    })
    tab.className = Html.classNames.tabActive
    tab.setAttribute('aria-selected', 'true')
    tab.tabIndex = 0
    if (options?.focus !== false) tab.focus()
    panels.forEach((p) => ((p as HTMLElement).hidden = (p as HTMLElement).dataset.method !== key))
    if (options?.syncUrl !== false) syncComposeUrl(key)
    // Update summary for the active method's challenge
    const challenge = methodFor(key).challenge
    if (challenge) updateSummary(challenge)
  }

  const initialKey = composeMethodFromUrl()
  const initialTab = tabs.find((tab) => tab.dataset.method === initialKey) ?? tabs[0]
  if (initialTab) activateTab(initialTab, { focus: false })

  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab)))

  addEventListener('popstate', () => {
    const key = composeMethodFromUrl()
    const tab = tabs.find((candidate) => candidate.dataset.method === key) ?? tabs[0]
    if (tab) activateTab(tab, { focus: false, syncUrl: false })
  })

  // Keyboard navigation: Arrow keys, Home, End
  tabList?.addEventListener('keydown', (e) => {
    const event = e as KeyboardEvent
    const current = tabs.indexOf(document.activeElement as HTMLElement)
    if (current === -1) return
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    if (next !== undefined) {
      event.preventDefault()
      activateTab(tabs[next]!)
    }
  })
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

function waitForServiceWorkerController(): Promise<ServiceWorker> {
  const controller = navigator.serviceWorker.controller
  if (controller) return Promise.resolve(controller)

  return new Promise((resolve) => {
    const onControllerChange = () => {
      const nextController = navigator.serviceWorker.controller
      if (!nextController) return
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      resolve(nextController)
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    onControllerChange()
  })
}

function sendCredentialToServiceWorker(parameters: {
  controller: ServiceWorker
  credential: string
  url: string
}): Promise<void> {
  const { controller, credential, url } = parameters

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port1.onmessageerror = () => reject(new Error('Failed to hand off payment credential'))
    controller.postMessage({ credential, url }, [channel.port2])
  })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderDocument(parameters: { body: string; title: string; url: string }): void {
  const { body, title, url } = parameters
  history.replaceState(null, '', url)
  document.open()
  document.write(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title><style>html{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem;line-height:1.5}main{max-width:960px;margin:0 auto}pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,0.12);padding:1rem;border-radius:0.75rem;overflow:auto}img,video,iframe,object{max-width:100%;width:100%;min-height:70vh;border:0;border-radius:0.75rem}audio{width:100%}a{color:inherit}</style></head><body><main>${body}</main></body></html>`,
  )
  document.close()
}

async function renderFetchedResponse(parameters: {
  response: Response
  url: string
}): Promise<void> {
  const { response, url } = parameters
  const contentType =
    response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? ''

  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    history.replaceState(null, '', url)
    document.open()
    document.write(await response.text())
    document.close()
    return
  }

  if (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType.endsWith('+json') ||
    contentType === 'application/xml' ||
    contentType.endsWith('+xml')
  ) {
    const text = await response.text()
    renderDocument({
      body: `<h1>Protected response</h1><pre>${escapeHtml(text)}</pre>`,
      title: 'Protected response',
      url,
    })
    return
  }

  const objectUrl = URL.createObjectURL(await response.blob())

  if (contentType.startsWith('image/')) {
    renderDocument({
      body: `<img alt="Protected response" src="${objectUrl}">`,
      title: 'Protected image',
      url,
    })
    return
  }

  if (contentType.startsWith('video/')) {
    renderDocument({
      body: `<video controls src="${objectUrl}"></video>`,
      title: 'Protected video',
      url,
    })
    return
  }

  if (contentType.startsWith('audio/')) {
    renderDocument({
      body: `<audio controls src="${objectUrl}"></audio>`,
      title: 'Protected audio',
      url,
    })
    return
  }

  if (contentType === 'application/pdf') {
    renderDocument({
      body: `<iframe src="${objectUrl}" title="Protected PDF"></iframe>`,
      title: 'Protected PDF',
      url,
    })
    return
  }

  renderDocument({
    body: `<h1>Protected response</h1><p>Payment succeeded, but your browser could not complete a standard navigation for this response type.</p><p><a href="${objectUrl}" download>Download the protected response</a></p>`,
    title: 'Protected response',
    url,
  })
}

addEventListener('mppx:complete', (event: CustomEvent<string>) => {
  const authorization = event.detail
  setPageState('verifying')

  navigator.serviceWorker
    .register(data.support.serviceWorkerUrl)
    .then(activateServiceWorker)
    .then(() => waitForServiceWorkerController())
    .then((controller) =>
      sendCredentialToServiceWorker({
        controller,
        credential: authorization,
        url: navigationUrl(),
      }),
    )
    .then(() => {
      setPageState('success')
      window.location.reload()
    })
    .catch(() => {
      fetch(navigationUrl(), {
        headers: { Authorization: authorization },
      })
        .then((response) => {
          if (!response.ok) {
            setPageState(
              'failed',
              text?.error
                ? `${text.error} (${response.status})`
                : `Verification failed (${response.status})`,
            )
            return
          }
          return renderFetchedResponse({ response, url: navigationUrl() })
        })
        .catch((error) => {
          setPageState('failed', error.message || text?.error || 'Request failed')
        })
    })
})
