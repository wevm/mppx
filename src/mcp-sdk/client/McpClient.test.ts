import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { Challenge, Mcp as core_Mcp } from 'mppx'
import { tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { createClient } from 'viem'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { accounts, asset, chain, http, client as testClient } from '~test/tempo/viem.js'
import * as McpServer_transport from '../server/Transport.js'
import * as McpClient from './McpClient.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

describe('McpClient.wrap', () => {
  let client: Client
  let server: McpServer
  let clientTransport: InstanceType<typeof InMemoryTransport>
  let serverTransport: InstanceType<typeof InMemoryTransport>

  const mppxServer = Mppx_server.create({
    methods: [
      tempo_server.charge({
        getClient: () => testClient,
      }),
    ],
    realm,
    secretKey,
    transport: McpServer_transport.mcpSdk(),
  })

  beforeEach(async () => {
    ;[clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    client = new Client({ name: 'test-client', version: '1.0.0' })
    server = new McpServer({ name: 'test-server', version: '1.0.0' })

    server.registerTool(
      'premium_tool',
      { description: 'A tool that requires payment' },
      async (extra) => {
        const result = await mppxServer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        })(extra)

        if (result.status === 402) throw result.challenge

        return result.withReceipt({
          content: [{ type: 'text' as const, text: 'Premium tool executed' }],
        })
      },
    )

    server.registerTool('free_tool', { description: 'A free tool' }, async () => {
      return { content: [{ type: 'text' as const, text: 'Free tool executed' }] }
    })

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await Promise.all([client.close(), server.close()])
  })

  test('default: handles payment and returns result with receipt', async () => {
    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          account: accounts[1],
          getClient: () => testClient,
        }),
      ],
    })

    const result = await mcp.callTool({ name: 'premium_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'Premium tool executed' }])
    expect(result.isError).toBeUndefined()
    expect(result.receipt).toBeDefined()
    expect(result.receipt?.status).toBe('success')
    expect(result.receipt?.method).toBe('tempo')
  })

  test('default: account via context', async () => {
    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          getClient: () => testClient,
        }),
      ],
    })

    const result = await mcp.callTool(
      { name: 'premium_tool', arguments: {} },
      { context: { account: accounts[1] } },
    )

    expect(result.content).toEqual([{ type: 'text', text: 'Premium tool executed' }])
    expect(result.receipt?.status).toBe('success')
  })

  test('behavior: passes through when no payment required', async () => {
    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          account: accounts[1],
          getClient: () => testClient,
        }),
      ],
    })

    const result = await mcp.callTool({ name: 'free_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'Free tool executed' }])
    expect(result.receipt).toBeUndefined()
  })

  test('behavior: throws when no account provided', async () => {
    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          getClient: () => createClient({ chain, transport: http() }),
        }),
      ],
    })

    await expect(mcp.callTool({ name: 'premium_tool', arguments: {} })).rejects.toThrow(
      'No `account` provided',
    )
  })

  test('error: returns isError for non-payment errors', async () => {
    server.registerTool('broken_tool', { description: 'Broken' }, async () => {
      throw new Error('Internal server error')
    })

    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          account: accounts[1],
          getClient: () => testClient,
        }),
      ],
    })

    const result = await mcp.callTool({ name: 'broken_tool', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Internal server error' }])
  })

  test('error: throws when method not found', async () => {
    const challenge = Challenge.fromIntent(tempo_server.charge({ getClient: () => testClient }), {
      realm,
      secretKey,
      request: {
        amount: '1',
        currency: asset,
        decimals: 6,
        expires: new Date(Date.now() + 60_000).toISOString(),
        recipient: accounts[0].address,
      },
    })

    server.registerTool('tool_unknown_method', { description: 'Tool' }, async () => {
      throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
        httpStatus: 402,
        challenges: [{ ...challenge, method: 'unknown_method' }],
      })
    })

    const mcp = McpClient.wrap(client, {
      methods: [
        tempo_client.charge({
          account: accounts[1],
          getClient: () => testClient,
        }),
      ],
    })

    await expect(mcp.callTool({ name: 'tool_unknown_method', arguments: {} })).rejects.toThrow(
      'No compatible payment method. Server offers: unknown_method.charge. Client has: tempo.charge',
    )
  })
})

describe('isPaymentRequiredError', () => {
  test('returns true for McpError with payment code and challenges', () => {
    const error = new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
      httpStatus: 402,
      challenges: [{ id: 'test', method: 'tempo', intent: 'charge', realm: 'test', request: {} }],
    })
    expect(McpClient.isPaymentRequiredError(error)).toBe(true)
  })

  test('returns false for McpError with wrong code', () => {
    const error = new McpError(-32600, 'Invalid Request', {
      challenges: [{ id: 'test', method: 'tempo' }],
    })
    expect(McpClient.isPaymentRequiredError(error)).toBe(false)
  })

  test('returns false for McpError without challenges', () => {
    const error = new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
      httpStatus: 402,
    })
    expect(McpClient.isPaymentRequiredError(error)).toBe(false)
  })

  test('returns false for non-McpError', () => {
    expect(McpClient.isPaymentRequiredError(null)).toBe(false)
    expect(McpClient.isPaymentRequiredError(new Error('test'))).toBe(false)
    expect(McpClient.isPaymentRequiredError('error')).toBe(false)
  })
})
