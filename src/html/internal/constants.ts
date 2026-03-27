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
