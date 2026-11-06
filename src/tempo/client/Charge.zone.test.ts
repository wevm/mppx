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
function zoneClient(chainId: number) {
  return createClient({
    account: payer,
    chain: defineChain({ ...tempoModerato, id: chainId, name: 'Zone' }),
    transport: custom({
      async request() {
        throw new Error('zone used')
      },
    }),
  })
}

async function challenge(request: Record<string, unknown> = {}, zones: number[] | '*' = [3]) {
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
      method.createCredential({ challenge: (await challenge({}, '*')) as never, context: {} }),
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
