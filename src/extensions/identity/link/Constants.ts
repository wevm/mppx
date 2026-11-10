/** Link agent identity values, as Link's Agent Identity SDK and Link CLI use them. */
export const Constants = {
  /** Link's issuer, the only one the Agent Identity SDK trusts. */
  issuer: 'https://api.link.com',
  /** `Authorization` scheme of an Agent Attestation Token (RFC 9577). */
  attestationScheme: 'PrivateToken',
  /** Request header carrying an identity presentation, and its `WWW-Authenticate` scheme. */
  presentationHeader: 'Identity-Presentation',
  /** `type` of the problem body of a claims challenge. */
  claimsRequiredType: 'urn:stripe:link:claims-required',
  /** Presentation format of a claims challenge. */
  format: 'dc+sd-jwt',
  /** Seconds a claims challenge's nonce is accepted for. */
  nonceTtl: 300,
} as const
