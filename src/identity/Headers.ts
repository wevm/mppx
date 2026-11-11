/**
 * Identity headers as data, lowercased, for code that must handle them without knowing each
 * protocol: the client's redirect stripping and the proxy's header scrubbing.
 */

/**
 * Bearer identity request headers. Anyone holding one can replay it until it expires, so it is
 * never sent across origins on a redirect or forwarded upstream by a proxy. Provers declare
 * their own extra sensitive headers in `Prover.headers`.
 */
export const request = Object.freeze([
  'identity-attestation',
  'identity-presentation',
  // World ID: the session a server issued after World ID approval, and device-flow calls.
  'world-id',
  'world-id-poll',
] as const)

/**
 * `WWW-Authenticate` schemes that ask for an identity, lowercased. A proxy removes them from
 * upstream responses: the proxy, not the upstream, decides which identity the client presents.
 */
export const challenges = Object.freeze(['privatetoken', 'identity-presentation'] as const)

/**
 * Identity response headers a proxy must not pass on from upstream: they ask the client for an
 * identity the proxy, not the upstream, decides on.
 */
export const response = Object.freeze([
  'identity-attestation-required',
  'identity-required',
  // World ID: a request for World ID, and a device attempt or session from the upstream.
  'world-id-required',
  'world-id-device',
] as const)
