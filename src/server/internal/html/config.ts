export type Options = {
  config: Record<string, unknown>
  content: string
  text: Text | undefined
  theme: Theme | undefined
}

export const dataId = '__MPPX_DATA__'

export const serviceWorkerParam = '__mppx_worker'

export const classNames = {
  logo: 'mppx-logo',
  logoColorScheme: (colorScheme: string) =>
    colorScheme === 'dark' || colorScheme === 'light'
      ? `${classNames.logo}--${colorScheme}`
      : undefined,
}

export const html = String.raw

export function style(theme: Theme) {
  const colors = Object.fromEntries(
    colorTokens.map((name) => [name, resolveColor(theme[name], defaultTheme[name])]),
  ) as Record<(typeof colorTokens)[number], readonly [light: string, dark: string]>
  const lightVars = colorTokens
    .map((token) => `--mppx-${token}: ${colors[token][0]};`)
    .join('\n      ')
  const darkVars = colorTokens
    .map((token) => `--mppx-${token}: ${colors[token][1]};`)
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
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      :root {
        color-scheme: ${theme.colorScheme};
        ${rootVars}
        --mppx-radius: ${theme.radius};
        --mppx-font-family: ${theme.fontFamily};
      }${darkMedia}
      body {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        background: var(--mppx-background);
        color: var(--mppx-foreground);
      }
      [hidden] {
        display: none !important;
      }
      .${classNames.logo} {
        max-height: 2.5rem;
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
    </style>
  `
}

export function logo(value: Theme['logo']) {
  if (typeof value === 'undefined') return ``
  if (typeof value === 'string') return html`<img class="${classNames.logo}" src="${value}" />`
  return Object.entries(value)
    .map(
      ([key, value]) =>
        html`<img class="${classNames.logo} ${classNames.logoColorScheme(key)}" src="${value}" />`,
    )
    .join('\n')
}

export type Text = {
  /** Page title. @default 'Payment Required' */
  title?: string | undefined
}

export const defaultText = {
  title: 'Payment Required',
} as const satisfies Required<Text>

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

export type LightDark = string | readonly [light: string, dark: string]

export const defaultTheme = {
  colorScheme: 'light dark',
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
} as const satisfies Required<Omit<Theme, 'fontUrl' | 'logo'>>

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
