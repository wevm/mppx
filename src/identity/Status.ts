import type * as Types from './Types.js'

/** The HTTP status code of each rejected identity status. */
export const codes = {
  missing: 401,
  invalid: 401,
  forbidden: 403,
  unavailable: 503,
} as const satisfies Record<Types.RejectionStatus, number>

/**
 * Rejected statuses from highest to lowest precedence. When several verifiers reject (or
 * every `anyOf` member does), the outcome with the highest precedence decides the status
 * and reason.
 */
export const precedence = [
  'forbidden',
  'unavailable',
  'invalid',
  'missing',
] as const satisfies readonly Types.RejectionStatus[]
