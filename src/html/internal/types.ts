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
  /** Success status text shown after verification succeeds but before navigation completes. @default 'Verified payment' */
  success?: string | undefined
  /** Generic error text. @default 'Verification failed' */
  error?: string | undefined
}

/** Mppx-level HTML configuration. */
export type Config = {
  /** Visual theme for payment pages. */
  theme?: Theme | undefined
  /** Copy/i18n text overrides. */
  text?: Text | undefined
}
