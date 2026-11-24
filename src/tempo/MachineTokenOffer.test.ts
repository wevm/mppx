import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, Store, tempo as tempo_server } from 'mppx/server'
import { type Address, zeroAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { Actions } from 'viem/tempo'
import { afterAll, beforeAll, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, chain, client } from '~test/tempo/viem.js'

import * as defaults from './internal/defaults.js'

// Localnet has no MACH deployment: a fresh TIP-20 stands in for it, registered as this chain's MACH.
vi.mock('./internal/defaults.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  return { ...actual, machineToken: { ...(actual.machineToken as object) } }
})

// pathUSD: the main currency, which also pays fees on localnet.
const asset = '0x20c0000000000000000000000000000000000000' as const
const secretKey = 'test-secret-key-that-is-at-least-32-bytes'
const recipient = accounts[0].address
const deployments = defaults.machineToken as Record<number, { swap: Address; token: Address }>
let mach: Address

beforeAll(async () => {
  const { token } = await Actions.token.createSync(client, {
    account: accounts[0],
    chain,
    currency: 'USD',
    name: 'Machine Token',
    symbol: 'MACH',
  })
  mach = token
  await Actions.token.grantRolesSync(client, {
    account: accounts[0],
    chain,
    roles: ['issuer'],
    to: accounts[0].address,
    token: mach,
  })
  deployments[chain.id] = { swap: zeroAddress, token: mach }
})

afterAll(() => {
  delete deployments[chain.id]
})

/** A new payer holding `stablecoin` of the main currency and `machineToken` of MACH. */
async function createPayer(balances: { machineToken: bigint; stablecoin: bigint }) {
  const payer = privateKeyToAccount(generatePrivateKey())
  if (balances.stablecoin > 0n)
    await Actions.token.transferSync(client, {
      account: accounts[0],
      amount: balances.stablecoin,
      chain,
      to: payer.address,
      token: asset,
    })
  if (balances.machineToken > 0n)
    await Actions.token.mintSync(client, {
      account: accounts[0],
      amount: balances.machineToken,
      chain,
      to: payer.address,
      token: mach,
    })
  return payer
}

async function balance(account: Address, token: Address) {
  return (await Actions.token.getBalance(client, { account, token })).amount
}

function createServer(withMachineToken: boolean, payee: Address = recipient) {
  return Mppx_server.create({
    methods: [
      tempo_server({
        acceptMachineToken: withMachineToken,
        chainId: chain.id,
        currencies: [asset],
        getClient: () => client,
        recipient: payee,
        store: Store.memory(),
      }),
    ],
    secretKey,
  })
}

