/**
 * Identity headers as data, lowercased, for code that must handle them without knowing each
 * protocol: the client's redirect stripping and the proxy's header scrubbing.
 */

/**
 * Bearer identity request headers mppx itself defines, never sent across origins on a redirect or
 * forwarded upstream by a proxy. None today: each identity protocol declares its own, in
 * `Prover.headers` on the client and `headers` on its verifier or payment check on the server.
 */
export const request: readonly string[] = Object.freeze([])

/**
 * `WWW-Authenticate` schemes that ask for an identity, lowercased. A proxy removes them from
 * upstream responses: the proxy, not the upstream, decides which identity the client presents.
 */
export const challenges = Object.freeze(['privatetoken', 'identity-presentation'] as const)

/**
 * Identity response headers mppx itself defines, which a proxy must not pass on from upstream:
 * they ask the client for an identity the proxy, not the upstream, decides on. Each identity
 * protocol declares its own in `headers` on its verifier or payment check.
 */
export const response = Object.freeze(['identity-required'] as const)
