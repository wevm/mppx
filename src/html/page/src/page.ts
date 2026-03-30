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
      methodElement.before(statePaneElement)
    } else {
      const element = statusElement()
      if (!element) return
      element.textContent = paneMessage
      element.className = Html.classNames.statusError
    }
    dispatchEvent(new CustomEvent('mppx:failed', { detail: { message: paneMessage } }))
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

function waitForServiceWorkerReady(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  const sw = reg.installing || reg.waiting || reg.active
  if (!sw) throw new Error('No service worker in registration')
  return new Promise((resolve) => {
    if (sw.state === 'activated') {
      if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller)
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => resolve(navigator.serviceWorker.controller!),
        { once: true },
      )
      return
    }
    sw.addEventListener('statechange', () => {
      if (sw.state !== 'activated') return
      if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller)
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => resolve(navigator.serviceWorker.controller!),
        { once: true },
      )
    })
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

addEventListener('mppx:complete', (event: CustomEvent<string>) => {
  const authorization = event.detail
  setPageState('verifying')

  navigator.serviceWorker
    .register(data.support.serviceWorkerUrl)
    .then(waitForServiceWorkerReady)
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
      setPageState('failed', text?.error ?? 'Payment service unavailable')
    })
})
