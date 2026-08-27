import { Types as evm_Types } from 'mppx/evm'
import { Proxy } from 'mppx/proxy'
import { evm, Mppx } from 'mppx/server'
import { Header as x402_Header, Types as x402_Types, type PaymentPayload } from 'mppx/x402'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as RouteBinding from '../internal/RouteBinding.js'

const transaction = `0x${'1'.repeat(64)}`
/** Pays. */
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
/** Gets paid. Derived rather than written out so the two are known to differ. */
const recipient = privateKeyToAccount(`0x${'42'.repeat(32)}`).address
const secretKey = 'test-secret-key-test-secret-key-32'

/** Records how far a credential got before settlement. */
function createFacilitator() {
  const reached: string[] = []
  return {
    reached,
    facilitator: {
      async verify() {
        reached.push('verify')
        return { isValid: true }
      },
      async settle(_payload: PaymentPayload, requirements: x402_Types.PaymentRequirements) {
        reached.push('settle')
        return { network: requirements.network, success: true, transaction }
      },
    },
  }
}

function createMppx(options?: { routeBinding?: 'required' | 'resource' | undefined }) {
  const { facilitator, reached } = createFacilitator()
  const mppx = Mppx.create({
    methods: [
      evm({
        currency: evm.assets.baseSepolia.USDC,
        recipient,
        x402: {
          facilitator,
          ...(options?.routeBinding ? { routeBinding: options.routeBinding } : {}),
        },
      }),
    ],
    secretKey,
  })
  return { mppx, reached }
}

function readChallenge(response: Response) {
  return x402_Header.decodePaymentRequired(response.headers.get(x402_Types.paymentRequiredHeader)!)
}

function readError(response: Response) {
  return readChallenge(response).error
}

/**
 * Builds the credential a spec-compliant third-party x402 wallet produces: the
 * advertised `accepted`, `resource`, and optional extensions echoed back, with
 * a nonce of its own choosing. A client mppx did not write cannot compute the
 * unpublished route-bound nonce.
 */
async function thirdPartyCredential(parameters: {
  accepted: x402_Types.PaymentRequirements
  extensions?: x402_Types.Extensions | undefined
  nonce?: `0x${string}` | undefined
  resource?: x402_Types.ResourceInfo | undefined
}): Promise<string> {
  const { accepted } = parameters
  const now = Math.floor(Date.now() / 1000)
  const authorization = {
    from: account.address,
    nonce: parameters.nonce ?? (`0x${'ab'.repeat(32)}` as const),
    to: accepted.payTo as `0x${string}`,
    validAfter: (now - 600).toString(),
    validBefore: (now + accepted.maxTimeoutSeconds).toString(),
    value: accepted.amount,
  }

  const signature = await account.signTypedData({
    domain: evm_Types.authorizationDomain({
      authorization: {
        name: accepted.extra!.name as string,
        version: accepted.extra!.version as string,
      },
      chainId: Number(accepted.network.slice('eip155:'.length)),
      currency: accepted.asset as `0x${string}`,
    }),
    message: {
      from: authorization.from,
      nonce: authorization.nonce,
      to: authorization.to,
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      value: BigInt(authorization.value),
    },
    primaryType: 'TransferWithAuthorization',
    types: evm_Types.authorizationTypes,
  })

  return x402_Header.encodePaymentSignature({
    accepted,
    ...(parameters.extensions ? { extensions: parameters.extensions } : {}),
    payload: { authorization, signature },
    ...(parameters.resource ? { resource: parameters.resource } : {}),
    x402Version: 2,
  })
}

function routeBoundExtensions(
  extensions: x402_Types.Extensions,
  info?: Record<string, unknown> | undefined,
): x402_Types.Extensions {
  const mppx = extensions.mppx!
  return {
    ...extensions,
    mppx: {
      ...mppx,
      info: { ...mppx.info, nonce: 'client-salt', ...info },
    },
  }
}

async function routeBoundCredential(parameters: {
  accepted: x402_Types.PaymentRequirements
  extensions: x402_Types.Extensions
  resource: x402_Types.ResourceInfo
}): Promise<string> {
  return thirdPartyCredential({
    ...parameters,
    nonce: RouteBinding.nonce(parameters),
  })
}

function request(url: string, credential?: string) {
  return new Request(url, {
    ...(credential ? { headers: { [x402_Types.paymentSignatureHeader]: credential } } : {}),
  })
}

