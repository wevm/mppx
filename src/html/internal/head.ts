import type { Theme } from './types.js'

/** Renders theme variables (and optional font `<link>`) for the payment page shell. */
export function style(theme: Theme | undefined = {}) {
  const colorScheme = theme.colorScheme ?? 'light dark'
  const radius = theme.radius ?? defaultTheme.radius
  const fontFamily = theme.fontFamily ?? defaultTheme.fontFamily

  const colors = Object.fromEntries(
    colorTokens.map((name) => [name, resolveColor(theme[name], defaultTheme[name])]),
  ) as Record<(typeof colorTokens)[number], readonly [string, string]>

  const lightVars = colorTokens
    .map((token) => `--mppx-${token}: ${colors[token][0]};`)
    .join('\n      ')
  const darkVars = colorTokens
    .map((token) => `--mppx-${token}: ${colors[token][1]};`)
    .join('\n      ')

  const fontLink = theme.fontUrl ? `\n  <link rel="stylesheet" href="${theme.fontUrl}" />` : ''

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
  </style>`
}

export function renderHead(options: {
  title: string
  theme?: Theme | undefined
  assets?: string | undefined
}) {
  return `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${options.title}</title>${style(options.theme)}${options.assets ?? ''}`
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
  value: Theme[(typeof colorTokens)[number]] | undefined,
  fallback: readonly [string, string],
): readonly [light: string, dark: string] {
  if (!value) return fallback
  if (typeof value === 'string') return [value, value]
  return value
}
