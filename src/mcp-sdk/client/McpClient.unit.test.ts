import { Credential, Mcp as core_Mcp, Method } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as McpClient from './McpClient.js'

const challenge = {
  id: 'test-challenge',
  intent: 'charge',
  method: 'tempo',
  realm: 'api.example.com',
  request: {
    amount: '0',
  },
}

describe('McpClient.wrap', () => {
  test('handles MCP SDK structured payment-required tool results', async () => {
    const createCredential = vi.fn(async ({ challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'proof' },
      }),
    )
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        structuredContent: { httpStatus: 402, challenges: [challenge] },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ httpStatus: 402, challenges: [challenge] }),
          },
        ],
        isError: true,
      })
      .mockResolvedValueOnce({
        _meta: {
          [core_Mcp.receiptMetaKey]: {
            challengeId: challenge.id,
            method: 'tempo',
            reference: challenge.id,
            status: 'success',
            timestamp: '2026-06-08T00:00:00.000Z',
          },
        },
        content: [{ type: 'text', text: 'paid result' }],
      })

    const mcp = McpClient.withMppClient(
      { callTool },
      {
        methods: [Method.toClient(Methods.charge, { createCredential })],
      },
    )

    const result = await mcp.callTool({ name: 'paid_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'paid result' }])
    expect(result.receipt?.status).toBe('success')
    expect(createCredential).toHaveBeenCalledWith({ challenge })
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(callTool.mock.calls[1]?.[0]._meta?.[core_Mcp.credentialMetaKey]).toMatchObject({
      challenge,
      payload: { signature: '0xsignature', type: 'proof' },
    })
  })

  test('ignores non-payment tool errors', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ordinary tool error' }],
      isError: true,
    })

    const mcp = McpClient.wrap(
      { callTool },
      {
        methods: [
          Method.toClient(Methods.charge, {
            createCredential: vi.fn(),
          }),
        ],
      },
    )

    const result = await mcp.callTool({ name: 'broken_tool', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'ordinary tool error' }])
    expect(result.receipt).toBeUndefined()
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})
