import type * as Challenge from '../../Challenge.js'

/**
 * Refuses an automatic zero-amount Tempo proof whose realm is neither the hostname of the
 * server being contacted nor one of `trustedRealms`, so a foreign origin cannot relay it.
 */
export function assert(
  challenge: Challenge.Challenge,
  url: URL,
  trustedRealms: readonly string[] | undefined,
): void {
  if (challenge.method !== 'tempo' || challenge.intent !== 'charge') return
  const amount = challenge.request.amount
  if (typeof amount !== 'string') return
  try {
    if (BigInt(amount) !== 0n) return
  } catch {
    return
  }

  const realm = challenge.realm.toLowerCase()
  if (realm === url.hostname.toLowerCase()) return
  if (trustedRealms?.some((trusted) => trusted.toLowerCase() === realm)) return
  throw new Error(
    `Refusing to sign Tempo proof for realm ${JSON.stringify(challenge.realm)} from ${url.origin}. Add the realm to \`trustedRealms\` if this server is expected to issue it.`,
  )
}
