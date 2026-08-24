import { FacilitatorResponseError, x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { evm } from 'mppx/client'
import { McpClient } from 'mppx/mcp/client'
import { mpp } from 'mppx/x402/mcp'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

const network = 'eip155:84532' as const
const recipient = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const transaction = `0x${'1'.repeat(64)}`
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)

async function createHarness() {
  const calls: string[] = []
  const facilitator = {
    async getSupported() {
      return {
        extensions: [],
        kinds: [
          { extra: { assetTransferMethod: 'eip3009' }, network, scheme: 'exact', x402Version: 2 },
        ],
        signers: {},
      }
    },
    async settle() {
      calls.push('settle')
      return { network, payer: account.address, success: true, transaction }
    },
    async verify() {
      calls.push('verify')
      return { isValid: true, payer: account.address }
    },
  }
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
  await server.initialize()
  const accepts = await server.buildPaymentRequirements({
    network,
    payTo: recipient,
    price: '$0.01',
    scheme: 'exact',
  })
  const paid = mpp(server, {
    accepts,
    resource: { description: 'Premium search', url: 'mcp://tool/search' },
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const tool = paid(async ({ query }: { query: string }) => ({
    content: [{ text: `result:${query}`, type: 'text' }],
  }))
  return { accepts, calls, server, tool }
}

describe('x402 MCP compatibility', () => {
  test.each(['mcp://tool/', 'https://example.com/tool/search'])(
    'rejects non-canonical MCP tool resource %s',
    async (resource) => {
      const { accepts, server } = await createHarness()

      expect(() =>
        mpp(server, {
          accepts,
          resource: { url: resource },
          secretKey: 'test-secret-key-test-secret-key-32',
        } as never),
      ).toThrow('mcp://tool/{toolName}')
    },
  )

  test('advertises both protocols in one MCP payment error', async () => {
    const { tool } = await createHarness()
    await expect(tool({ query: 'mpp' }, {})).rejects.toMatchObject({
      code: -32042,
      data: {
        challenges: [
          expect.objectContaining({ intent: 'charge', method: 'tempo' }),
          expect.objectContaining({ intent: 'charge', method: 'evm' }),
        ],
        httpStatus: 402,
        x402: expect.objectContaining({ accepts: expect.any(Array) }),
      },
    })
  })

  test('completes an MPP tool call through the x402 resource server', async () => {
    const { calls, tool } = await createHarness()
    const sdkClient = {
      callTool: (parameters: {
        arguments?: Record<string, unknown>
        _meta?: Record<string, unknown>
      }) => tool((parameters.arguments ?? {}) as { query: string }, { _meta: parameters._meta }),
    }
    const client = McpClient.wrap(sdkClient as any, {
      methods: [
        evm.charge({
          account,
          authorization: { name: 'USDC', version: '2' },
          maxAtomicAmount: '1000000',
        }),
      ],
    })

    const result = await client.callTool({ arguments: { query: 'mpp' }, name: 'search' })

    expect(result.content).toEqual([{ text: 'result:mpp', type: 'text' }])
    expect(result.receipt?.reference).toBe(transaction)
    expect(calls).toEqual(['verify', 'settle'])
  })

  test('returns facilitator failures as valid MCP tool errors', async () => {
    const facilitator = {
      async getSupported() {
        throw new FacilitatorResponseError('facilitator unavailable')
      },
      async settle() {
        throw new Error('unreachable')
      },
      async verify() {
        throw new Error('unreachable')
      },
    }
    const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
    const paid = mpp(server, {
      accepts: [
        {
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
          maxTimeoutSeconds: 60,
          network,
          payTo: recipient,
          scheme: 'exact',
        },
      ],
      resource: { url: 'mcp://tool/search' },
      secretKey: 'test-secret-key-test-secret-key-32',
    })
    const tool = paid(async () => ({ content: [{ text: 'unreachable', type: 'text' }] }))

    const result = await tool({}, {})

    expect(result).toEqual({
      content: [{ text: 'facilitator unavailable', type: 'text' }],
      isError: true,
    })
  })
})
