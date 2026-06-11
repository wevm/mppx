import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { Challenge, Credential, Errors, Mcp as core_Mcp, Method } from 'mppx'
import { tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Methods } from 'mppx/tempo'
import { createClient } from 'viem'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vp/test'
import { accounts, asset, chain, http, client as testClient } from '~test/tempo/viem.js'

import * as McpServer_transport from '../server/Transport.js'
import * as McpClient from './McpClient.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

function createChallenge() {
  return Challenge.fromMethod(Methods.charge, {
    realm,
    secretKey,
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: {
      amount: '1',
      currency: asset,
      decimals: 6,
      recipient: accounts[0].address,
    },
  })
}

function createReceipt(challenge: Challenge.Challenge): core_Mcp.Receipt {
  return {
    challengeId: challenge.id,
    method: 'tempo',
    reference: 'test',
    status: 'success',
    timestamp: new Date().toISOString(),
  }
}

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

    const result = await mcp.callTool({ name: 'premium_tool', arguments: {} }, undefined, {
      context: { account: accounts[1] },
    })

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

  test('behavior: does not forward empty options', async () => {
    const rawCallTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Free tool executed' }],
    }))
    const mcp = McpClient.wrap(
      { callTool: rawCallTool as Client['callTool'] },
      { methods: [Method.toClient(Methods.charge, { createCredential: vi.fn() })] },
    )

    const result = await mcp.callTool({ name: 'free_tool', arguments: {} }, undefined, {})

    expect(result.content).toEqual([{ type: 'text', text: 'Free tool executed' }])
    expect(rawCallTool).toHaveBeenCalledWith(
      { name: 'free_tool', arguments: {} },
      undefined,
      undefined,
    )
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
    const challenge = Challenge.fromMethod(tempo_server.charge({ getClient: () => testClient }), {
      realm,
      secretKey,
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: {
        amount: '1',
        currency: asset,
        decimals: 6,
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

  test('behavior: rejects expired challenges before creating credential', async () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      realm,
      secretKey,
      expires: new Date(Date.now() - 60_000).toISOString(),
      request: {
        amount: '1',
        currency: asset,
        decimals: 6,
        recipient: accounts[0].address,
      },
    })

    server.registerTool('expired_tool', { description: 'Tool' }, async () => {
      throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
        httpStatus: 402,
        challenges: [challenge],
      })
    })

    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const mcp = McpClient.wrap(client, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    await expect(mcp.callTool({ name: 'expired_tool', arguments: {} })).rejects.toThrow(
      Errors.PaymentExpiredError,
    )
    expect(createCredential).not.toHaveBeenCalled()
  })
})

describe('McpClient.wrap (in-place)', () => {
  test('default: mutates the existing client and handles payment', async () => {
    const challenge = createChallenge()
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const rawCallTool = vi
      .fn()
      .mockRejectedValueOnce(
        new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
          httpStatus: 402,
          challenges: [challenge],
        }),
      )
      .mockResolvedValueOnce({
        _meta: { [core_Mcp.receiptMetaKey]: createReceipt(challenge) },
        content: [{ type: 'text', text: 'Premium tool executed' }],
      })
    const fakeClient = { callTool: rawCallTool as Client['callTool'] }

    const wrapped = McpClient.wrap(fakeClient, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    expect(wrapped).toBe(fakeClient)

    const result = await wrapped.callTool({ name: 'premium_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'Premium tool executed' }])
    expect(result.isError).toBeUndefined()
    expect(result.receipt).toBeDefined()
    expect(result.receipt?.status).toBe('success')
    expect(rawCallTool).toHaveBeenCalledTimes(2)
    expect(createCredential).toHaveBeenCalledOnce()
  })

  test('behavior: preserves the MCP SDK callTool argument shape', async () => {
    const rawCallTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Free tool executed' }],
    }))
    const createCredential = vi.fn()
    const fakeClient = { callTool: rawCallTool as Client['callTool'] }

    const wrapped = McpClient.wrap(fakeClient, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    const result = await wrapped.callTool({ name: 'free_tool', arguments: {} }, undefined, {
      timeout: 30_000,
    })

    expect(result.content).toEqual([{ type: 'text', text: 'Free tool executed' }])
    expect(result.receipt).toBeUndefined()
    expect(rawCallTool).toHaveBeenCalledWith({ name: 'free_tool', arguments: {} }, undefined, {
      timeout: 30_000,
    })
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('behavior: strips payment context from MCP SDK request options', async () => {
    const rawCallTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Free tool executed' }],
    }))
    const fakeClient = { callTool: rawCallTool as Client['callTool'] }

    const wrapped = McpClient.wrap(fakeClient, {
      methods: [tempo_client({})],
    })

    await wrapped.callTool({ name: 'free_tool', arguments: {} }, undefined, {
      context: { account: accounts[1] },
      timeout: 30_000,
    })

    expect(rawCallTool).toHaveBeenCalledWith({ name: 'free_tool', arguments: {} }, undefined, {
      timeout: 30_000,
    })
  })

  test('behavior: re-wrapping replaces config without stacking wrappers', async () => {
    const challenge = createChallenge()

    const rawCallTool = vi
      .fn()
      .mockRejectedValueOnce(
        new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
          httpStatus: 402,
          challenges: [challenge],
        }),
      )
      .mockResolvedValueOnce({
        _meta: { [core_Mcp.receiptMetaKey]: createReceipt(challenge) },
        content: [{ type: 'text', text: 'paid' }],
      })

    const fakeClient = { callTool: rawCallTool as Client['callTool'] }
    const staleCreateCredential = vi.fn(async () => {
      throw new Error('stale config used')
    })
    const freshCreateCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )

    McpClient.wrap(fakeClient, {
      methods: [Method.toClient(Methods.charge, { createCredential: staleCreateCredential })],
    })
    const wrapped = McpClient.wrap(fakeClient, {
      methods: [Method.toClient(Methods.charge, { createCredential: freshCreateCredential })],
    })

    const result = await wrapped.callTool({ name: 'premium_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'paid' }])
    expect(result.receipt?.status).toBe('success')
    expect(staleCreateCredential).not.toHaveBeenCalled()
    expect(freshCreateCredential).toHaveBeenCalledOnce()
    expect(rawCallTool).toHaveBeenCalledTimes(2)
  })

  test('behavior: handles payment challenge metadata returned as a tool result', async () => {
    const challenge = createChallenge()
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const rawCallTool = vi
      .fn()
      .mockResolvedValueOnce({
        _meta: {
          [core_Mcp.paymentRequiredMetaKey]: {
            challenges: [challenge],
            httpStatus: 402,
          },
        },
        content: [{ type: 'text', text: 'Payment Required' }],
        isError: true,
      })
      .mockResolvedValueOnce({
        _meta: { [core_Mcp.receiptMetaKey]: createReceipt(challenge) },
        content: [{ type: 'text', text: 'Premium tool executed' }],
      })

    const wrapped = McpClient.wrap(
      { callTool: rawCallTool as Client['callTool'] },
      { methods: [Method.toClient(Methods.charge, { createCredential })] },
    )

    const result = await wrapped.callTool({ name: 'premium_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'Premium tool executed' }])
    expect(result.receipt?.status).toBe('success')
    expect(createCredential).toHaveBeenCalledOnce()
    expect(rawCallTool).toHaveBeenCalledTimes(2)
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
