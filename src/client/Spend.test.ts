import { Challenge, Credential, Errors, Method, Receipt } from 'mppx'
import { Budget, evm, Fetch, Mppx, sessionManager, Spend } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { Header as x402_Header, Types as x402_Types, type PaymentRequired } from 'mppx/x402'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { usdc } from 'viem/tokens'
import { afterEach, describe, expect, test, vi } from 'vp/test'

const realm = 'api.example.com'
const url = 'https://api.example.com/resource'
const pathUsd = '0x20c0000000000000000000000000000000000000'
const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const unknownToken = '0x1111111111111111111111111111111111111111'
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const transaction = `0x${'ab'.repeat(32)}`
const networkId = 'profile_merchant'

afterEach(() => {
  Mppx.restore()
  vi.unstubAllGlobals()
})

function method(name: string, steps: string[] = [], intent = 'charge') {
  const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) => {
    steps.push('sign')
    return Credential.serialize({ challenge, payload: { signature: '0xsignature' } })
  })
  return {
    createCredential,
    method: Method.toClient(Method.from({ name, intent, schema: Methods.charge.schema }), {
      createCredential,
    }),
  }
}

function challenge(name: string, request: Record<string, unknown>, id = 'paid') {
  return Challenge.from({ id, intent: 'charge', method: name, realm, request })
}

function tempoChallenge(amount: string, currency = pathUsd, id = 'paid') {
  return challenge('tempo', { amount, currency, recipient, methodDetails: { chainId: 4217 } }, id)
}

function stripeChallenge(amount: string, request: Record<string, unknown> = {}) {
  return challenge('stripe', {
    amount,
    currency: 'usd',
    recipient,
    methodDetails: { networkId },
    ...request,
  })
}

function paymentRequired(...challenges: Challenge.Challenge[]) {
  return new Response(null, {
    headers: { 'WWW-Authenticate': challenges.map(Challenge.serialize).join(', ') },
    status: 402,
  })
}

/** A server that asks for \`offer\` until a request carries a credential, then returns a receipt. */
function server(offer: () => Response, headers: Record<string, string> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const paid =
      request.headers.get('Authorization')?.startsWith('Payment ') ||
      request.headers.has(x402_Types.paymentSignatureHeader)
    if (!paid) return offer()
    return new Response('OK', { headers, status: 200 })
  })
}

function receiptHeader() {
  return Receipt.serialize(
    Receipt.from({
      method: 'tempo',
      reference: transaction,
      status: 'success',
      timestamp: new Date().toISOString(),
    }),
  )
}

