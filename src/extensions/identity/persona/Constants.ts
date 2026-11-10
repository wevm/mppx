/** Persona KYC values. */
export const Constants = {
  /** Identity type advertised in the 402's `Identity-Required` header. */
  type: 'kyc',
  /** Issuer advertised in the 402's `Identity-Required` header. */
  issuer: 'https://withpersona.com',
  /** Persona API origin. */
  apiUrl: 'https://api.withpersona.com',
  /** Persona API path that lists inquiries. */
  inquiriesPath: '/api/v1/inquiries',
  /** Persona API version the check is written against, sent in `Persona-Version`. */
  apiVersion: '2023-01-05',
  /** Inquiry statuses accepted by default: approved by your Persona workflow or reviewer. */
  statuses: ['approved'],
  /** Milliseconds before a Persona API call is abandoned as `unavailable`. */
  timeout: 5_000,
} as const