describe('x402 evm charge route binding', () => {
  const url = 'https://example.com/paid-scoped'
  const scope = 'GET /paid-scoped'

  test('a scoped charge accepts a standard extension echo without a bound nonce', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    expect(challenged.status).toBe(402)
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    // The challenge still advertises the binding mppx prefers, so an mppx client
    // keeps producing it. Not producing it is no longer fatal.
    expect(challenge.extensions?.mppx?.info).toMatchObject({
      _mppx_scope: scope,
      method: 'GET',
    })
    expect(challenge.extensions?.mppx?.info.nonce).toBeUndefined()

    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          extensions: challenge.extensions,
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
  })

  test('a scoped charge still requires the resource to be echoed', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(url, await thirdPartyCredential({ accepted: challenge.accepts[0]! })),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(readError(result.challenge)).toBe(
      'Payment verification failed: x402 payment payload resource does not match route resource.',
    )
    expect(reached).toEqual([])
  })

  test('a scoped charge accepts an enriched echoed resource', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    // Only the URL is load-bearing. A client that round-trips the resource with
    // descriptive fields filled in has still bound the route, so rejecting it
    // would cost interop and buy nothing.
    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: { ...challenge.resource, description: 'A paid route.' },
        }),
      ),
    )

    expect(result.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
  })

  test('a scoped charge rejects a credential minted for another route', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })
    const other = mppx.evm.charge({ amount: '0.25', scope: 'GET /other' })

    const challenged = await other(request('https://example.com/other'))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    // Same price, same rail, different route: the echoed resource is what makes
    // this distinguishable, so the credential does not travel.
    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          extensions: challenge.extensions,
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test('a scoped charge rejects altered payment requirements', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: { ...challenge.accepts[0]!, amount: '1' },
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test('an unscoped charge is payable by a third-party client', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25' })

    const challenged = await route(request('https://example.com/paid'))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(
        'https://example.com/paid',
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
  })

  test('an unscoped charge rejects an unrelated resource', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25' })

    const challenged = await route(request('https://example.com/paid'))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(
        'https://example.com/paid',
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: { ...challenge.resource, url: 'https://example.com/other' },
        }),
      ),
    )

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test('a credential claiming mppx binding is still verified in full', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    // `extensions.mppx.info.nonce` present means the client claims to have bound
    // the route into the EIP-3009 nonce. That claim is checked against the
    // derivation, so a wrong nonce is rejected rather than downgraded.
    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          extensions: {
            mppx: {
              ...challenge.extensions!.mppx!,
              info: { ...challenge.extensions!.mppx!.info, nonce: 'client-salt' },
            },
          },
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test('a valid mppx-bound credential remains payable', async () => {
    const { mppx, reached } = createMppx({ routeBinding: 'required' })
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)
    const parameters = {
      accepted: challenge.accepts[0]!,
      extensions: routeBoundExtensions(challenge.extensions!),
      resource: challenge.resource,
    }

    const result = await route(request(url, await routeBoundCredential(parameters)))

    expect(result.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
  })

  test('a bound credential rejects a mismatched resource', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)
    const parameters = {
      accepted: challenge.accepts[0]!,
      extensions: routeBoundExtensions(challenge.extensions!),
      resource: { ...challenge.resource, url: 'https://example.com/other' },
    }

    const result = await route(request(url, await routeBoundCredential(parameters)))

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test('a bound credential rejects altered route extensions', async () => {
    const { mppx, reached } = createMppx()
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)
    const parameters = {
      accepted: challenge.accepts[0]!,
      extensions: routeBoundExtensions(challenge.extensions!, { _mppx_scope: 'GET /other' }),
      resource: challenge.resource,
    }

    const result = await route(request(url, await routeBoundCredential(parameters)))

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test("`routeBinding: 'required'` keeps a scoped charge mppx-only", async () => {
    const { mppx, reached } = createMppx({ routeBinding: 'required' })
    const route = mppx.evm.charge({ amount: '0.25', scope })

    const challenged = await route(request(url))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(
        url,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(402)
    expect(reached).toEqual([])
  })

  test("`routeBinding: 'required'` leaves an unscoped charge payable", async () => {
    const { mppx, reached } = createMppx({ routeBinding: 'required' })
    const route = mppx.evm.charge({ amount: '0.25' })

    const challenged = await route(request('https://example.com/paid'))
    if (challenged.status !== 402) throw new Error()
    const challenge = readChallenge(challenged.challenge)

    const result = await route(
      request(
        'https://example.com/paid',
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: challenge.resource,
        }),
      ),
    )

    expect(result.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
  })
})

/**
 * `Proxy` attaches a derived scope to every charge it serves, so before this it
 * put each proxied route into the mppx-only binding mode with no way to opt out.
 * Reselling an API is what `Proxy` is for, so this is the case that has to work
 * without configuring anything.
 */
describe('x402 evm charge behind Proxy', () => {
  const origin = 'https://example.com'
  const basePath = '/__proxy'
  const serviceId = 'local_free'
  const proxyUrl = `${origin}${basePath}/${serviceId}/free`

  function createProxy() {
    const { mppx, reached } = createMppx()
    const proxy = Proxy.create({
      basePath,
      async fetch() {
        return Response.json({ free: true })
      },
      services: [
        {
          id: serviceId,
          baseUrl: origin,
          routes: { 'GET /free': mppx.charge({ amount: '0.25' }) },
        },
      ],
    })
    return { proxy, reached }
  }

  test('is payable by a third-party client with no configuration', async () => {
    const { proxy, reached } = createProxy()

    const challenged = await proxy.fetch(request(proxyUrl))
    expect(challenged.status).toBe(402)
    const challenge = readChallenge(challenged)

    // No `scope` is set anywhere; `Proxy` derived one, and the challenge carries
    // it as route metadata.
    expect(challenge.extensions?.mppx?.info).toMatchObject({
      _mppx_scope: `GET ${basePath}/${serviceId}/free`,
      method: 'GET',
    })

    const response = await proxy.fetch(
      request(
        proxyUrl,
        await thirdPartyCredential({
          accepted: challenge.accepts[0]!,
          resource: challenge.resource,
        }),
      ),
    )

    expect(response.status).toBe(200)
    expect(reached).toEqual(['verify', 'settle'])
    expect(response.headers.get(x402_Types.paymentResponseHeader)).toBeTruthy()
  })
})
