/** Persona KYC values. */
export const Constants = {
  /** Identity type advertised in the 402's `Identity-Required` header. */
  type: 'kyc',
  /** Issuer advertised in the 402's `Identity-Required` header: Persona's API origin. */
  issuer: 'https://api.withpersona.com',
  /** Persona API origin. */
  apiUrl: 'https://api.withpersona.com',
  /** Persona API path for inquiries. */
  inquiriesPath: '/api/v1/inquiries',
  /** Persona API version sent in `Persona-Version` by default. */
  apiVersion: '2023-01-05',
  /** Inquiry statuses accepted by default: approved by your Persona workflow or reviewer. */
  statuses: ['approved'],
  /** Link relation of the onboarding URL sent with a rejection. */
  rel: 'kyc',
  /** Milliseconds before a Persona API call is abandoned as `unavailable`. */
  timeout: 5_000,
  /** Seconds an approval stays cached when a `cache` is set. */
  cacheTtl: 300,
  /** Most inquiry pages read per lookup. */
  maxPages: 3,
} as const
