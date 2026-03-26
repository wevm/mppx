import { stylesheet } from './stylesheet.js'

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

/** Service worker route used by the payment page shell. */
export const serviceWorker = {
  pathname: '/__mppx_serviceWorker.js',
} as const

/** Renders a `<style>` block (and optional font `<link>`) with CSS custom properties from a theme. */
export function style(theme: Theme | undefined): string {
  const t = theme ?? {}
  const colorScheme = t.colorScheme ?? 'light dark'
  const radius = t.radius ?? defaultTheme.radius
  const fontFamily = t.fontFamily ?? defaultTheme.fontFamily

  const colors = Object.fromEntries(
    colorTokens.map((name) => [name, resolveColor(t[name], defaultTheme[name])]),
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

const defaultTheme = {
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
] as const satisfies readonly (keyof typeof defaultTheme)[]

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
