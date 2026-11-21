export const ids = {
  data: '__MPPX_DATA__',
  error: 'root_error',
  root: 'root',
} as const

export const params = {
  serviceWorker: '__mppx_worker',
  tab: '__mppx_tab',
} as const

export const attrs = {
  challengeId: 'data-mppx-challenge-id',
  remaining: 'data-remaining',
} as const

export const classNames = {
  error: 'mppx-error',
  header: 'mppx-header',
  logo: 'mppx-logo',
  summary: 'mppx-summary',
  summaryAmount: 'mppx-summary-amount',
  summaryDescription: 'mppx-summary-description',
  summaryExpires: 'mppx-summary-expires',
  tab: 'mppx-tab',
  tabList: 'mppx-tablist',
  tabPanel: 'mppx-tabpanel',
} as const
