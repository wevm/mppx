import type * as Challenge from '../Challenge.js'
import { content, script, serviceWorker as serviceWorkerGen } from './internal/html.gen.js'
import { stylesheet } from './internal/stylesheet.js'

/** Element IDs used in the payment page template. */
export const elements = {
  challenge: 'mppx-challenge',
  data: 'mppx-data',
  method: 'mppx-method',
} as const

/** Class names used in the payment page template. */
export const classNames = {
  account: 'mppx-account',
  button: 'mppx-button',
  buttonSecondary: 'mppx-button mppx-button--secondary',
  buttonTertiary: 'mppx-button mppx-button--tertiary',
  description: 'mppx-description',
  summary: 'mppx-summary',
  summaryAmount: 'mppx-summary-amount',
  summaryRow: 'mppx-summary-row',
  summaryLabel: 'mppx-summary-label',
  summaryValue: 'mppx-summary-value',
  disconnect: 'mppx-disconnect',
  header: 'mppx-header',
  logo: 'mppx-logo',
  logoDark: 'mppx-logo mppx-logo--dark',
  logoLight: 'mppx-logo mppx-logo--light',
  method: 'mppx-method',
  status: 'mppx-status',
  statusError: 'mppx-status mppx-status--error',
  statusSuccess: 'mppx-status mppx-status--success',
  tab: 'mppx-tab',
  tabActive: 'mppx-tab mppx-tab--active',
  tabPanel: 'mppx-tab-panel',
  tabs: 'mppx-tabs',
  title: 'mppx-title',
  wallets: 'mppx-wallets',
} as const

/** Service worker that injects a one-shot Authorization header on the next navigation. */
export const serviceWorker = {
  pathname: '/__mppx_serviceWorker.js',
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
  const head = `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>${themeStyle}`
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
  html: string
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
      const patchedHtml = m.html.replace(
        '<script type="module">',
        `<script type="module">window.__mppx_root="${rootId}";window.__mppx_active="${key}";`,
      )
      return `<div id="${panelId}" class="${classNames.tabPanel}" role="tabpanel" aria-labelledby="${tabId}" data-method="${key}"${hidden}>\n      <div id="${rootId}">${patchedHtml}</div>\n    </div>`
    })
    .join('\n    ')

  const methodContent = `<div class="${classNames.tabs}" role="tablist" aria-label="Payment method">\n      ${tabBar}\n    </div>\n    ${panels}`

  const themeStyle = style(props.theme)
  const head = `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>${themeStyle}`
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

/** Renders a `<style>` block (and optional font `<link>`) with CSS custom properties from a theme. */
export function style(theme: Theme | undefined): string {
  const t = theme ?? {}
  const colorScheme = t.colorScheme ?? 'light dark'
  const radius = t.radius ?? themeDefaults.radius
  const fontFamily = t.fontFamily ?? themeDefaults.fontFamily

  const colors = Object.fromEntries(
    colorTokens.map((name) => [name, resolveColor(t[name], themeDefaults[name])]),
  ) as Record<(typeof colorTokens)[number], readonly [string, string]>

  const lightVars = colorTokens.map((n) => `--mppx-${n}: ${colors[n][0]};`).join('\n      ')
  const darkVars = colorTokens.map((n) => `--mppx-${n}: ${colors[n][1]};`).join('\n      ')

  const fontLink = t.fontUrl ? `\n  <link rel="stylesheet" href="${t.fontUrl}" />` : ''

  const isLightOnly = colorScheme === 'light'
  const isDarkOnly = colorScheme === 'dark'
  const rootVars = isDarkOnly ? darkVars : lightVars

  const darkMedia =
    !isLightOnly && !isDarkOnly
      ? `\n    @media (prefers-color-scheme: dark) {\n      :root {\n        ${darkVars}\n      }\n    }`
      : ''

  return `${fontLink}
  <style>
    :root {
      color-scheme: ${colorScheme};
      ${rootVars}
      --mppx-radius: ${radius};
      --mppx-font-family: ${fontFamily};
    }${darkMedia}
    ${stylesheet}
  </style>`
}

/** Mppx-level HTML configuration. */
export type Config = {
  /** Visual theme for payment pages. */
  theme?: Theme | undefined
  /** Copy/i18n text overrides. */
  text?: Text | undefined
}

const themeDefaults = {
  accent: ['#171717', '#ededed'],
  negative: ['#e5484d', '#e5484d'],
  positive: ['#30a46c', '#30a46c'],
  background: ['#ffffff', '#0a0a0a'],
  foreground: ['#0a0a0a', '#ededed'],
  muted: ['#666666', '#a1a1a1'],
  surface: ['#f5f5f5', '#1a1a1a'],
  border: ['#e5e5e5', '#2e2e2e'],
  radius: '6px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
} as const satisfies Required<Omit<Theme, 'colorScheme' | 'fontUrl' | 'logo'>>

const colorTokens = [
  'accent',
  'negative',
  'positive',
  'background',
  'foreground',
  'muted',
  'surface',
  'border',
] as const satisfies readonly (keyof typeof themeDefaults)[]

function resolveColor(
  value: LightDark | undefined,
  fallback: readonly [string, string],
): readonly [light: string, dark: string] {
  if (!value) return fallback
  if (typeof value === 'string') return [value, value]
  return value
}

/** Single color or `[light, dark]` tuple. */
export type LightDark = string | readonly [light: string, dark: string]

/** Theme configuration. */
export type Theme = {
  /** Color scheme. @default 'light dark' */
  colorScheme?: 'light' | 'dark' | 'light dark' | undefined
  /** Accent color (buttons, links). @default ['#171717', '#ededed'] */
  accent?: LightDark | undefined
  /** Error/danger color. @default ['#e5484d', '#e5484d'] */
  negative?: LightDark | undefined
  /** Success color. @default ['#30a46c', '#30a46c'] */
  positive?: LightDark | undefined
  /** Page background. @default ['#ffffff', '#0a0a0a'] */
  background?: LightDark | undefined
  /** Primary text/content color. @default ['#0a0a0a', '#ededed'] */
  foreground?: LightDark | undefined
  /** Secondary/muted text. @default ['#666666', '#a1a1a1'] */
  muted?: LightDark | undefined
  /** Input/card surface. @default ['#f5f5f5', '#1a1a1a'] */
  surface?: LightDark | undefined
  /** Border color. @default ['#e5e5e5', '#2e2e2e'] */
  border?: LightDark | undefined
  /** Border radius. @default '6px' */
  radius?: string | undefined
  /** Font family. @default 'system-ui, -apple-system, sans-serif' */
  fontFamily?: string | undefined
  /** Font URL to inject (e.g. Google Fonts `<link>`). */
  fontUrl?: string | undefined
  /** Logo URL shown in header. Light/dark variants supported. */
  logo?: string | { light: string; dark: string } | undefined
}

/** Copy/i18n text overrides. */
export type Text = {
  /** Page title. @default 'Payment Required' */
  title?: string | undefined
  /** Verifying status text. @default 'Verifying payment' */
  verifying?: string | undefined
  /** Generic error text. @default 'Verification failed' */
  error?: string | undefined
}
