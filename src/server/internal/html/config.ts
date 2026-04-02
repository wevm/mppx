import type * as Challenge from '../../../Challenge.js'
import type * as Method from '../../../Method.js'

export type Options = {
  config: Record<string, unknown>
  content: string
  formatAmount: (request: any) => string | Promise<string>
  text: Text | undefined
  theme: Theme | undefined
}

export type Data<
  method extends Method.Method = Method.Method,
  config extends Record<string, unknown> = {},
> = {
  config: config
  challenge: Challenge.FromMethods<[method]>
  text: { [k in keyof Text]-?: NonNullable<Text[k]> }
  theme: {
    [k in keyof Omit<Theme, 'favicon' | 'fontUrl' | 'logo'>]-?: NonNullable<Theme[k]>
  }
}

export const dataId = '__MPPX_DATA__'

export const errorId = 'root_error'

export const rootId = 'root'

export const serviceWorkerParam = '__mppx_worker'

export const classNames = {
  error: 'mppx-error',
  header: 'mppx-header',
  logo: 'mppx-logo',
  logoColorScheme: (colorScheme: string) =>
    colorScheme === 'dark' || colorScheme === 'light'
      ? `${classNames.logo}--${colorScheme}`
      : undefined,
  summary: 'mppx-summary',
  summaryAmount: 'mppx-summary-amount',
  summaryDescription: 'mppx-summary-description',
  summaryExpires: 'mppx-summary-expires',
}

