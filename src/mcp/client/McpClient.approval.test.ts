import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Mppx from '../../client/Mppx.js'
import * as Credential from '../../Credential.js'
import * as Mcp from '../../Mcp.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as McpClient from './McpClient.js'

const definition = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    request: z.object({ amount: z.string() }),
    credential: { payload: z.object({ payer: z.string() }) },
  },
})
afterEach(() => {
  Mppx.restore()
  vi.unstubAllGlobals()
})

test.each([false, true])(
  'ambient SDK transport honors adapter approval %s and payer context',
  async (approved) => {
    const challenge = Challenge.from({
      id: 'test',
      realm: 'api.example',
      method: 'test',
      intent: 'charge',
      request: { amount: '1' },
    })
    const createCredential = vi.fn(async ({ challenge, context }) =>
      Credential.serialize({ challenge, payload: { payer: context?.payer ?? 'global' } }),
    )
    const method = Method.toClient(definition, {
      context: z.object({ payer: z.optional(z.string()) }),
      createCredential,
    })
    const paid: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        if (!init?.body) return new Response(null, { status: 405 })
        const request = JSON.parse(String(init.body))
        if (request.id === undefined) return new Response(null, { status: 202 })
        const respond = (message: object) =>
          Response.json({ jsonrpc: '2.0', id: request.id, ...message })
        if (request.method === 'initialize')
          return respond({
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'test', version: '1' },
            },
          })
        const credential = request.params?._meta?.[Mcp.credentialMetaKey]
        if (credential) {
          paid.push(credential.payload)
          return respond({ result: { content: [{ type: 'text', text: 'ok' }] } })
        }
        return respond({
          error: {
            code: Mcp.paymentRequiredCode,
            message: 'Payment Required',
            data: { httpStatus: 402, challenges: [challenge] },
          },
        })
      }),
    )
    Mppx.create({ methods: [method] })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://api.example/mcp')) as Parameters<
        Client['connect']
      >[0],
    )
    try {
      const wrapped = McpClient.wrap(client, { methods: [method] })
      const approval = vi.fn(() => approved)
      const result = wrapped.callTool({ name: 'paid' }, undefined, {
        context: { payer: 'selected' },
        onPaymentRequired: approval,
      })
      if (approved) {
        await result
        expect(paid).toEqual([{ payer: 'selected' }])
        expect(createCredential).toHaveBeenCalledOnce()
      } else {
        await expect(result).rejects.toThrow('Payment declined')
        expect(createCredential).not.toHaveBeenCalled()
        expect(paid).toEqual([])
      }
      expect(approval).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  },
)
