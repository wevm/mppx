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

/** Reserved query params used for route-local HTML infrastructure requests. */
export const support = {
  kind: '__mppx',
  action: 'action',
  actionName: 'name',
  method: 'method',
  serviceWorker: 'sw',
} as const

function cloneUrl(url: URL | string): URL {
  return typeof url === 'string' ? new URL(url, 'http://localhost') : new URL(url)
}

export function supportRequestUrl(parameters: {
  kind: 'action' | 'sw'
  name?: string | undefined
  method?: string | undefined
  url: URL | string
}): string {
  const { kind, name, method, url } = parameters
  const next = cloneUrl(url)
  next.hash = ''
  next.searchParams.set(support.kind, kind)
  if (kind === support.action && name) next.searchParams.set(support.actionName, name)
  else next.searchParams.delete(support.actionName)
  if (kind === support.action && method) next.searchParams.set(support.method, method)
  else next.searchParams.delete(support.method)
  return `${next.pathname}${next.search}`
}
