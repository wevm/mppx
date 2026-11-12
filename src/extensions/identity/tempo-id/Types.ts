/** A Tempo ID user, as a verified access token names them. */
export type Caller = {
  /** The Tempo ID user ID: stable across every app on Tempo ID. */
  readonly userId: string
  /** The app the user signed in to. */
  readonly clientId: string
  /** The Tempo Accounts the token grants to the app on the configured chain, lowercased. */
  readonly accounts: readonly `0x${string}`[]
}

/** A verified Tempo ID user and the Tempo Account that paid. */
export type Payer = Caller & {
  /** The account that paid, lowercased. Absent when the check ran without a Credential. */
  readonly account?: `0x${string}` | undefined
}

/** An ES256 DPoP key (RFC 9449), such as the Tempo ID SDK's session key. */
export type DpopKey = {
  /** The public key as a JWK. */
  readonly jwk: JsonWebKey
  /** The private key that signs each proof. */
  readonly privateKey: CryptoKey
}
