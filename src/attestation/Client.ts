import * as SigningContext from './internal/SigningContext.js'
import type * as Types from './Types.js'

/**
 * Combines request signers using one shared context per call.
 *
 * The returned signer creates a fresh context unless its caller supplies one,
 * allowing every signature on one HTTP attempt to share a nonce and timestamp.
 */
export function composeSigners(
  ...signers: readonly [Types.Signer, ...Types.Signer[]]
): Types.Signer<'composed'> {
  return {
    protocol: 'composed',
    async sign(request, context = SigningContext.create()) {
      for (const signer of signers) request = await signer.sign(request, context)
      return request
    },
  }
}

/**
 * Wraps a fetch implementation so every outbound request is attested.
 *
 * Configure this wrapper as the underlying `fetch` passed to `mppx/client`
 * `Fetch.from()`. MPPX then uses it for both the initial request and its
 * automatic request containing an `Authorization: Payment` credential.
 */
export function wrapFetch(
  fetch: typeof globalThis.fetch,
  signer: Types.Signer,
): typeof globalThis.fetch {
  return async (input, init) => fetch(await signer.sign(new Request(input, init)))
}
