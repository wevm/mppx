import * as Html from './constants.js'
import { cloudflare, nyt, stripe, vercel } from './logos/index.js'

type ThemeColors = {
  '--mppx-accent': string
  '--mppx-background': string
  '--mppx-foreground': string
  '--mppx-muted': string
  '--mppx-surface': string
  '--mppx-border': string
  [key: string]: string
}

type ThemeEntry = {
  light: ThemeColors
  dark: ThemeColors
  logo?: string | { light: string; dark: string }
}

const themes: Record<string, ThemeEntry> = {
  Default: {
    light: {
      '--mppx-accent': '#171717',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#0a0a0a',
      '--mppx-muted': '#666666',
      '--mppx-surface': '#f5f5f5',
      '--mppx-border': '#e5e5e5',
    },
    dark: {
      '--mppx-accent': '#ededed',
      '--mppx-background': '#0a0a0a',
      '--mppx-foreground': '#ededed',
      '--mppx-muted': '#a1a1a1',
      '--mppx-surface': '#1a1a1a',
      '--mppx-border': '#2e2e2e',
    },
  },
  Cloudflare: {
    light: {
      '--mppx-accent': '#f6821f',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#1a1a1a',
      '--mppx-muted': '#6b7280',
      '--mppx-surface': '#f4f5f7',
      '--mppx-border': '#e5e7eb',
      '--mppx-radius': '8px',
    },
    dark: {
      '--mppx-accent': '#f6821f',
      '--mppx-background': '#0d1117',
      '--mppx-foreground': '#e6edf3',
      '--mppx-muted': '#8b949e',
      '--mppx-surface': '#161b22',
      '--mppx-border': '#30363d',
      '--mppx-radius': '8px',
    },
    logo: cloudflare,
  },
  Stripe: {
    light: {
      '--mppx-accent': '#635bff',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#0a2540',
      '--mppx-muted': '#6b7c93',
      '--mppx-surface': '#f6f9fc',
      '--mppx-border': '#e3e8ee',
      '--mppx-radius': '8px',
    },
    dark: {
      '--mppx-accent': '#635bff',
      '--mppx-background': '#0a2540',
      '--mppx-foreground': '#e3e8ee',
      '--mppx-muted': '#8898aa',
      '--mppx-surface': '#112240',
      '--mppx-border': '#1a3350',
      '--mppx-radius': '8px',
    },
    logo: stripe,
  },
  NYT: {
    light: {
      '--mppx-accent': '#000000',
      '--mppx-background': '#f7f7f5',
      '--mppx-foreground': '#121212',
      '--mppx-muted': '#666666',
      '--mppx-surface': '#eeeee9',
      '--mppx-border': '#dfdfda',
      '--mppx-radius': '2px',
      '--mppx-font-family': 'Georgia, "Times New Roman", Times, serif',
    },
    dark: {
      '--mppx-accent': '#ffffff',
      '--mppx-background': '#121212',
      '--mppx-foreground': '#e8e8e8',
      '--mppx-muted': '#999999',
      '--mppx-surface': '#1a1a1a',
      '--mppx-border': '#333333',
      '--mppx-radius': '2px',
      '--mppx-font-family': 'Georgia, "Times New Roman", Times, serif',
    },
    logo: nyt,
  },
  Vercel: {
    light: {
      '--mppx-accent': '#000000',
      '--mppx-background': '#ffffff',
      '--mppx-foreground': '#171717',
      '--mppx-muted': '#666666',
      '--mppx-surface': '#fafafa',
      '--mppx-border': '#eaeaea',
      '--mppx-radius': '6px',
      '--mppx-font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    dark: {
      '--mppx-accent': '#ffffff',
      '--mppx-background': '#000000',
      '--mppx-foreground': '#ededed',
      '--mppx-muted': '#888888',
      '--mppx-surface': '#111111',
      '--mppx-border': '#333333',
      '--mppx-radius': '6px',
      '--mppx-font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    logo: vercel,
  },
}

const allKeys = [
  ...new Set(
    Object.values(themes).flatMap((t) => [...Object.keys(t.light), ...Object.keys(t.dark)]),
  ),
]

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
const prefersDark = () => mediaQuery.matches

let active = 'Default'

const widget = document.createElement('div')
Object.assign(widget.style, {
  position: 'fixed',
  top: '12px',
  right: '12px',
  display: 'flex',
  gap: '4px',
  zIndex: '9999',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '11px',
})

function applyTheme() {
  const entry = themes[active]!
  const vars = prefersDark() ? entry.dark : entry.light
  const root = document.documentElement

  for (const key of allKeys) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)

  const header = document.querySelector(`.${Html.classNames.header}`)
  if (!header) return

  header.querySelectorAll(`.${Html.classNames.logo.split(' ')[0]!}`).forEach((el) => el.remove())
  if (!entry.logo) return

  const logoSrc =
    typeof entry.logo === 'string' ? entry.logo : prefersDark() ? entry.logo.dark : entry.logo.light

  const img = document.createElement('img')
  img.src = logoSrc
  img.alt = ''
  img.className = Html.classNames.logo
  header.insertBefore(img, header.firstChild)
}

function render() {
  widget.innerHTML = ''
  for (const name of Object.keys(themes)) {
    const button = document.createElement('button')
    button.textContent = name
    Object.assign(button.style, {
      padding: '4px 10px',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      background:
        name === active
          ? prefersDark()
            ? 'rgba(255,255,255,0.2)'
            : 'rgba(0,0,0,0.12)'
          : prefersDark()
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(0,0,0,0.04)',
      color:
        name === active
          ? prefersDark()
            ? '#fff'
            : '#000'
          : prefersDark()
            ? 'rgba(255,255,255,0.5)'
            : 'rgba(0,0,0,0.4)',
    })
    button.onclick = () => {
      active = name
      applyTheme()
      render()
    }
    widget.appendChild(button)
  }
}

mediaQuery.addEventListener('change', () => {
  applyTheme()
  render()
})

render()
document.body.appendChild(widget)
applyTheme()
