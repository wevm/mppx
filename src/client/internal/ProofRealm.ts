import type * as Challenge from '../../Challenge.js'

/**
 * Pins that let a server origin request zero-amount Tempo proofs for a realm other than its
 * hostname, keyed by origin (`scheme://host[:port]`), such as
 * `{ 'https://api.example.com': 'MPP Payment' }`.
 */
export type TrustedRealms = Readonly<Record<string, string>>

/**
 * Refuses a zero-amount Tempo proof whose realm the HTTP server that sent the Challenge does not
 * own. A proof authenticates the payer at the Challenge realm, so a foreign origin could otherwise
 * relay another server's Challenge and replay the signed proof there. The server owns the realm
 * when it is the request hostname, or when `trustedRealms` pins it to the request origin.
 */
export function assert(
  challenge: Challenge.Challenge,
  url: URL,
  trustedRealms: TrustedRealms | undefined,
): void {
  if (!isProof(challenge)) return
  const { realm } = challenge
  if (realm.toLowerCase() === url.hostname.toLowerCase()) return
  const origin = url.origin.toLowerCase()
  for (const [trustedOrigin, trustedRealm] of Object.entries(trustedRealms ?? {}))
    if (trustedRealm === realm && normalizeOrigin(trustedOrigin) === origin) return
  throw new Error(
    `Refusing to sign Tempo proof for realm ${JSON.stringify(realm)} from ${url.origin}. Pin the realm to this origin with \`trustedTempoProofRealms\` if this server is expected to issue it.`,
  )
}

/**
 * Refuses a zero-amount Tempo proof on a transport without an origin, such as MCP, unless
 * `trustedRealms` lists its realm.
 */
export function assertWithoutOrigin(
  challenge: Challenge.Challenge,
  trustedRealms: readonly string[] | undefined,
): void {
  if (!isProof(challenge)) return
  if (trustedRealms?.includes(challenge.realm)) return
  throw new Error(
    `Refusing to sign Tempo proof for untrusted realm ${JSON.stringify(challenge.realm)}. Add it to \`trustedTempoProofRealms\` if this server is expected to issue it.`,
  )
}

/**
 * Whether `challenge` is a zero-amount `tempo/charge` Challenge, paid with a signed proof. Uses the
 * same `BigInt` conversion as the Tempo charge client, so every encoding it signs a proof for
 * (such as `"0x0"` or `" 0 "`) is checked.
 */
function isProof(challenge: Challenge.Challenge): boolean {
  if (challenge.method !== 'tempo' || challenge.intent !== 'charge') return false
  const amount: unknown = challenge.request.amount
  if (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint')
    return false
  try {
    return BigInt(amount) === 0n
  } catch {
    return false
  }
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase()
  } catch {
    return origin.toLowerCase()
  }
}
