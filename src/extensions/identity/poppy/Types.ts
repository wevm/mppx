/** A verified Poppy Session: who is calling, for whom, through which agent. */
export type Session = {
  /** The Personal Agent's `client_id`: the URL of its client metadata document. */
  readonly clientId: string
  /** The pseudonymous User ID the agent assigns this User for this Company. */
  readonly userId: string
  /** The Session ID. */
  readonly sessionId: string
  /** The optional Agent ID, when the Personal Agent runs several agents for the User. */
  readonly agentId?: string | undefined
}

/** An ES256 delegated key that signs Session JWTs, used for one User ID only (spec 5.2). */
export type DelegatedKey = {
  /** The public key as a JWK. */
  readonly jwk: JsonWebKey
  /** The private key that signs each Session JWT. */
  readonly privateKey: CryptoKey
}