export function sanitize(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const html = String.raw

class CssVar {
  readonly name: string
  constructor(token: string) {
    this.name = `--mppx-${token}`
  }
  toString() {
    return `var(${this.name})`
  }
}

export const vars = {
  accent: new CssVar('accent'),
  background: new CssVar('background'),
  border: new CssVar('border'),
  foreground: new CssVar('foreground'),
  muted: new CssVar('muted'),
  negative: new CssVar('negative'),
  positive: new CssVar('positive'),
  surface: new CssVar('surface'),
  fontFamily: new CssVar('font-family'),
  fontSizeBase: new CssVar('font-size-base'),
  radius: new CssVar('radius'),
  spacingUnit: new CssVar('spacing-unit'),
} as const

export function font(theme: Theme) {
  if (!theme.fontUrl) return ''
  return html`<link rel="preconnect" href="${new URL(theme.fontUrl).origin}" crossorigin />
    <link rel="stylesheet" href="${theme.fontUrl}" />`
}

export function style(theme: {
  [k in keyof Omit<Theme, 'favicon' | 'fontUrl' | 'logo'>]-?: NonNullable<Theme[k]>
}) {
  const colors = Object.fromEntries(
    colorTokens.map((name) => [name, resolveColor(theme[name], defaultTheme[name])]),
  ) as Record<(typeof colorTokens)[number], readonly [light: string, dark: string]>
  const lightVars = colorTokens
    .map((token) => `${vars[token].name}: ${colors[token][0]};`)
    .join('\n      ')
  const darkVars = colorTokens
    .map((token) => `${vars[token].name}: ${colors[token][1]};`)
    .join('\n      ')
  const isLightOnly = theme.colorScheme === 'light'
  const isDarkOnly = theme.colorScheme === 'dark'
  const rootVars = isDarkOnly ? darkVars : lightVars
  const darkMedia =
    !isLightOnly && !isDarkOnly
      ? `\n    @media (prefers-color-scheme: dark) {\n      :root {\n        ${darkVars}\n      }\n    }`
      : ''
  return html`
    <style>
      ${reset}
      :root {
        color-scheme: ${theme.colorScheme};
        ${vars.fontFamily.name}: ${theme.fontFamily};
        ${vars.fontSizeBase.name}: ${theme.fontSizeBase};
        ${vars.radius.name}: ${theme.radius};
        ${vars.spacingUnit.name}: ${theme.spacingUnit};
        ${rootVars}
      }${darkMedia}
      *:focus-visible {
        outline-color: ${vars.accent};
        outline-offset: 0.15rem;
        outline-style: solid;
        outline-width: 2px;
      }
      body {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        background: ${vars.background};
        color: ${vars.foreground};
        font-family: ${vars.fontFamily};
        font-size: ${vars.fontSizeBase};
      }
      main {
        display: flex;
        flex-direction: column;
        gap: calc(${vars.spacingUnit} * 8);
        margin-left: auto;
        margin-right: auto;
        max-width: clamp(300px, calc(${vars.spacingUnit} * 224), 896px);
        padding: calc(${vars.spacingUnit} * 12) calc(${vars.spacingUnit} * 8) calc(${vars.spacingUnit} * 16);
      }
      .${classNames.header} {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: calc(${vars.spacingUnit} * 4);
        justify-content: space-between;
        span {
          background: ${vars.surface};
          border: 1px solid ${vars.border};
          border-radius: calc(${vars.spacingUnit} * 50);
          font-size: 0.75rem;
          font-weight: 500;
          letter-spacing: 0.025em;
          padding: calc(${vars.spacingUnit} * 1) calc(${vars.spacingUnit} * 4);
        }
      }
      .${classNames.logo} {
        max-height: 1.75rem;
      }
      .${classNames.logoColorScheme('dark')} {
        @media (prefers-color-scheme: light) {
          display: none;
        }
      }
      .${classNames.logoColorScheme('light')} {
        @media (prefers-color-scheme: dark) {
          display: none;
        }
      }
      .${classNames.summary} {
        background: ${vars.surface};
        border: 1px solid ${vars.border};
        border-radius: ${vars.radius};
        display: flex;
        flex-direction: column;
        gap: calc(${vars.spacingUnit} * 3);
        padding: calc(${vars.spacingUnit} * 6) calc(${vars.spacingUnit} * 6);
      }
      .${classNames.summaryAmount} {
        font-size: 2.5rem;
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        line-height: 1.2;
      }
      .${classNames.summaryDescription} {
        font-size: 1.25rem;
      }
      .${classNames.summaryExpires} {
        color: ${vars.muted};
      }
      .${classNames.error} {
        color: ${vars.negative};
        font-size: 0.95rem;
        margin-top: calc(${vars.spacingUnit} * -1.5);
        text-align: center;
      }
    </style>
  `
}

export function showError(message: string) {
  const existing = document.getElementById(errorId)
  if (existing) {
    existing.textContent = message
    return
  }
  const el = document.createElement('p')
  el.id = errorId
  el.className = classNames.error
  el.role = 'alert'
  el.textContent = message
  document.getElementById(rootId)?.after(el)
}

export function favicon(theme: Theme, realm: string) {
  if (typeof theme.favicon === 'string') return html`<link rel="icon" href="${theme.favicon}" />`
  if (typeof theme.favicon === 'object') {
    return html`<link
        rel="icon"
        href="${theme.favicon.light}"
        media="(prefers-color-scheme: light)"
      />
      <link rel="icon" href="${theme.favicon.dark}" media="(prefers-color-scheme: dark)" />`
  }
  // Fallback: use host's favicon via Google S2 service
  try {
    const domain = new URL(realm).hostname
    return html`<link
      rel="icon"
      href="https://www.google.com/s2/favicons?domain=${domain}&sz=64"
    />`
  } catch {
    return ''
  }
}

export function logo(value: Theme) {
  if (typeof value.logo === 'undefined') return ''
  if (typeof value.logo === 'string')
    return html`<img alt="" class="${classNames.logo}" src="${value.logo}" />`
  return Object.entries(value.logo)
    .map(
      (entry) =>
        html`<img
          alt=""
          class="${classNames.logo} ${classNames.logoColorScheme(entry[0])}"
          src="${entry[1]}"
        />`,
    )
    .join('\n')
}

export type Text = {
  /** Prefix for the expiry line. @default 'Expires at' */
  expires?: string | undefined
  /** Pay button label. @default 'Pay' */
  pay?: string | undefined
  /** Badge label. @default 'Payment Required' */
  paymentRequired?: string | undefined
  /** Page title. @default text.paymentRequired */
  title?: string | undefined
}

export const defaultText = {
  expires: 'Expires at',
  pay: 'Pay',
  paymentRequired: 'Payment Required',
  title: 'Payment Required',
} as const satisfies Required<Text>

export type Theme = {
  /** Color scheme. @default 'light dark' */
  colorScheme?: 'light' | 'dark' | 'light dark' | undefined
  /** Font family. @default 'system-ui, -apple-system, sans-serif' */
  fontFamily?: string | undefined
  /** Base font size. @default '16px' */
  fontSizeBase?: string | undefined
  /** Font URL to inject (e.g. Google Fonts `<link>`). */
  fontUrl?: string | undefined
  /** Favicon URL. Light/dark variants supported. Falls back to host's favicon via Google S2 service. */
  favicon?: string | { light: string; dark: string } | undefined
  /** Logo URL shown in header. Light/dark variants supported. */
  logo?: string | { light: string; dark: string } | undefined
  /** Border radius. @default '6px' */
  radius?: string | undefined
  /** The base spacing unit that all other spacing is derived from. Increase or decrease this value to make your layout more or less spacious. @default '2px' */
  spacingUnit?: string | undefined

  /** Accent color (buttons, links). @default ['#171717', '#ededed'] */
  accent?: LightDark | undefined
  /** Page background. @default ['#ffffff', '#0a0a0a'] */
  background?: LightDark | undefined
  /** Border color. @default ['#e5e5e5', '#2e2e2e'] */
  border?: LightDark | undefined
  /** Primary text/content color. @default ['#0a0a0a', '#ededed'] */
  foreground?: LightDark | undefined
  /** Secondary/muted text. @default ['#666666', '#a1a1a1'] */
  muted?: LightDark | undefined
  /** Error/danger color. @default ['#e5484d', '#e5484d'] */
  negative?: LightDark | undefined
  /** Success color. @default ['#30a46c', '#30a46c'] */
  positive?: LightDark | undefined
  /** Input/card surface. @default ['#f5f5f5', '#1a1a1a'] */
  surface?: LightDark | undefined
}

export type LightDark = string | readonly [light: string, dark: string]

export const defaultTheme = {
  colorScheme: 'light dark',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSizeBase: '16px',
  radius: '6px',
  spacingUnit: '2px',

  accent: ['#171717', '#ededed'],
  background: ['#ffffff', '#0a0a0a'],
  border: ['#e5e5e5', '#2e2e2e'],
  foreground: ['#0a0a0a', '#ededed'],
  muted: ['#666666', '#a1a1a1'],
  negative: ['#e5484d', '#e5484d'],
  positive: ['#30a46c', '#30a46c'],
  surface: ['#f5f5f5', '#1a1a1a'],
} as const satisfies Required<Omit<Theme, 'favicon' | 'fontUrl' | 'logo'>>

export const colorTokens = [
  'accent',
  'negative',
  'positive',
  'background',
  'foreground',
  'muted',
  'surface',
  'border',
] as const satisfies readonly (keyof typeof defaultTheme)[]

export function resolveColor(
  value: Theme[(typeof colorTokens)[number]] | undefined,
  fallback: readonly [string, string],
): readonly [light: string, dark: string] {
  if (!value) return fallback
  if (typeof value === 'string') return [value, value]
  return value
}

export function mergeDefined<type>(defaults: type, value: DeepPartial<type> | undefined): type {
  if (value === undefined) return defaults
  if (!isPlainObject(defaults) || !isPlainObject(value)) return (value ?? defaults) as type

  const result: Record<string, unknown> = { ...defaults }

  for (const [key, nextValue] of Object.entries(value)) {
    if (nextValue === undefined) continue

    const currentValue = result[key]

    result[key] =
      isPlainObject(currentValue) && isPlainObject(nextValue)
        ? mergeDefined(currentValue, nextValue)
        : nextValue
  }

  return result as type
}
type DeepPartial<type> = {
  [key in keyof type]?: type[key] extends readonly unknown[]
    ? type[key] | undefined
    : type[key] extends object
      ? DeepPartial<type[key]> | undefined
      : type[key] | undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Slimmed down Tailwind preflight
// https://github.com/tailwindlabs/tailwindcss/blob/main/packages/tailwindcss/preflight.css
const reset = html`
  *, ::after, ::before, ::backdrop, ::file-selector-button { box-sizing: border-box; margin: 0;
  padding: 0; border: 0 solid; border-color: ${vars.border}; } html, :host { line-height: 1.5;
  -webkit-text-size-adjust: 100%; tab-size: 4; -webkit-tap-highlight-color: transparent; } h1, h2,
  h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; } a { color: inherit;
  -webkit-text-decoration: inherit; text-decoration: inherit; } b, strong { font-weight: bolder; }
  code, kbd, samp, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
  'Liberation Mono', 'Courier New', monospace; font-size: 1em; } small { font-size: 80%; } ol, ul,
  menu { list-style: none; } img, svg, video, canvas, audio, iframe, embed, object { display: block;
  vertical-align: middle; } img, video { max-width: 100%; height: auto; } button, input, select,
  optgroup, textarea, ::file-selector-button { font: inherit; font-feature-settings: inherit;
  font-variation-settings: inherit; letter-spacing: inherit; color: inherit; border-radius: 0;
  background-color: transparent; opacity: 1; } ::file-selector-button { margin-inline-end: 4px; }
  ::placeholder { opacity: 1; } @supports (not (-webkit-appearance: -apple-pay-button)) or
  (contain-intrinsic-size: 1px) { ::placeholder { color: color-mix(in oklab, currentcolor 50%,
  transparent); } } textarea { resize: vertical; } ::-webkit-search-decoration { -webkit-appearance:
  none; } :-moz-ui-invalid { box-shadow: none; } button, input:where([type='button'],
  [type='reset'], [type='submit']), ::file-selector-button { appearance: button; }
  ::-webkit-inner-spin-button, ::-webkit-outer-spin-button { height: auto; }
  [hidden]:where(:not([hidden='until-found'])) { display: none !important; }
`
