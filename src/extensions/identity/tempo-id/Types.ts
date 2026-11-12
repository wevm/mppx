import type { Address } from 'ox'

/** The screening state of a Tempo Account: only `clear` may pay without limits. */
export type ComplianceState = 'clear' | 'exit_only' | 'blocked' | 'pending'

/** A Tempo ID user, as a verified access token (and, when sent, ID token) names them. */
export type Caller = {
  /** The Tempo ID user ID: stable across every app on Tempo ID. */
  readonly userId: string
  /** The app the user signed in to. */
  readonly clientId: string
  /** The Tempo Accounts the token grants to the app on the configured chain, checksummed. */
  readonly accounts: readonly Address.Address[]
  /** The screening state of each account in the app's realms, by checksummed address. Empty for an unregistered app. */
  readonly compliance: Readonly<Record<Address.Address, ComplianceState>>
  /** The user's email address, lowercased, from the ID token. Absent without one, or without the `email` scope. */
  readonly email?: string | undefined
  /** Whether Tempo ID verified the email address. */
  readonly emailVerified?: boolean | undefined
}

/** A verified Tempo ID user and the Tempo Account that paid. */
export type Payer = Caller & {
  /** The account that paid, checksummed. Absent when the check ran without a Credential. */
  readonly account?: Address.Address | undefined
}

/** An ES256 DPoP key (RFC 9449), such as the Tempo ID SDK's session key. */
export type DpopKey = {
  /** The public key as a JWK. */
  readonly jwk: JsonWebKey
  /** The private key that signs each proof. */
  readonly privateKey: CryptoKey
}