function x402Response(
  amount: string,
  network: `eip155:${number}` = 'eip155:8453',
  asset = baseUsdc,
) {
  const required = {
    accepts: [
      {
        amount,
        asset,
        maxTimeoutSeconds: 60,
        network,
        payTo: recipient,
        scheme: x402_Types.schemes[0],
      },
    ],
    resource: { url },
    x402Version: 2,
  } satisfies PaymentRequired
  return new Response(null, {
    headers: { 'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(required) },
    status: 402,
  })
}

function create(fetch: typeof globalThis.fetch, methods: Mppx.Methods, config = {}) {
  return Mppx.create({ fetch, methods, polyfill: false, ...config })
}

describe('maxPayment', () => {
  test('default: without spending options, unknown assets pay as before', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('5000000000', unknownToken)))
    const mppx = create(fetch as never, [tempo])

    const response = await mppx.fetch(url)

    expect(response.status).toBe(200)
    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('behavior: allows a Tempo payment within a USD limit', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('1500000')))
    const mppx = create(fetch as never, [tempo], {
      maxPayment: { value: '1.5', currency: 'usd' },
    })

    expect((await mppx.fetch(url)).status).toBe(200)
    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('error: refuses a Tempo payment over a USD limit before signing', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('1500001')))
    const mppx = create(fetch as never, [tempo], {
      maxPayment: { value: '1.5', currency: 'USD' },
    })

    const error = await mppx.fetch(url).catch((error) => error)

    expect(error).toBeInstanceOf(Errors.PaymentLimitExceededError)
    expect(error).toMatchObject({ limit: 'maxPayment', reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('error: fails closed for a USD limit on a token the client does not configure', async () => {
    const { createCredential, method: tempo } = method('tempo')
    // The server's own currency and decimals claims are never trusted.
    const fetch = server(() =>
      paymentRequired(
        challenge('tempo', {
          amount: '1',
          currency: unknownToken,
          currencyCode: 'USD',
          decimals: 6,
          methodDetails: { chainId: 4217, decimals: 6 },
        }),
      ),
    )
    const mppx = create(fetch as never, [tempo], {
      maxPayment: { value: '100', currency: 'USD' },
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({
      name: 'PaymentLimitExceededError',
      reason: 'asset',
    })
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('error: server decimals cannot shrink an EVM payment', async () => {
    const { createCredential, method: evm } = method('evm')
    for (const decimals of [0, 18]) {
      const fetch = server(() =>
        paymentRequired(
          challenge('evm', {
            amount: '5000000',
            currency: baseUsdc,
            methodDetails: { chainId: 8453, decimals },
            recipient,
          }),
        ),
      )
      const mppx = create(fetch as never, [evm], {
        maxPayment: { value: '1', currency: 'USD' },
        tokens: [usdc],
      })

      await expect(mppx.fetch(url)).rejects.toMatchObject({ reason: 'amount' })
    }
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('behavior: a configured token prices an EVM payment', async () => {
    const { createCredential, method: evm } = method('evm')
    const fetch = server(() =>
      paymentRequired(
        challenge('evm', {
          amount: '990000',
          currency: baseUsdc.toLowerCase(),
          methodDetails: { chainId: 8453, decimals: 18 },
          recipient,
        }),
      ),
    )
    const mppx = create(fetch as never, [evm], {
      maxPayment: { value: '1', currency: 'USD' },
      tokens: [{ address: baseUsdc, chainId: 8453, currency: 'USD', decimals: 6 }],
    })

    expect((await mppx.fetch(url)).status).toBe(200)
    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('behavior: per-asset limits compare atomic amounts for Stripe', async () => {
    const { createCredential, method: stripe } = method('stripe')
    const offer = (amount: string) => () => paymentRequired(stripeChallenge(amount))
    const maxPayment = [{ network: 'stripe', asset: 'USD', amount: 500n }] as const

    expect(
      (await create(server(offer('500')) as never, [stripe], { maxPayment }).fetch(url)).status,
    ).toBe(200)
    await expect(
      create(server(offer('501')) as never, [stripe], { maxPayment }).fetch(url),
    ).rejects.toMatchObject({ reason: 'amount' })
    await expect(
      create(server(offer('1')) as never, [stripe], {
        maxPayment: [{ network: 'stripe', asset: 'eur', amount: 500n }],
      }).fetch(url),
    ).rejects.toMatchObject({ reason: 'asset' })
    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('behavior: Stripe USD charges count against a USD limit in cents', async () => {
    const { method: stripe } = method('stripe')
    const offer = (amount: string) => () =>
      paymentRequired(stripeChallenge(amount, { decimals: 6 }))
    const maxPayment = { value: '5', currency: 'USD' }

    expect(
      (await create(server(offer('500')) as never, [stripe], { maxPayment }).fetch(url)).status,
    ).toBe(200)
    await expect(
      create(server(offer('501')) as never, [stripe], { maxPayment }).fetch(url),
    ).rejects.toMatchObject({ reason: 'amount' })
  })

  test('behavior: limits x402 payments by asset and by configured token', async () => {
    const { createCredential, method: evm } = method(x402_Types.paymentMethod)
    const asset = { network: 'eip155:8453', asset: baseUsdc.toLowerCase(), amount: 1000n }

    expect(
      (
        await create(server(() => x402Response('1000')) as never, [evm], {
          maxPayment: [asset],
        }).fetch(url)
      ).status,
    ).toBe(200)
    await expect(
      create(server(() => x402Response('1001')) as never, [evm], {
        maxPayment: [asset],
      }).fetch(url),
    ).rejects.toMatchObject({ reason: 'amount' })
    await expect(
      create(server(() => x402Response('2000000')) as never, [evm], {
        maxPayment: { value: '1', currency: 'USD' },
        tokens: [usdc(8453)],
      }).fetch(url),
    ).rejects.toMatchObject({ reason: 'amount' })
    await expect(
      create(server(() => x402Response('1')) as never, [evm], {
        maxPayment: { value: '1', currency: 'USD' },
      }).fetch(url),
    ).rejects.toMatchObject({ reason: 'asset' })
    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('error: checks a credential onChallenge made itself before sending it', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('2000000')))
    const mppx = create(fetch as never, [tempo], {
      maxPayment: { value: '1', currency: 'USD' },
      onChallenge: async (challenge: Challenge.Challenge) =>
        Credential.serialize({ challenge, payload: { signature: '0xother' } }),
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({ reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('error: a top-level chainId the signer ignores cannot satisfy a chain limit', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fund = vi.fn(async () => {})
    // Tempo signs on `methodDetails.chainId` or its own configured chain, never this field.
    const offer = () =>
      paymentRequired(
        challenge('tempo', { amount: '1', chainId: 42431, currency: pathUsd, recipient }),
      )
    const testnet = { network: 'eip155:42431', asset: pathUsd, amount: 10n }

    for (const config of [
      { maxPayment: [testnet] },
      { authorize: Budget.create({ total: testnet }) },
      { funders: [{ fund }] },
    ])
      await expect(create(server(offer) as never, [tempo], config).fetch(url)).rejects.toThrow(
        'Cannot check spending limits',
      )
    expect(fund).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()

    // Without spending options, the payment runs as before.
    expect((await create(server(offer) as never, [tempo]).fetch(url)).status).toBe(200)
    // A top-level chainId that matches `methodDetails.chainId` names the same chain.
    expect(
      (
        await create(
          server(() =>
            paymentRequired(
              challenge('tempo', {
                amount: '1',
                chainId: 42431,
                currency: pathUsd,
                methodDetails: { chainId: 42431 },
                recipient,
              }),
            ),
          ) as never,
          [tempo],
          { maxPayment: [testnet] },
        ).fetch(url)
      ).status,
    ).toBe(200)
  })

  test('error: createCredential and prepared payments enforce maxPayment', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const mppx = create(vi.fn() as never, [tempo], {
      maxPayment: { value: '1', currency: 'USD' },
    })

    await expect(
      mppx.createCredential(paymentRequired(tempoChallenge('2000000'))),
    ).rejects.toBeInstanceOf(Errors.PaymentLimitExceededError)
    const prepared = await mppx.preparePayment(paymentRequired(tempoChallenge('2000000')))
    await expect(prepared.createCredential()).rejects.toMatchObject({ reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
    expect(await mppx.createCredential(paymentRequired(tempoChallenge('1000000')))).toMatch(
      /^Payment /,
    )
  })

  test('behavior: Fetch.from enforces maxPayment', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = Fetch.from({
      fetch: server(() => paymentRequired(tempoChallenge('2000000'))) as never,
      maxPayment: { value: '1', currency: 'USD' },
      methods: [tempo],
    })

    await expect(fetch(url)).rejects.toMatchObject({ reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('behavior: the polyfilled global fetch enforces maxPayment', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const upstream = server(() => paymentRequired(tempoChallenge('2000000')))
    vi.stubGlobal('fetch', upstream)
    Mppx.create({ maxPayment: { value: '1', currency: 'USD' }, methods: [tempo] })

    expect(globalThis.fetch).not.toBe(upstream)
    await expect(globalThis.fetch(url)).rejects.toMatchObject({ reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  test('error: rejects invalid options at creation', () => {
    const { method: tempo } = method('tempo')
    for (const config of [
      { maxPayment: { value: '-1', currency: 'USD' } },
      { maxPayment: { value: '1', currency: '' } },
      { maxPayment: [{ network: 'stripe', asset: 'usd', amount: 1 }] },
      {
        maxPayment: [
          { network: 'eip155:1', asset: baseUsdc, amount: 1n },
          { network: 'eip155:1', asset: baseUsdc.toLowerCase(), amount: 2n },
        ],
      },
      { tokens: [{ address: baseUsdc, chainId: 8453, decimals: 6 }] },
      { funders: [{}] },
    ])
      expect(() => create(vi.fn() as never, [tempo], config)).toThrow(TypeError)
  })
})

describe('authorize', () => {
  test('behavior: concurrent payments cannot overspend a budget', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const budget = Budget.create({ total: { value: '1.5', currency: 'USD' } })
    const fetch = server(() => paymentRequired(tempoChallenge('1000000')))
    const mppx = create(fetch as never, [tempo], { authorize: budget })

    const results = await Promise.allSettled([mppx.fetch(url), mppx.fetch(url)])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((result) => result.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      limit: 'budget',
      reason: 'amount',
    })
    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(budget.spent()).toEqual({ value: '1', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
    expect(budget.remaining()).toEqual({ value: '0.5', currency: 'USD' })
  })

  test('behavior: commits a created credential and releases a failed one', async () => {
    const steps: string[] = []
    const authorize = vi.fn(() => ({
      commit: () => steps.push('commit'),
      release: () => steps.push('release'),
    }))
    const failing = Method.toClient(
      Method.from({ name: 'tempo', intent: 'charge', schema: Methods.charge.schema }),
      {
        async createCredential() {
          throw new Error('signing failed')
        },
      },
    )
    const offer = () => paymentRequired(tempoChallenge('1'))

    await expect(
      create(server(offer) as never, [failing], { authorize }).fetch(url),
    ).rejects.toThrow('signing failed')
    expect(steps).toEqual(['release'])

    steps.length = 0
    const { method: tempo } = method('tempo', steps)
    await create(server(offer) as never, [tempo], { authorize }).fetch(url)
    expect(steps).toEqual(['sign', 'commit'])
    const [plan, context] = authorize.mock.calls[1] as unknown as [Spend.Plan, Spend.Context]
    expect(plan.requirement).toMatchObject({
      amount: 1n,
      asset: pathUsd,
      currency: 'USD',
      decimals: 6,
      intent: 'charge',
      method: 'tempo',
      network: 'eip155:4217',
      protocol: 'mpp',
      recipient,
    })
    expect(context.challenge.id).toBe('paid')
  })

  test('behavior: a budget refuses assets it cannot count and plans it did not get from mppx', async () => {
    const { method: tempo } = method('tempo')
    const budget = Budget.create({
      total: { network: 'eip155:4217', asset: pathUsd, amount: 10n },
    })
    const offer = (currency: string) => () => paymentRequired(tempoChallenge('4', currency))

    await create(server(offer(pathUsd)) as never, [tempo], { authorize: budget }).fetch(url)
    await expect(
      create(server(offer(unknownToken)) as never, [tempo], { authorize: budget }).fetch(url),
    ).rejects.toMatchObject({ limit: 'budget', reason: 'asset' })
    expect(budget.remaining()).toEqual({ network: 'eip155:4217', asset: pathUsd, amount: 6n })

    const usd = Budget.create({ total: { value: '1', currency: 'USD' } })
    await expect(
      create(server(offer(unknownToken)) as never, [tempo], { authorize: usd }).fetch(url),
    ).rejects.toMatchObject({ limit: 'budget', reason: 'asset' })
    expect(() =>
      usd({
        requirement: {
          amount: 1n,
          asset: unknownToken,
          currency: 'USD',
          decimals: 18,
          intent: 'charge',
          method: 'tempo',
          network: 'eip155:4217',
          protocol: 'mpp',
        },
      }),
    ).toThrow(TypeError)
    expect(usd.total).toEqual({ value: '1', currency: 'USD' })
  })
  test('behavior: prepared payments count each credential once', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const fetch = server(() => paymentRequired(tempoChallenge('300000')))
    const mppx = create(fetch as never, [tempo], { authorize: budget })

    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    expect((await prepared.payment.pay()).status).toBe(200)
    expect(budget.spent()).toEqual({ value: '0.3', currency: 'USD' })

    // A credential a handler makes itself is counted instead of mppx's own.
    const unsubscribe = mppx.onChallengeReceived(async ({ challenge }) =>
      Credential.serialize({ challenge, payload: { signature: '0xother' } }),
    )
    const substituted = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    expect((await substituted.payment.pay()).status).toBe(200)
    unsubscribe()
    expect(budget.spent()).toEqual({ value: '0.6', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
    expect(createCredential).toHaveBeenCalledTimes(1)

    await expect(
      mppx.createCredential(paymentRequired(tempoChallenge('500000'))),
    ).rejects.toMatchObject({ limit: 'budget', reason: 'amount' })
    expect(budget.remaining()).toEqual({ value: '0.4', currency: 'USD' })
  })
})

describe('Budget', () => {
  test('behavior: reservations settle at the scale the budget has when they settle', async () => {
    const { method: stripe } = method('stripe')
    const { method: tempo } = method('tempo')
    const usd = { value: '5', currency: 'USD' }
    /** Reserves $1 in Stripe cents, then $1 in a six-decimal token, which raises the scale. */
    async function reserve(budget: Budget.Budget) {
      const authorizations: Spend.Authorization[] = []
      // Returns nothing, so mppx leaves settling them to the test.
      const authorize = (plan: Spend.Plan) => void authorizations.push(budget(plan))
      const mppx = create(vi.fn() as never, [stripe, tempo], { authorize })
      await mppx.createCredential(paymentRequired(stripeChallenge('100')))
      await mppx.createCredential(paymentRequired(tempoChallenge('1000000')))
      expect(budget.reserved()).toEqual({ value: '2', currency: 'USD' })
      return authorizations as [Spend.Authorization, Spend.Authorization]
    }

    const released = Budget.create({ total: usd })
    for (const authorization of await reserve(released)) authorization.release()
    expect(released.remaining()).toEqual(usd)
    expect(released.reserved()).toEqual({ value: '0', currency: 'USD' })

    const mixed = Budget.create({ total: usd })
    const [cents, micros] = await reserve(mixed)
    cents.release()
    micros.commit()
    expect(mixed.remaining()).toEqual({ value: '4', currency: 'USD' })
    expect(mixed.spent()).toEqual({ value: '1', currency: 'USD' })
    expect(mixed.reserved()).toEqual({ value: '0', currency: 'USD' })
  })
})

describe('funders', () => {
  test('behavior: run once when a handler supplies the credential for a prepared request', async () => {
    const fund = vi.fn(async () => {})
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('300000')))
    const mppx = create(fetch as never, [tempo], { authorize: budget, funders: [{ fund }] })
    mppx.onChallengeReceived(async ({ challenge }) =>
      Credential.serialize({ challenge, payload: { signature: '0xother' } }),
    )

    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    expect((await prepared.payment.pay()).status).toBe(200)

    expect(fund).toHaveBeenCalledTimes(1)
    expect(createCredential).not.toHaveBeenCalled()
    expect(budget.spent()).toEqual({ value: '0.3', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
  })

  test('behavior: run once when a handler replaces a credential mppx failed to create', async () => {
    const fund = vi.fn(async () => {})
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const failing = Method.toClient(
      Method.from({ name: 'tempo', intent: 'charge', schema: Methods.charge.schema }),
      {
        async createCredential() {
          throw new Error('signing failed')
        },
      },
    )
    const fetch = server(() => paymentRequired(tempoChallenge('300000')))
    const mppx = create(fetch as never, [failing], { authorize: budget, funders: [{ fund }] })
    mppx.onChallengeReceived(async ({ challenge, createCredential }) => {
      await expect(createCredential()).rejects.toThrow('signing failed')
      return Credential.serialize({ challenge, payload: { signature: '0xother' } })
    })

    expect((await mppx.fetch(url)).status).toBe(200)
    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    expect((await prepared.payment.pay()).status).toBe(200)

    expect(fund).toHaveBeenCalledTimes(2)
    expect(budget.spent()).toEqual({ value: '0.6', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
  })

  test('behavior: run in order after authorize and before signing', async () => {
    const steps: string[] = []
    const { method: tempo } = method('tempo', steps)
    const mppx = create(server(() => paymentRequired(tempoChallenge('1'))) as never, [tempo], {
      authorize: () => {
        steps.push('authorize')
        return { commit: () => steps.push('commit'), release: () => steps.push('release') }
      },
      funders: [
        { fund: async () => void steps.push('fund:1') },
        {
          fund: async (requirement: Spend.Requirement) =>
            void steps.push(`fund:2:${requirement.amount}`),
        },
      ],
    })

    await mppx.fetch(url)

    expect(steps).toEqual(['authorize', 'fund:1', 'fund:2:1', 'sign', 'commit'])
  })

  test('error: a failing funder releases the authorization and stops signing', async () => {
    const steps: string[] = []
    const { createCredential, method: tempo } = method('tempo', steps)
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const later = vi.fn(async () => {})
    const mppx = create(server(() => paymentRequired(tempoChallenge('1'))) as never, [tempo], {
      authorize: budget,
      funders: [
        {
          fund: async () => {
            throw new Error('swap failed')
          },
        },
        { fund: later },
      ],
    })

    await expect(mppx.fetch(url)).rejects.toThrow('swap failed')
    expect(createCredential).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
    expect(budget.remaining()).toEqual({ value: '1', currency: 'USD' })
  })
})

describe('replacement credentials', () => {
  /** A server offering a cheap and a pricey payment, the cheap one first. */
  const offers = () =>
    paymentRequired(
      tempoChallenge('1000000', pathUsd, 'cheap'),
      tempoChallenge('2000000', pathUsd, 'pricey'),
    )
  /** Returns a credential for the pricey offer, whichever one mppx selected. */
  const pricey = async ({ challenges }: { challenges: readonly Challenge.Challenge[] }) =>
    Credential.serialize({
      challenge: challenges.find((challenge) => challenge.id === 'pricey')!,
      payload: { signature: '0xother' },
    })

  test('error: checks the offer a handler credential pays, not the selected one', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const fetch = server(offers)
    const mppx = create(fetch as never, [tempo], { maxPayment: { value: '1.5', currency: 'USD' } })
    const selected: string[] = []
    mppx.onChallengeReceived(async (payload) => {
      selected.push(payload.challenge.id)
      return pricey(payload)
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({ limit: 'maxPayment', reason: 'amount' })
    await expect(mppx.createCredential(offers())).rejects.toMatchObject({ reason: 'amount' })
    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    await expect(prepared.payment.pay()).rejects.toMatchObject({ reason: 'amount' })
    expect(selected).toEqual(['cheap', 'cheap', 'cheap'])
    expect(createCredential).not.toHaveBeenCalled()
    // Only the unpaid requests reached the server.
    expect(fetch).toHaveBeenCalledTimes(2)

    // Without spending options, the handler's credential is sent as before.
    const unlimited = create(server(offers) as never, [tempo])
    unlimited.onChallengeReceived(pricey)
    expect((await unlimited.fetch(url)).status).toBe(200)
  })

  test('error: fails closed for a credential that cannot be read or echoes no offer', async () => {
    const { method: tempo } = method('tempo')
    const authorize = vi.fn()
    const forged = Credential.serialize({
      challenge: tempoChallenge('1', pathUsd, 'forged'),
      payload: { signature: '0xother' },
    })
    // The offered ID with other terms.
    const altered = Credential.serialize({
      challenge: tempoChallenge('1', pathUsd, 'pricey'),
      payload: { signature: '0xother' },
    })
    for (const credential of [forged, altered, 'Payment not-a-credential']) {
      const fetch = server(offers)
      const mppx = create(fetch as never, [tempo], {
        authorize,
        onChallenge: async () => credential,
      })
      const error = await mppx.fetch(url).catch((error) => error)
      expect(error).toBeInstanceOf(Errors.PaymentLimitExceededError)
      expect(error).toMatchObject({ limit: 'budget', reason: 'credential' })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
    expect(authorize).not.toHaveBeenCalled()

    const unlimited = server(offers)
    await create(unlimited as never, [tempo], { onChallenge: async () => forged }).fetch(url)
    expect(unlimited).toHaveBeenCalledTimes(2)
  })

  test('behavior: authorizes and funds the offer a handler credential pays', async () => {
    const { method: tempo } = method('tempo')
    const fund = vi.fn(async (_requirement: Spend.Requirement) => {})
    const budget = Budget.create({ total: { value: '5', currency: 'USD' } })
    const mppx = create(server(offers) as never, [tempo], {
      authorize: budget,
      funders: [{ fund }],
    })
    mppx.onChallengeReceived(pricey)

    expect((await mppx.fetch(url)).status).toBe(200)
    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
    expect((await prepared.payment.pay()).status).toBe(200)

    // A prepared request funds the selected offer before its handler runs, then frees it and
    // funds the offer the handler's credential pays.
    expect(fund.mock.calls.map(([requirement]) => requirement.amount)).toEqual([
      2000000n,
      1000000n,
      2000000n,
    ])
    expect(budget.spent()).toEqual({ value: '4', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
  })
})

describe('cancellation', () => {
  test('error: a canceled prepared payment starts no authorization, funding or signing', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const authorize = vi.fn()
    const fund = vi.fn(async () => {})
    const fetch = server(() => paymentRequired(tempoChallenge('1')))
    const mppx = create(fetch as never, [tempo], { authorize, funders: [{ fund }] })

    const controller = new AbortController()
    const prepared = await mppx.prepareRequest(
      url,
      { signal: controller.signal },
      { requirePayment: true },
    )
    controller.abort()
    await expect(prepared.payment.pay()).rejects.toMatchObject({ name: 'AbortError' })

    const payment = await mppx.preparePayment(paymentRequired(tempoChallenge('1')), {
      request: { signal: controller.signal },
    })
    await expect(payment.createCredential()).rejects.toMatchObject({ name: 'AbortError' })

    expect(authorize).not.toHaveBeenCalled()
    expect(fund).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('error: canceling while a funder runs stops the rest and releases the budget', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const controller = new AbortController()
    const later = vi.fn(async () => {})
    const fetch = server(() => paymentRequired(tempoChallenge('1')))
    const mppx = create(fetch as never, [tempo], {
      authorize: budget,
      funders: [{ fund: async () => controller.abort() }, { fund: later }],
    })

    const prepared = await mppx.prepareRequest(
      url,
      { signal: controller.signal },
      { requirePayment: true },
    )
    await expect(prepared.payment.pay()).rejects.toMatchObject({ name: 'AbortError' })

    expect(later).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()
    expect(budget.remaining()).toEqual({ value: '1', currency: 'USD' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('receipts', () => {
  test('behavior: payment.response carries the receipt, amount and requirement', async () => {
    const { method: tempo } = method('tempo')
    const fetch = server(() => paymentRequired(tempoChallenge('25')), {
      'Payment-Receipt': receiptHeader(),
    })
    const mppx = create(fetch as never, [tempo])
    const payloads: Pick<Fetch.PaymentResponsePayload, 'amount' | 'receipt' | 'requirement'>[] = []
    mppx.onPaymentResponse(({ amount, receipt, requirement }) => {
      payloads.push({ amount, receipt, requirement })
    })

    await mppx.fetch(url)

    expect(payloads[0]?.amount).toBe('25')
    expect(payloads[0]?.requirement).toMatchObject({
      amount: 25n,
      currency: 'USD',
      network: 'eip155:4217',
    })
    expect(payloads[0]?.receipt).toMatchObject({
      protocol: 'mpp',
      reference: transaction,
      transactionHash: transaction,
    })
  })

  test('behavior: payment.response reports the offer a handler credential pays', async () => {
    const { method: tempo } = method('tempo')
    const offers = () =>
      paymentRequired(
        tempoChallenge('1000000', pathUsd, 'cheap'),
        tempoChallenge('2000000', pathUsd, 'pricey'),
      )
    const pricey = async ({ challenges }: { challenges: readonly Challenge.Challenge[] }) =>
      Credential.serialize({
        challenge: challenges.find((challenge) => challenge.id === 'pricey')!,
        payload: { signature: '0xother' },
      })
    const forged = Credential.serialize({
      challenge: tempoChallenge('1', pathUsd, 'forged'),
      payload: { signature: '0xother' },
    })
    for (const [options, handler, amount] of [
      [{}, pricey, '2000000'],
      [{ authorize: Budget.create({ total: { value: '5', currency: 'USD' } }) }, pricey, '2000000'],
      // Without spending options a credential that pays no offer is sent, with no terms reported.
      [{}, async () => forged, undefined],
    ] as const) {
      const mppx = create(server(offers) as never, [tempo], options)
      mppx.onChallengeReceived(handler)
      const payloads: Pick<Fetch.PaymentResponsePayload, 'amount' | 'requirement'>[] = []
      mppx.onPaymentResponse(({ amount, requirement }) => {
        payloads.push({ amount, requirement })
      })

      expect((await mppx.fetch(url)).status).toBe(200)

      expect(payloads).toHaveLength(1)
      expect(payloads[0]?.amount).toBe(amount)
      expect(payloads[0]?.requirement?.amount).toBe(
        amount === undefined ? undefined : BigInt(amount),
      )
    }
  })

  test('behavior: payment.response payloads serialize to JSON', async () => {
    const { method: tempo } = method('tempo')
    const mppx = create(server(() => paymentRequired(tempoChallenge('25'))) as never, [tempo])
    const serialized: string[] = []
    mppx.onPaymentResponse((payload) => {
      serialized.push(JSON.stringify({ amount: payload.amount, requirement: payload.requirement }))
    })
    // The whole envelope, as a logger forwarding every event would.
    mppx.on('*', (event) => {
      if (event.name === 'payment.response') serialized.push(JSON.stringify(event))
    })

    await mppx.fetch(url)

    expect(serialized).toHaveLength(2)
    expect(JSON.parse(serialized[0]!)).toMatchObject({
      amount: '25',
      requirement: { amount: '25', asset: pathUsd, currency: 'USD', intent: 'charge' },
    })
    expect(JSON.parse(serialized[1]!)).toMatchObject({
      name: 'payment.response',
      payload: { amount: '25', requirement: { amount: '25' } },
    })
  })

  test('behavior: readReceipt decodes MPP and x402 receipts', () => {
    const x402 = (body: unknown) =>
      new Response(null, { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify(body)) } })
    const settle = { network: 'eip155:8453', success: true, transaction }

    expect(
      Spend.readReceipt(new Response(null, { headers: { 'Payment-Receipt': receiptHeader() } })),
    ).toMatchObject({ protocol: 'mpp', transactionHash: transaction, raw: { method: 'tempo' } })
    expect(Spend.readReceipt(x402(settle))).toEqual({
      protocol: 'x402',
      raw: settle,
      reference: transaction,
      transactionHash: transaction,
    })
    expect(Spend.readReceipt(x402({ ...settle, transaction: 'ref-1' }))).toEqual({
      protocol: 'x402',
      raw: { ...settle, transaction: 'ref-1' },
      reference: 'ref-1',
    })
    expect(Spend.readReceipt(x402({ ...settle, success: false }))).toBeUndefined()
    expect(
      Spend.readReceipt(new Response(null, { headers: { 'PAYMENT-RESPONSE': 'not base64!' } })),
    ).toBeUndefined()
    expect(
      Spend.readReceipt(new Response(null, { headers: { 'Payment-Receipt': 'e30' } })),
    ).toBeUndefined()
    expect(Spend.readReceipt(new Response(null))).toBeUndefined()
  })
})

describe('intents', () => {
  /** A Tempo offer with a recurring intent, such as a session or subscription. */
  const recurringOffer = (intent: string) => () =>
    paymentRequired(
      Challenge.from({
        id: intent,
        intent,
        method: 'tempo',
        realm,
        request: { amount: '1', currency: pathUsd, recipient, methodDetails: { chainId: 4217 } },
      }),
    )

  test.each(['session', 'subscription'])(
    'error: spending options refuse %s offers before any hook or signing',
    async (intent) => {
      const { createCredential, method: recurring } = method('tempo', [], intent)
      const offer = recurringOffer(intent)
      const authorize = vi.fn()
      const fund = vi.fn(async () => {})
      for (const options of [
        { maxPayment: { value: '5', currency: 'USD' } },
        { authorize },
        { funders: [{ fund }] },
      ]) {
        const fetch = server(offer)
        const mppx = create(fetch as never, [recurring], options)
        const error = await mppx.fetch(url).catch((error) => error)
        expect(error).toBeInstanceOf(Errors.PaymentLimitExceededError)
        expect(error).toMatchObject({ reason: 'intent' })
        await expect(mppx.createCredential(offer())).rejects.toMatchObject({ reason: 'intent' })
        const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })
        await expect(prepared.payment.pay()).rejects.toMatchObject({ reason: 'intent' })
        // Only the unpaid requests reached the server.
        expect(fetch).toHaveBeenCalledTimes(2)
      }
      expect(authorize).not.toHaveBeenCalled()
      expect(fund).not.toHaveBeenCalled()
      expect(createCredential).not.toHaveBeenCalled()

      // Without spending options, they pay as before.
      expect((await create(server(offer) as never, [recurring]).fetch(url)).status).toBe(200)
      expect(createCredential).toHaveBeenCalledTimes(1)
    },
  )

  test('error: refuses a handler credential that pays a session offer', async () => {
    const { method: tempo } = method('tempo')
    const authorize = vi.fn()
    const sessionOffer = Challenge.from({
      id: 'session',
      intent: 'session',
      method: 'tempo',
      realm,
      request: { amount: '1', currency: pathUsd, recipient, methodDetails: { chainId: 4217 } },
    })
    const fetch = server(() => paymentRequired(tempoChallenge('1'), sessionOffer))
    const mppx = create(fetch as never, [tempo], {
      authorize,
      onChallenge: async () =>
        Credential.serialize({ challenge: sessionOffer, payload: { signature: '0xother' } }),
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({ reason: 'intent' })
    expect(authorize).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('offer binding', () => {
  test('error: binds a handler credential to the offer whose whole challenge it echoes', async () => {
    const { method: tempo } = method('tempo')
    // Two offers share an ID; the pricey one comes first and the cheap one is selected.
    const pricey = tempoChallenge('2000000', pathUsd, 'shared')
    const cheap = tempoChallenge('1000000', pathUsd, 'shared')
    const fetch = server(() => paymentRequired(pricey, cheap))
    const fund = vi.fn(async (_requirement: Spend.Requirement) => {})
    const mppx = create(fetch as never, [tempo], {
      funders: [{ fund }],
      maxPayment: { value: '1.5', currency: 'USD' },
      orderChallenges: (candidates: readonly unknown[]) => [...candidates].reverse(),
      onChallenge: async () =>
        Credential.serialize({ challenge: pricey, payload: { signature: '0xother' } }),
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({ limit: 'maxPayment', reason: 'amount' })
    // The credential pays the pricey offer, so the cheap offer's checks never stood in for it.
    expect(fund).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('error: fails closed when a credential echoes several identical offers', async () => {
    const { method: tempo } = method('tempo')
    const offer = tempoChallenge('1')
    const fetch = server(() => paymentRequired(offer, offer))
    const mppx = create(fetch as never, [tempo], {
      maxPayment: { value: '1', currency: 'USD' },
      onChallenge: async () =>
        Credential.serialize({ challenge: offer, payload: { signature: '0xother' } }),
    })

    await expect(mppx.fetch(url)).rejects.toMatchObject({ reason: 'credential' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  describe('native x402 credentials', () => {
    const accepted = (amount: string) => ({
      amount,
      asset: baseUsdc,
      maxTimeoutSeconds: 60,
      network: 'eip155:8453' as const,
      payTo: recipient,
      scheme: x402_Types.schemes[0],
    })
    /** A `PAYMENT-SIGNATURE` payload accepting `amount` and signing a transfer of `value`. */
    const signature = (amount: string, value = amount) =>
      x402_Header.encodePaymentSignature({
        accepted: accepted(amount),
        payload: {
          authorization: {
            from: recipient,
            nonce: `0x${'11'.repeat(32)}`,
            to: recipient,
            validAfter: '0',
            validBefore: '9999999999',
            value,
          },
          signature: `0x${'22'.repeat(65)}`,
        },
        resource: { url },
        x402Version: 2,
      })
    const maxPayment = [{ network: 'eip155:8453', asset: baseUsdc, amount: 1000n }]

    test('behavior: a handler credential is bound to the x402 offer it signs', async () => {
      const { createCredential, method: evm } = method(x402_Types.paymentMethod)
      const sent: (string | null)[] = []
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const header = new Request(input, init).headers.get(x402_Types.paymentSignatureHeader)
        if (!header) return x402Response('1000')
        sent.push(header)
        return new Response('OK')
      })
      const credential = signature('1000')
      const mppx = create(fetch as never, [evm], {
        maxPayment,
        onChallenge: async () => credential,
      })

      expect((await mppx.fetch(url)).status).toBe(200)
      expect(sent).toEqual([credential])
      expect(createCredential).not.toHaveBeenCalled()
    })

    test('error: refuses an x402 credential over the limit or signing other terms', async () => {
      const { method: evm } = method(x402_Types.paymentMethod)
      const pay = (offer: string, credential: string) =>
        create(server(() => x402Response(offer)) as never, [evm], {
          maxPayment,
          onChallenge: async () => credential,
        }).fetch(url)

      await expect(pay('2000', signature('2000'))).rejects.toMatchObject({ reason: 'amount' })
      // It signs a larger transfer than it accepts, or accepts other terms than offered.
      await expect(pay('1000', signature('1000', '2000'))).rejects.toMatchObject({
        reason: 'credential',
      })
      await expect(pay('1000', signature('999'))).rejects.toMatchObject({ reason: 'credential' })
    })
  })
})

describe('in-flight credentials', () => {
  test('behavior: a rejected onChallenge keeps the reservation until its credential settles', async () => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    let started!: () => void
    const begun = new Promise<void>((resolve) => (started = resolve))
    const tempo = Method.toClient(
      Method.from({ name: 'tempo', intent: 'charge', schema: Methods.charge.schema }),
      {
        async createCredential({ challenge }) {
          started()
          await finished
          return Credential.serialize({ challenge, payload: { signature: '0xsignature' } })
        },
      },
    )
    const budget = Budget.create({ total: { value: '1', currency: 'USD' } })
    const fetch = server(() => paymentRequired(tempoChallenge('1000000')))
    const mppx = create(fetch as never, [tempo], {
      authorize: budget,
      onChallenge: async (
        _challenge: Challenge.Challenge,
        { createCredential }: { createCredential: () => Promise<string> },
      ) => {
        void createCredential().catch(() => {})
        await begun
        throw new Error('handler failed')
      },
    })

    const result = mppx.fetch(url).catch((error: Error) => error)
    await begun
    // The credential is still being created, and may yet be sent: it stays reserved.
    expect(budget.reserved()).toEqual({ value: '1', currency: 'USD' })
    finish()
    expect(String(await result)).toContain('handler failed')
    expect(budget.spent()).toEqual({ value: '1', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('hooks', () => {
  test('behavior: hooks get a frozen copy of the challenge, and the checked one is signed', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const rewrite = (context: Spend.Context) => {
      try {
        ;(context.challenge.request as Record<string, unknown>).amount = '999000000'
      } catch {}
    }
    const mppx = create(
      server(() => paymentRequired(tempoChallenge('1000000'))) as never,
      [tempo],
      {
        authorize: (_plan: Spend.Plan, context: Spend.Context) => rewrite(context),
        funders: [
          {
            fund: async (_requirement: Spend.Requirement, context: Spend.Context) =>
              rewrite(context),
          },
        ],
      },
    )

    expect((await mppx.fetch(url)).status).toBe(200)
    expect(createCredential.mock.calls[0]?.[0].challenge.request).toMatchObject({
      amount: '1000000',
    })
  })
})

describe('requirements', () => {
  test('behavior: x402 amounts with leading zeroes count as the signer reads them', async () => {
    const { createCredential, method: evm } = method(x402_Types.paymentMethod)
    const mppx = create(server(() => x402Response('0001000')) as never, [evm], {
      maxPayment: [{ network: 'eip155:8453', asset: baseUsdc, amount: 1000n }],
    })

    expect((await mppx.fetch(url)).status).toBe(200)
    expect(createCredential).toHaveBeenCalledTimes(1)
    await expect(
      create(server(() => x402Response('0001001')) as never, [evm], {
        maxPayment: [{ network: 'eip155:8453', asset: baseUsdc, amount: 1000n }],
      }).fetch(url),
    ).rejects.toMatchObject({ reason: 'amount' })
  })

  test('behavior: the plan names every Tempo split recipient and the total amount', async () => {
    const { method: tempo } = method('tempo')
    const other = '0x3333333333333333333333333333333333333333'
    const offer = challenge('tempo', {
      amount: '1000000',
      currency: pathUsd,
      recipient,
      methodDetails: { chainId: 4217, splits: [{ amount: '0250000', recipient: other }] },
    })
    const plans: Spend.Plan[] = []
    const mppx = create(server(() => paymentRequired(offer)) as never, [tempo], {
      authorize: (plan: Spend.Plan) => void plans.push(plan),
    })

    expect((await mppx.fetch(url)).status).toBe(200)
    expect(plans[0]?.requirement).toMatchObject({
      amount: 1000000n,
      recipient,
      splits: [{ amount: 250000n, recipient: other }],
    })
    expect(JSON.parse(JSON.stringify(plans[0]?.requirement))).toMatchObject({
      amount: '1000000',
      splits: [{ amount: '250000', recipient: other }],
    })

    // Splits that leave the recipient nothing cannot be checked.
    const unpayable = challenge('tempo', {
      amount: '1',
      currency: pathUsd,
      recipient,
      methodDetails: { chainId: 4217, splits: [{ amount: '1', recipient: other }] },
    })
    await expect(
      create(server(() => paymentRequired(unpayable)) as never, [tempo], {
        authorize: () => {},
      }).fetch(url),
    ).rejects.toThrow('payment splits')
  })

  test('behavior: the plan names the Stripe network profile as the payee', async () => {
    const { method: stripe } = method('stripe')
    const plans: Spend.Plan[] = []
    const authorize = (plan: Spend.Plan) => void plans.push(plan)

    expect(
      (
        await create(server(() => paymentRequired(stripeChallenge('100'))) as never, [stripe], {
          authorize,
        }).fetch(url)
      ).status,
    ).toBe(200)
    expect(plans[0]?.requirement.recipient).toBe(networkId)
    await expect(
      create(
        server(() => paymentRequired(stripeChallenge('100', { methodDetails: {} }))) as never,
        [stripe],
        { authorize },
      ).fetch(url),
    ).rejects.toThrow('networkId')
  })

  test('error: a prepared payment paid after its challenge expired runs no hook', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const authorize = vi.fn()
    const fund = vi.fn(async () => {})
    const expires = new Date(Date.now() + 60_000).toISOString()
    const offer = Challenge.from({
      id: 'expiring',
      intent: 'charge',
      method: 'tempo',
      realm,
      expires,
      request: { amount: '1', currency: pathUsd, recipient, methodDetails: { chainId: 4217 } },
    })
    const mppx = create(server(() => paymentRequired(offer)) as never, [tempo], {
      authorize,
      funders: [{ fund }],
    })
    const prepared = await mppx.prepareRequest(url, undefined, { requirePayment: true })

    vi.useFakeTimers({ now: new Date(expires).getTime() + 1, toFake: ['Date'] })
    try {
      await expect(prepared.payment.pay()).rejects.toBeInstanceOf(Errors.PaymentExpiredError)
    } finally {
      vi.useRealTimers()
    }
    expect(authorize).not.toHaveBeenCalled()
    expect(fund).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('error: a challenge that expires while authorize and funders run is not signed', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const expires = new Date(Date.now() + 60_000).toISOString()
    const offer = Challenge.from({
      id: 'expiring',
      intent: 'charge',
      method: 'tempo',
      realm,
      expires,
      request: { amount: '1', currency: pathUsd, recipient, methodDetails: { chainId: 4217 } },
    })
    const elapse = () => vi.setSystemTime(new Date(expires).getTime() + 1)
    const settlement = { commit: vi.fn(), release: vi.fn() }
    for (const options of [
      { authorize: vi.fn(async () => (elapse(), settlement)) },
      { funders: [{ fund: vi.fn(async () => elapse()) }] },
    ]) {
      vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
      try {
        const fetch = server(() => paymentRequired(offer))
        const error = await create(fetch as never, [tempo], options)
          .fetch(url)
          .catch((error) => error)
        expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
        expect(fetch).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    }
    expect(createCredential).not.toHaveBeenCalled()
    expect(settlement.release).toHaveBeenCalledTimes(1)
    expect(settlement.commit).not.toHaveBeenCalled()
  })

  test('error: an offer native EVM charge refuses reaches no funder', async () => {
    const fund = vi.fn(async () => {})
    const offer = challenge('evm', {
      amount: '1000',
      currency: baseUsdc,
      recipient,
      methodDetails: { chainId: 8453, credentialTypes: ['authorization'], decimals: 6 },
    })
    const fetch = server(() => paymentRequired(offer))
    const mppx = create(
      fetch as never,
      [evm.charge({ account: privateKeyToAccount(generatePrivateKey()), networks: [1] })],
      {
        funders: [{ fund }],
        maxPayment: [{ network: 'eip155:8453', asset: baseUsdc, amount: 1000n }],
      },
    )

    await expect(mppx.fetch(url)).rejects.toThrow('EVM chain ID is not allowed: 8453.')
    expect(fund).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('rewrapping', () => {
  const offer = () => paymentRequired(tempoChallenge('2000000'))
  const limited = (fetch: typeof globalThis.fetch, methods: Mppx.Methods) =>
    create(fetch, methods, { maxPayment: { value: '1', currency: 'USD' } }).fetch

  test('error: a fetch built on a limited mppx fetch keeps its limits', async () => {
    const { createCredential, method: tempo } = method('tempo')
    const upstream = server(offer)
    const inner = limited(upstream as never, [tempo])

    await expect(Fetch.from({ fetch: inner, methods: [tempo] })(url)).rejects.toMatchObject({
      limit: 'maxPayment',
      reason: 'amount',
    })
    await expect(create(inner, [tempo]).fetch(url)).rejects.toMatchObject({ reason: 'amount' })
    const prepared = await create(inner, [tempo]).prepareRequest(url, undefined, {
      requirePayment: true,
    })
    await expect(prepared.payment.pay()).rejects.toMatchObject({ reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('error: rejects spending options on both the fetch and its wrapper', () => {
    const { method: tempo } = method('tempo')
    const inner = limited(server(offer) as never, [tempo])
    const options = { maxPayment: { value: '5', currency: 'USD' } }

    expect(() => Fetch.from({ ...options, fetch: inner, methods: [tempo] })).toThrow(TypeError)
    expect(() => create(inner, [tempo], options)).toThrow(TypeError)
    expect(() => sessionManager({ account: recipient, fetch: inner })).toThrow(
      'accept only charges',
    )
  })
})

describe('MCP', () => {
  /** A `tools/call` request that `McpClient.wrap` tags as paying itself. */
  const toolCall = () => ({
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { _meta: { 'mppx/payment-client': true }, arguments: {}, name: 'paid_tool' },
    }),
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    method: 'POST',
  })

  test('error: a fetch with spending options refuses tool calls McpClient.wrap pays itself', async () => {
    const { method: tempo } = method('tempo')
    for (const options of [
      { maxPayment: { value: '1', currency: 'USD' } },
      { authorize: Budget.create({ total: { value: '1', currency: 'USD' } }) },
      { funders: [{ fund: async () => {} }] },
    ]) {
      const upstream = vi.fn(async () => Response.json({ id: 1, jsonrpc: '2.0', result: {} }))
      const limited = Fetch.from({ ...options, fetch: upstream as never, methods: [tempo] })
      await expect(limited(url, toolCall())).rejects.toThrow(TypeError)
      // Rewrapping keeps the refusal.
      await expect(
        Fetch.from({ fetch: limited, methods: [tempo] })(url, toolCall()),
      ).rejects.toThrow('McpClient.wrap')
      expect(upstream).not.toHaveBeenCalled()
    }

    // Without spending options, the tagged call is sent and left to McpClient.wrap as before.
    const upstream = vi.fn(async () => Response.json({ id: 1, jsonrpc: '2.0', result: {} }))
    const response = await Fetch.from({ fetch: upstream as never, methods: [tempo] })(
      url,
      toolCall(),
    )
    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})
