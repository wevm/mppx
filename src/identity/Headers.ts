/**
 * Identity headers as data, lowercased, for code that must handle them without knowing each
 * protocol: the client's redirect stripping and the proxy's header scrubbing.
 */

/**
 * Bearer identity request headers. Anyone holding one can replay it until it expires, so it is
 * never sent across origins on a redirect or forwarded upstream by a proxy. Provers declare
 * their own extra sensitive headers in `Prover.headers`.
 */
export const request = Object.freeze(['identity-attestation'] as const)

/**
 * Identity response headers a proxy must not pass on from upstream: they ask the client for an
 * identity the proxy, not the upstream, decides on.
 */
export const response = Object.freeze([
  'identity-attestation-required',
  'identity-required',
] as const)
