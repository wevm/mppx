import { Challenge } from 'mppx'
import { tempo as tempo_client } from 'mppx/client'
import { Mppx, tempo } from 'mppx/server'
import { createClient, custom, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

const merchant = '0x2222222222222222222222222222222222222222'
const currency = '0x20c0000000000000000000000000000000000001'
const payer = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)

const l1 = createClient({
  chain: tempoModerato,
  transport: custom({
    async request({ method }) {
      if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
      throw new Error(`l1: ${method}`)
    },
  }),
})

/** A Zone client whose every RPC call fails loudly, to show whether the client used it. */
function zoneClient(chainId: number, calls: string[] = []) {
  return createClient({
    account: payer,
    chain: defineChain({ ...tempoModerato, id: chainId, name: 'Zone' }),
    transport: custom(
      {
        async request({ method }) {
          calls.push(method)
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error('zone used')
        },
      },
      { retryCount: 0 },
    ),
  })
}

async function challenge(request: Record<string, unknown> = {}, zones: number[] | true = [3]) {
  const server = Mppx.create({
    realm: 'api.example.com',
    secretKey: 'test-secret-key-test-secret-key-32',
    methods: [
      tempo.charge({ account: merchant, currency, getClient: () => l1, testnet: true, zones }),
    ],
  })
  const result = await server.charge({ amount: '1', decimals: 6, ...request })(
    new Request('https://example.com'),
  )
  if (result.status !== 402) throw new Error('Expected challenge')
  return Challenge.fromResponse(result.challenge)
}

describe('tempo.charge client zone selection', () => {
  test('pays from a Zone on the challenge chain', async () => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_003) },
    })
    await expect(
      method.createCredential({ challenge: (await challenge()) as never, context: {} }),
    ).rejects.toThrow('zone used')
  })

  test('pays from a Zone when the challenge accepts any Zone', async () => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_003) },
    })
    await expect(
      method.createCredential({ challenge: (await challenge({}, true)) as never, context: {} }),
    ).rejects.toThrow('zone used')
  })

  test('pays on Tempo when the challenge does not accept the Zone', async () => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_004) },
    })
    const error = await method
      .createCredential({ challenge: (await challenge()) as never, context: {} })
      .catch((error: Error) => error)
    expect(String(error)).not.toContain('zone used')
  })

  test('pays on Tempo when the challenge expires before the Zone withdrawal could settle', async () => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_003), settlementTimeoutMs: 60_000 },
    })
    const expires = new Date(Date.now() + 30_000).toISOString()
    const error = await method
      .createCredential({ challenge: (await challenge({ expires })) as never, context: {} })
      .catch((error: Error) => error)
    expect(String(error)).not.toContain('zone used')
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects zone.settlementTimeoutMs %s before any withdrawal',
    (settlementTimeoutMs) => {
      expect(() =>
        tempo_client.charge({
          getClient: () => l1,
          zone: { client: zoneClient(1_424_310_003), settlementTimeoutMs },
        }),
      ).toThrow('settlementTimeoutMs')
    },
  )

  test('rejects a zoneId that does not match the Zone client chain', () => {
    expect(() =>
      tempo_client.charge({
        getClient: () => l1,
        zone: { client: zoneClient(1_424_310_003), zoneId: 4 },
      }),
    ).toThrow('does not match Zone 3')
  })

  test('does not withdraw again after a withdrawal with an unknown outcome', async () => {
    const calls: string[] = []
    const zone = createClient({
      account: payer,
      chain: defineChain({ ...tempoModerato, id: 1_424_310_003, name: 'Zone' }),
      transport: custom(
        {
          async request({ method }) {
            calls.push(method)
            // The withdrawal fee lookup succeeds; sending the withdrawal fails.
            if (method === 'eth_call') return `0x${'00'.repeat(32)}`
            throw new Error('connection lost')
          },
        },
        { retryCount: 0 },
      ),
    })
    const method = tempo_client.charge({ getClient: () => l1, zone: { client: zone } })
    const c = await challenge()
    await expect(method.createCredential({ challenge: c as never, context: {} })).rejects.toThrow(
      'Zone withdrawal outcome is unknown',
    )
    const sent = calls.length
    await expect(method.createCredential({ challenge: c as never, context: {} })).rejects.toThrow(
      'Zone withdrawal outcome is unknown',
    )
    expect(calls).toHaveLength(sent)
  })

  test('pays on Tempo when the challenge leaves no time to send the withdrawal', async () => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_003), settlementTimeoutMs: 60_000 },
    })
    // More than the settlement timeout, but not enough to also send the withdrawal.
    const expires = new Date(Date.now() + 65_000).toISOString()
    const error = await method
      .createCredential({ challenge: (await challenge({ expires })) as never, context: {} })
      .catch((error: Error) => error)
    expect(String(error)).not.toContain('zone used')
  })

  test('shares one withdrawal request between concurrent calls for a challenge', async () => {
    const calls: string[] = []
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(1_424_310_003, calls) },
    })
    const c = await challenge()
    const results = await Promise.allSettled([
      // Different accounts make different signing operations, but both withdraw from the Zone account.
      method.createCredential({ challenge: c as never, context: { account: payer } as never }),
      method.createCredential({
        challenge: c as never,
        context: {
          account: privateKeyToAccount(
            '0x0000000000000000000000000000000000000000000000000000000000000002',
          ),
        } as never,
      }),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toHaveLength(1)
  })

  test.each([
    ['the Zone settles on another parent chain', 421_700_003, {}, {}],
    ['the challenge only accepts pull payments', 1_424_310_003, { supportedModes: ['pull'] }, {}],
    ['the client asks for pull mode', 1_424_310_003, {}, { mode: 'pull' }],
    [
      'the challenge has splits',
      1_424_310_003,
      { splits: [{ amount: '0.1', recipient: merchant }] },
      {},
    ],
  ] as const)('pays on Tempo when %s', async (_, zoneChainId, request, context) => {
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zoneClient(zoneChainId) },
    })
    const error = await method
      .createCredential({
        challenge: (await challenge(request)) as never,
        context: context as never,
      })
      .catch((error: Error) => error)
    expect(String(error)).not.toContain('zone used')
  })
})
