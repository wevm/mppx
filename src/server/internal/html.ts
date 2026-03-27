import type * as Challenge from '../../Challenge.js'
import { content, pageStyle, script, serviceWorker as serviceWorkerGen } from './html.gen.js'
import { classNames, elements, serviceWorker as serviceWorkerRoute, style } from './html.shared.js'
import type { Config, LightDark, Text, Theme } from './html.shared.js'

export { classNames, elements, style }
export type { Config, LightDark, Text, Theme }

/** Service worker that injects a one-shot Authorization header on the next navigation. */
export const serviceWorker = {
  pathname: serviceWorkerRoute.pathname,
  script: serviceWorkerGen as string,
} as const

/**
 * Renders a self-contained HTML payment page for a 402 challenge.
 *
 * Replaces comment slots in the page template:
 * - `<!--mppx:head-->` — viewport, title, and styles
 * - `<!--mppx:data-->` — challenge + config JSON
 * - `<!--mppx:script-->` — bundled page script
 * - `<!--mppx:method-->` — method-specific HTML
 */
export type Options = {
  /** Method-specific HTML content. Must be from a trusted source (e.g. build-time generated `html.gen.ts`). */
  content: string
  config?: Record<string, unknown> | undefined
  theme?: Theme | undefined
  text?: Text | undefined
}

export type Props = Options & {
  challenge: Challenge.Challenge
}

export function render(props: Props): string {
  const title = props.text?.title ?? 'Payment Required'
  const config = {
    ...props.config,
    ...(props.text ? { text: props.text } : {}),
    ...(props.theme ? { theme: props.theme } : {}),
  }
  const data = JSON.stringify({ challenge: props.challenge, config }).replace(/</g, '\\u003c')
  const themeStyle = style(props.theme)
  const head = `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>${themeStyle}${pageStyle}`
  return content
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${data}</script>`,
    )
    .replace('<!--mppx:script-->', script)
    .replace('<!--mppx:method-->', props.content)
}

/** A method entry for composed (multi-method) rendering. */
export type ComposedMethod = {
  name: string
  intent: string
  challenge: Challenge.Challenge
  content: string
  config?: Record<string, unknown> | undefined
}

/**
 * Renders a multi-method HTML payment page with tabs.
 *
 * Each method gets its own tab panel with a scoped root element.
 * Method scripts are prepended with `__mppx_root` and `__mppx_active`
 * assignments so each module initializes with the correct context.
 */
export function compose(props: {
  methods: readonly ComposedMethod[]
  theme?: Theme | undefined
  text?: Text | undefined
}): string {
  const { methods } = props
  const title = props.text?.title ?? 'Payment Required'

  // Build data: challenges + configs keyed by "name/intent"
  const challenges: Record<string, Challenge.Challenge> = {}
  const configs: Record<string, Record<string, unknown>> = {}
  for (const m of methods) {
    const key = `${m.name}/${m.intent}`
    challenges[key] = m.challenge
    if (m.config) configs[key] = m.config
  }
  const config = {
    ...(props.text ? { text: props.text } : {}),
    ...(props.theme ? { theme: props.theme } : {}),
  }
  const data = JSON.stringify({ challenges, configs, config }).replace(/</g, '\\u003c')

  // Tab bar (WAI-ARIA tabs pattern)
  const tabBar = methods
    .map((m, i) => {
      const key = `${m.name}/${m.intent}`
      const panelId = `mppx-panel-${m.name}-${m.intent}`
      const tabId = `mppx-tab-${m.name}-${m.intent}`
      const cls = i === 0 ? classNames.tabActive : classNames.tab
      const selected = i === 0
      return `<button id="${tabId}" class="${cls}" role="tab" aria-selected="${selected}" aria-controls="${panelId}" tabindex="${selected ? 0 : -1}" data-method="${key}">${m.name}</button>`
    })
    .join('\n      ')

  // Tab panels — each has a unique root ID and a preamble script
  const panels = methods
    .map((m, i) => {
      const key = `${m.name}/${m.intent}`
      const rootId = `${elements.method}-${m.name}-${m.intent}`
      const panelId = `mppx-panel-${m.name}-${m.intent}`
      const tabId = `mppx-tab-${m.name}-${m.intent}`
      const hidden = i === 0 ? '' : ' hidden'
      // Inject __mppx_root and __mppx_active before the method's module script.
      // The method html contains an inline <script type="module"> — we prepend
      // assignments inside it so they execute at the top of that module.
      const patchedHtml = m.content.replace(
        '<script type="module">',
        `<script type="module">window.__mppx_root="${rootId}";window.__mppx_active="${key}";`,
      )
      return `<div id="${panelId}" class="${classNames.tabPanel}" role="tabpanel" aria-labelledby="${tabId}" data-method="${key}"${hidden}>\n      <div id="${rootId}">${patchedHtml}</div>\n    </div>`
    })
    .join('\n    ')

  const methodContent = `<div class="${classNames.tabs}" role="tablist" aria-label="Payment method">\n      ${tabBar}\n    </div>\n    ${panels}`

  const themeStyle = style(props.theme)
  const head = `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>${themeStyle}${pageStyle}`
  return content
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${data}</script>`,
    )
    .replace('<!--mppx:script-->', script)
    .replace(
      `<div class="${classNames.method}" id="${elements.method}"><!--mppx:method--></div>`,
      methodContent,
    )
}