async function serve(handler: (request: Request) => Promise<Response>) {
  return Http.createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`
    const response = await handler(
      new Request(url, { headers: req.headers as HeadersInit, method: req.method ?? 'GET' }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  })
}

function chargeRoute(server: ReturnType<typeof createServer>) {
  return async (request: Request) => {
    const result = await server.charge({ amount: '1', decimals: 6 })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(new Response('paid'))
  }
}

describe('MACH direct payments', () => {
  test('server: offers MACH after the stablecoin, for charges and sessions', async () => {
    const server = createServer(true)
    const charge = await server.charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/'),
    )
    if (charge.status !== 402) throw new Error('expected a challenge')
    const offers = Challenge.fromResponseList(charge.challenge)
    expect(offers.map((offer) => offer.request.currency)).toEqual([asset, mach])
    expect(offers.map((offer) => offer.request.recipient)).toEqual([recipient, recipient])
    expect(offers.map((offer) => offer.request.amount)).toEqual(['1000000', '1000000'])

    const session = await server.session({ amount: '1', decimals: 6, unitType: 'request' })(
      new Request('https://api.example.com/'),
    )
    if (session.status !== 402) throw new Error('expected a challenge')
    const sessionOffers = Challenge.fromResponseList(session.challenge)
    expect(sessionOffers.map((offer) => offer.request.currency)).toEqual([asset, mach])
  })

  test('server: offers no MACH unless listed', async () => {
    const charge = await createServer(false).charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/'),
    )
    if (charge.status !== 402) throw new Error('expected a challenge')
    expect(Challenge.fromResponseList(charge.challenge)).toHaveLength(1)
  })

  test('server: MACH cannot be listed as a currency, in any position', () => {
    const mainnetMachineToken = '0x20c000000000000000000000f37de3740ADec032'
    for (const currencies of [
      [mainnetMachineToken, asset],
      [asset, mainnetMachineToken],
      [mainnetMachineToken],
    ])
      expect(() =>
        tempo_server({ currencies: currencies as never, recipient, testnet: false }),
      ).toThrow('MACH cannot be listed as a currency')
    expect(() =>
      tempo_server.subscription({
        amount: '1',
        currencies: [mainnetMachineToken],
        periodCount: 1,
        periodUnit: 'day',
        recipient,
        testnet: false,
      } as never),
    ).toThrow('MACH cannot be listed as a currency')
  })

  test('server: a route cannot set MACH as its currency', async () => {
    const server = Mppx_server.create({
      methods: [
        tempo_server.charge({
          chainId: chain.id,
          currencies: [asset],
          getClient: () => client,
          machineTokenEnabled: true,
          recipient,
        }),
      ],
      secretKey,
    })
    await expect(
      server.charge({ amount: '1', currency: mach, decimals: 6 })(
        new Request('https://api.example.com/'),
      ),
    ).rejects.toThrow('MACH cannot be listed as a currency')
  })

  test('server: settles a credential for the MACH offer directly to the recipient', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const before = await balance(recipient, mach)
    const challenge = await server.charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/'),
    )
    if (challenge.status !== 402) throw new Error('expected a challenge')
    const [, machineTokenOffer] = Challenge.fromResponseList(challenge.challenge)
    const method = tempo_client.charge({ account: payer, getClient: () => client })
    const credential = await method.createCredential({
      challenge: machineTokenOffer as never,
      context: {},
    })
    const paid = await server.charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/', { headers: { Authorization: credential } }),
    )
    expect(paid.status).toBe(200)
    expect(await balance(recipient, mach)).toBe(before + 1_000_000n)
  })

  test('charge: a payer holding MACH pays MACH straight to the recipient', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const before = await balance(recipient, mach)
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')
    expect(await balance(payer.address, mach)).toBe(4_000_000n)
    expect(await balance(recipient, mach)).toBe(before + 1_000_000n)
    httpServer.close()
  })

  test('charge: a MACH offer is paid directly even with machineTokenEnabled on', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = Mppx_server.create({
      methods: [
        tempo_server({
          acceptMachineToken: true,
          chainId: chain.id,
          currencies: [asset],
          getClient: () => client,
          machineTokenEnabled: true,
          recipient,
          store: Store.memory(),
        }),
      ],
      secretKey,
    })
    const before = await balance(recipient, mach)
    const httpServer = await serve(chargeRoute(server))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      polyfill: false,
    })
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(recipient, mach)).toBe(before + 1_000_000n)
    httpServer.close()
  })

  test('charge: a payer without MACH keeps paying the main currency', async () => {
    const payer = await createPayer({ machineToken: 0n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, asset)).toBeLessThan(4_000_001n)
    httpServer.close()
  })

  test('charge: a payer with too little MACH keeps paying the main currency', async () => {
    const payer = await createPayer({ machineToken: 500_000n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(500_000n)
    httpServer.close()
  })

  test('charge: a client allowlist without MACH never pays MACH', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, currencies: [asset], getClient: () => client })],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    httpServer.close()
  })

  test('charge: a client with resolveAccount keeps the server order', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const spender = await createPayer({ machineToken: 0n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [
        tempo_client({ account: payer, getClient: () => client, resolveAccount: () => spender }),
      ],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    expect(await balance(spender.address, asset)).toBeLessThanOrEqual(4_000_000n)
    httpServer.close()
  })

  test('charge: a payer with MACH but nothing to pay gas with is not moved to MACH', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 0n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      polyfill: false,
    })
    // MACH isn't preferred without gas, so the client pays the first offer, which it can't afford.
    await expect(mppx.fetch(httpServer.url)).rejects.toThrow('holds 0 of token')
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    httpServer.close()
  })

  test("charge: MACH's transfer policy refusing the recipient fails the payment", async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const { policyId } = await Actions.policy.createSync(client, {
      account: accounts[0],
      addresses: [payer.address, accounts[0].address],
      chain,
      type: 'whitelist',
    } as never)
    const blockedRecipient = accounts[3].address
    await Actions.token.changeTransferPolicySync(client, {
      account: accounts[0],
      chain,
      policyId,
      token: mach,
    } as never)
    try {
      const httpServer = await serve(chargeRoute(createServer(true, blockedRecipient)))
      const mppx = Mppx_client.create({
        methods: [tempo_client({ account: payer, getClient: () => client })],
        polyfill: false,
      })
      // Like the tempo CLI, a refused MACH payment is reported rather than retried in another currency.
      await expect(mppx.fetch(httpServer.url)).rejects.toThrow()
      expect(await balance(payer.address, mach)).toBe(5_000_000n)
      expect(await balance(payer.address, asset)).toBe(5_000_000n)
      httpServer.close()
    } finally {
      await Actions.token.changeTransferPolicySync(client, {
        account: accounts[0],
        chain,
        policyId: 1n,
        token: mach,
      } as never)
    }
  })

  test('charge: orderChallenges keeps the last word', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const httpServer = await serve(chargeRoute(createServer(true)))
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client })],
      orderChallenges: (candidates) =>
        [...candidates].sort(
          (a, b) =>
            Number(a.challenge.request.currency === mach) -
            Number(b.challenge.request.currency === mach),
        ),
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    httpServer.close()
  })

  test('charge: a client that ignores preferences (an older client) pays the first offer', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const challenge = await server.charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/'),
    )
    if (challenge.status !== 402) throw new Error('expected a challenge')
    const [first] = Challenge.fromResponseList(challenge.challenge)
    const method = tempo_client.charge({ account: payer, getClient: () => client })
    const credential = await method.createCredential({ challenge: first as never, context: {} })
    expect(Credential.deserialize(credential).challenge.request.currency).toBe(asset)
    const paid = await server.charge({ amount: '1', decimals: 6 })(
      new Request('https://api.example.com/', { headers: { Authorization: credential } }),
    )
    expect(paid.status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
  })

  test('session: a payer holding MACH opens its channel in MACH, with fees in the main currency', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '1' })],
      polyfill: false,
    })
    for (let i = 0; i < 3; i++) {
      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)
    }
    // The channel is funded in MACH; the main currency only paid transaction fees.
    expect(await balance(payer.address, mach)).toBeLessThanOrEqual(4_700_000n)
    expect(await balance(payer.address, asset)).toBeGreaterThan(4_990_000n)
    expect(await balance(payer.address, asset)).toBeLessThan(5_000_000n)
    httpServer.close()
  })

  test('session: an open main-currency channel keeps being used after the payer gets MACH', async () => {
    const payer = await createPayer({ machineToken: 0n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '1' })],
      polyfill: false,
    })
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    await Actions.token.mintSync(client, {
      account: accounts[0],
      amount: 5_000_000n,
      chain,
      to: payer.address,
      token: mach,
    })
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    // No second channel: MACH stays untouched while the main-currency channel can pay.
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    httpServer.close()
  })

  test('session: a MACH channel at its maxDeposit is not preferred', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '0.1' })],
      polyfill: false,
    })
    // The first request opens a MACH channel holding exactly one request.
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(4_900_000n)
    // The second can't be paid from that channel, so it uses the main currency instead of failing.
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(4_900_000n)
    httpServer.close()
  })

  test("session: an exhausted MACH channel the payer can't top up is not preferred", async () => {
    // Exactly one opening deposit of MACH: nothing left to top the channel up with.
    const payer = await createPayer({ machineToken: 100_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '1' })],
      polyfill: false,
    })
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(0n)
    // The open channel is spent and can't be topped up, so the stablecoin offer pays.
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(payer.address, asset)).toBeLessThan(5_000_000n)
    httpServer.close()
  })

  test('session: a client with resolveAccount keeps the server order', async () => {
    const payer = await createPayer({ machineToken: 5_000_000n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [
        tempo_client({
          account: payer,
          getClient: () => client,
          maxDeposit: '1',
          resolveAccount: () => undefined,
        }),
      ],
      polyfill: false,
    })
    expect((await mppx.fetch(httpServer.url)).status).toBe(200)
    expect(await balance(payer.address, mach)).toBe(5_000_000n)
    httpServer.close()
  })

  test('session: a payer without MACH opens its channel in the main currency', async () => {
    const payer = await createPayer({ machineToken: 0n, stablecoin: 5_000_000n })
    const server = createServer(true)
    const httpServer = await serve(async (request) => {
      const result = await server.session({ amount: '0.1', decimals: 6, unitType: 'request' })(
        request,
      )
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '1' })],
      polyfill: false,
    })
    const response = await mppx.fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await balance(payer.address, asset)).toBeLessThanOrEqual(4_900_000n)
    httpServer.close()
  })
})

describe('MACH gas', () => {
  // A stablecoin other than pathUSD, the localnet default fee token.
  const alphaUsd = '0x20c0000000000000000000000000000000000001' as const

  async function payerWith(stablecoin: Address | undefined) {
    const payer = privateKeyToAccount(generatePrivateKey())
    if (stablecoin) {
      await Actions.token.transferSync(client, {
        account: accounts[0],
        amount: 5_000_000n,
        chain,
        to: payer.address,
        token: stablecoin,
      })
      // The payer's own fee token: a stablecoin that isn't one of Tempo's defaults.
      await Actions.fee.setUserTokenSync(client, {
        account: payer,
        chain,
        feeToken: stablecoin,
        token: stablecoin,
      } as never)
    }
    await Actions.token.mintSync(client, {
      account: accounts[0],
      amount: 5_000_000n,
      chain,
      to: payer.address,
      token: mach,
    })
    return payer
  }

  function server(options: { sponsored: boolean | 'feeToken'; main: Address }) {
    return Mppx_server.create({
      methods: [
        tempo_server({
          acceptMachineToken: true,
          chainId: chain.id,
          currencies: [options.main],
          ...(options.sponsored ? { feePayer: accounts[1] } : {}),
          ...(options.sponsored === 'feeToken' ? { feeToken: asset } : {}),
          getClient: () => client,
          recipient,
          store: Store.memory(),
        }),
      ],
      secretKey,
    })
  }

  async function pay(intent: 'charge' | 'session', s: ReturnType<typeof server>, payer: any) {
    const httpServer = await serve(async (request) => {
      const result =
        intent === 'charge'
          ? await s.charge({ amount: '1', decimals: 6 })(request)
          : await s.session({ amount: '0.1', decimals: 6, unitType: 'request' })(request)
      if (result.status === 402) return result.challenge
      return result.withReceipt(new Response('paid'))
    })
    const mppx = Mppx_client.create({
      methods: [tempo_client({ account: payer, getClient: () => client, maxDeposit: '1' })],
      polyfill: false,
    })
    try {
      const response = await mppx.fetch(httpServer.url)
      return response.status === 200 ? 'paid' : `status ${response.status}`
    } catch (error) {
      return `error: ${(error as Error).message.slice(0, 160)}`
    } finally {
      httpServer.close()
    }
  }

  test.each([
    { intent: 'charge', sponsored: false },
    { intent: 'charge', sponsored: true },
    { intent: 'session', sponsored: false },
    { intent: 'session', sponsored: true },
    { intent: 'session', sponsored: 'feeToken' },
  ] as const)('$intent, sponsored $sponsored: pays MACH', async ({ intent, sponsored }) => {
    // Unsponsored: the payer holds MACH and a non-default stablecoin for gas. Sponsored: only MACH.
    const payer = await payerWith(sponsored ? undefined : alphaUsd)
    const result = await pay(intent, server({ sponsored, main: alphaUsd }), payer)
    expect(result).toBe('paid')
    expect(await balance(payer.address, mach)).toBeLessThan(5_000_000n)
  })
})
