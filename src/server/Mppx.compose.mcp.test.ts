import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { Credential, Errors, Mcp, Method, z } from 'mppx'
import { Mppx, Transport } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

const realm = 'example.test'
const secretKey = 'test-secret-key-test-secret-key-32'

function fixture() {
  const payments: string[] = []
  const method = Method.toServer(
    Method.from({
      name: 'test',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string(), currency: z.string() }),
      },
    }),
    {
      async verify({ credential }) {
        payments.push(credential.challenge.request.currency)
        if (credential.payload.token !== 'valid')
          throw new Errors.VerificationFailedError({ reason: 'Payment was declined' })
        return {
          method: 'test',
          reference: credential.challenge.request.currency,
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    },
  )
  return { method, payments }
}

describe('MCP composition', () => {
  test('preserves defaults for distinct methods sharing a wire key', async () => {
    const { method } = fixture()
    const first = { ...method, defaults: { currency: 'A' } } as const
    const second = { ...method, defaults: { currency: 'B' } } as const
    const server = Mppx.create({
      methods: [first, second],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    const offered = await server.compose([first, { amount: '1' }], [second, { amount: '1' }])({})
    expect(offered.status).toBe(402)
    if (offered.status !== 402) throw new Error()
    const data = offered.challenge.data as NonNullable<Mcp.ErrorObject['data']>
    expect(data.challenges.map((challenge) => challenge.request.currency)).toEqual(['A', 'B'])
  })

  test('SDK gathers all offers and settles only the chosen currency', async () => {
    const { method, payments } = fixture()
    const server = Mppx.create({
      methods: [method],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    const route = server.compose(
      [method, { amount: '1', currency: 'A' }],
      ['test/charge', { amount: '1', currency: 'B' }],
    )
    const offered = await route({ _meta: { trace: 'kept' } })
    expect(offered.status).toBe(402)
    if (offered.status !== 402) throw new Error()
    expect(offered.challenge).toBeInstanceOf(McpError)
    expect(offered.challenge.code).toBe(Mcp.paymentRequiredCode)
    const data = offered.challenge.data as NonNullable<Mcp.ErrorObject['data']>
    expect(data.challenges.map((challenge) => challenge.request.currency)).toEqual(['A', 'B'])
    expect(payments).toEqual([])

    const credential = Credential.from({
      challenge: data.challenges[1]!,
      payload: { token: 'valid' },
    })
    const paid = await route({ _meta: { [Mcp.credentialMetaKey]: credential } })
    expect(paid.status).toBe(200)
    expect(payments).toEqual(['B'])
    if (paid.status !== 200) throw new Error()
    const result = paid.withReceipt({
      content: [{ type: 'text', text: 'paid' }],
      _meta: { trace: 'kept' },
    })
    expect(result.content).toEqual([{ type: 'text', text: 'paid' }])
    expect(result._meta).toMatchObject({
      trace: 'kept',
      [Mcp.receiptMetaKey]: { challengeId: credential.challenge.id, reference: 'B' },
    })
  })

  test('SDK distinguishes offers with the same currency by amount and scope', async () => {
    const { method, payments } = fixture()
    const server = Mppx.create({
      methods: [method],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    const route = server.compose(
      [method, { amount: '1', currency: 'A', scope: 'first' }],
      [method, { amount: '2', currency: 'A', scope: 'second' }],
    )
    const offered = await route({})
    if (offered.status !== 402) throw new Error()
    const data = offered.challenge.data as NonNullable<Mcp.ErrorObject['data']>
    const paid = await route({
      _meta: {
        [Mcp.credentialMetaKey]: Credential.from({
          challenge: data.challenges[1]!,
          payload: { token: 'valid' },
        }),
      },
    })
    expect(paid.status).toBe(200)
    expect(payments).toEqual(['A'])
  })

  test('failed verification keeps its code and does not try another offer', async () => {
    const { method, payments } = fixture()
    const server = Mppx.create({
      methods: [method],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    const route = server.compose(
      [method, { amount: '1', currency: 'A' }],
      [method, { amount: '1', currency: 'B' }],
    )
    const offered = await route({})
    if (offered.status !== 402) throw new Error()
    const data = offered.challenge.data as NonNullable<Mcp.ErrorObject['data']>
    const result = await route({
      _meta: {
        [Mcp.credentialMetaKey]: Credential.from({
          challenge: data.challenges[1]!,
          payload: { token: 'declined' },
        }),
      },
    })
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.challenge.code).toBe(Mcp.paymentVerificationFailedCode)
    expect(result.challenge.data).toMatchObject({
      challenges: [{ request: { currency: 'B' } }],
      problem: { status: 402 },
    })
    expect(payments).toEqual(['B'])
  })

  test('malformed credentials keep the MCP invalid-params code', async () => {
    const { method, payments } = fixture()
    const server = Mppx.create({
      methods: [method],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    const result = await server.compose([method, { amount: '1', currency: 'A' }])({
      _meta: { [Mcp.credentialMetaKey]: 'invalid' as never },
    })
    if (result.status !== 402) throw new Error()
    expect(result.challenge.code).toBe(Mcp.invalidParamsCode)
    expect(payments).toEqual([])
  })

  test('JSON-RPC preserves the request ID and receipt metadata', async () => {
    const { method, payments } = fixture()
    const server = Mppx.create({ methods: [method], realm, secretKey, transport: Transport.mcp() })
    const route = server.compose(
      [method, { amount: '1', currency: 'A' }],
      [method, { amount: '1', currency: 'B' }],
    )
    const offered = await route({ id: 42, method: 'tools/call' })
    if (offered.status !== 402 || !offered.challenge.error?.data) throw new Error()
    expect(offered.challenge.id).toBe(42)
    expect(offered.challenge.error.data.challenges).toHaveLength(2)
    const credential = Credential.from({
      challenge: offered.challenge.error.data.challenges[1]!,
      payload: { token: 'valid' },
    })
    const result = await route({
      id: 43,
      method: 'tools/call',
      params: { _meta: { [Mcp.credentialMetaKey]: credential } },
    })
    if (result.status !== 200) throw new Error()
    const response = result.withReceipt({
      jsonrpc: '2.0',
      id: 43,
      result: { content: [], _meta: { trace: 'kept' } },
    })
    expect(response.id).toBe(43)
    expect(response.result?._meta).toMatchObject({
      trace: 'kept',
      [Mcp.receiptMetaKey]: { reference: 'B' },
    })
    expect(payments).toEqual(['B'])
  })

  test('rejects empty composition and incompatible method transports', () => {
    const { method } = fixture()
    const server = Mppx.create({
      methods: [method],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    expect(() => server.compose()).toThrow('compose() requires at least one entry')
    const mixed = Mppx.create({
      methods: [{ ...method, transport: Transport.http() }],
      realm,
      secretKey,
      transport: Transport.mcpSdk(),
    })
    expect(() => mixed.compose(['test/charge', { amount: '1', currency: 'A' }])).toThrow(
      'MCP compose() requires methods using the configured MCP transport',
    )
  })
})
