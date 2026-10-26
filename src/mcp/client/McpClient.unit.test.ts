import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { Challenge, Credential, Mcp as core_Mcp, Method } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as McpClient from './McpClient.js'

describe('MCP client payment approval', () => {
  test('calls an approval hook before creating a credential', async () => {
    const challenge = Challenge.from({
      id: 'approval-test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: {},
    })
    const calls: unknown[] = []
    const client = {
      async callTool(params: unknown) {
        calls.push(params)
        if (calls.length === 1)
          throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
            challenges: [challenge],
            httpStatus: 402,
          })
        return {
          _meta: {
            [core_Mcp.receiptMetaKey]: {
              method: 'tempo',
              reference: 'test',
              status: 'success',
              timestamp: new Date().toISOString(),
            },
          },
          content: [{ type: 'text', text: 'ok' }],
        }
      },
    }
    const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const onPaymentRequired = vi.fn(() => true)
    const mcp = McpClient.wrap(client as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    const result = await mcp.callTool({ name: 'paid_tool', arguments: {} }, undefined, {
      onPaymentRequired,
    })

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(onPaymentRequired).toHaveBeenCalledWith(challenge)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
  })

  test('does not create a credential when approval is denied', async () => {
    const challenge = Challenge.from({
      id: 'denied-test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: {},
    })
    const client = {
      async callTool() {
        throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
          challenges: [challenge],
          httpStatus: 402,
        })
      },
    }
    const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const mcp = McpClient.wrap(client as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    await expect(
      mcp.callTool({ name: 'paid_tool' }, undefined, { onPaymentRequired: () => false }),
    ).rejects.toThrow('Payment declined.')
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('allows null to bypass a config approval hook', async () => {
    const challenge = Challenge.from({
      id: 'null-bypass-test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: {},
    })
    let calls = 0
    const client = {
      async callTool() {
        calls += 1
        if (calls === 1)
          throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
            challenges: [challenge],
            httpStatus: 402,
          })
        return {
          content: [{ type: 'text', text: 'ok' }],
        }
      },
    }
    const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const onPaymentRequired = vi.fn(() => false)
    const mcp = McpClient.wrap(client as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
      onPaymentRequired,
    })

    await expect(
      mcp.callTool({ name: 'paid_tool' }, undefined, { onPaymentRequired: null }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(onPaymentRequired).not.toHaveBeenCalled()
    expect(createCredential).toHaveBeenCalledOnce()
  })
})

describe('MCP client zero-amount Tempo proofs', () => {
  function setup(trustedTempoProofRealms?: readonly string[]) {
    const challenge = Challenge.from({
      id: 'proof-test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: { amount: '0' },
    })
    let calls = 0
    const client = {
      async callTool() {
        calls++
        if (calls === 1)
          throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
            challenges: [challenge],
            httpStatus: 402,
          })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'proof' },
      }),
    )
    const mcp = McpClient.wrap(client as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
      ...(trustedTempoProofRealms && { trustedTempoProofRealms }),
    })
    return { createCredential, mcp }
  }

  test('refuses a realm that is not trusted', async () => {
    const { createCredential, mcp } = setup()

    await expect(mcp.callTool({ name: 'auth_tool' })).rejects.toThrow(
      'Refusing to sign Tempo proof for untrusted realm "api.example.com"',
    )
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('signs for a trusted realm', async () => {
    const { createCredential, mcp } = setup(['api.example.com'])

    const result = await mcp.callTool({ name: 'auth_tool' })
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(createCredential).toHaveBeenCalledOnce()
  })
})
