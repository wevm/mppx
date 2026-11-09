// The browser client: an mppx client with the identity provers you plug in.
//
// With no provers it pays the anonymous price. Each prover lets it answer the server's
// identity requests, so it can ask for a better tier:
//   - EmailOtp.Client.prover: on 401 Identity-Attestation-Required, gets a code from the
//     issuer, asks you for it, exchanges it for an attestation and resends.
//   - apiKey: a custom prover that adds the member's X-Api-Key header.
import { Mppx, tempo } from 'mppx/client'
import * as EmailOtp from 'mppx/extensions/identity/email-otp'
import type * as Identity from 'mppx/identity'
import type { Account } from 'viem'

export type Options = {
  /** The paying account. */
  account: Account
  /** This app's origin, the only one the provers may answer. */
  origin: string
  /** The email issuer the address may be sent to. */
  issuer: string
  /** Plug in email: the address, and how to ask for the emailed code. */
  email?:
    | {
        address: string
        code: (request: { email: string; id: string }) => Promise<string | undefined>
      }
    | undefined
  /** Plug in a member API key. */
  apiKey?: string | undefined
  /** Fetch used for every HTTP hop, so the page can show them. */
  fetch: typeof globalThis.fetch
}

/** Creates the client and returns a function that buys one fortune. */
export function create(options: Options) {
  const { account, apiKey, email, fetch, issuer, origin } = options
  const identity: Identity.Prover[] = []

  // prover: email
  if (email)
    identity.push(
      EmailOtp.Client.prover({
        email: email.address,
        code: ({ email: address, id }) => email.code({ email: address, id }),
        issuers: [issuer],
        scope: [origin],
        fetch,
      }),
    )

  // prover: member
  if (apiKey) identity.push(memberKey(apiKey, origin))

  const mppx = Mppx.create({
    ...(identity.length > 0 && { identity }),
    methods: [tempo({ account })],
    fetch,
    polyfill: false,
  })

  // Ask for the best tier the plugged-in provers can prove.
  const tier = apiKey ? 'member' : email ? 'email' : undefined
  return () => mppx.fetch(`${origin}/api/fortune${tier ? `?tier=${tier}` : ''}`)
}

/** A prover for the server's own identity system: a member API key in a header. */
function memberKey(key: string, origin: string): Identity.Prover {
  return {
    scope: [origin],
    // A bearer secret: never sent across origins on a redirect.
    headers: ['x-api-key'],
    prove(request) {
      const headers = new Headers(request.headers)
      headers.set('X-Api-Key', key)
      return new Request(request, { headers })
    },
  }
}
