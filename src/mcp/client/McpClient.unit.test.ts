import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { Challenge, Credential, Mcp as core_Mcp, Method } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as Budget from '../../client/Budget.js'
import {
  PaymentExpiredError,
  PaymentLimitExceededError,
  ZoneSettlementPendingError,
} from '../../Errors.js'
import * as McpClient from './McpClient.js'

describe('MCP client spending options', () => {
  const pathUsd = '0x20c0000000000000000000000000000000000000'
  const offer = (amount: string, intent = 'charge', expires?: string) =>
    Challenge.from({
      id: `${intent}-${amount}`,
      intent,
      method: 'tempo',
      realm: 'api.example.com',
      ...(expires ? { expires } : {}),
      request: {
        amount,
        currency: pathUsd,
        recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        methodDetails: { chainId: 4217 },
      },
    })
  /** A server asking for `challenge` until a call carries a credential. */
  const server = (challenge: Challenge.Challenge) =>
    vi.fn(async (params: { _meta?: Record<string, unknown> }) => {
      if (!params._meta?.[core_Mcp.credentialMetaKey])
        throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
          challenges: [challenge],
          httpStatus: 402,
        })
      return { content: [{ type: 'text', text: 'ok' }] }
    })
  const setup = (
    challenge: Challenge.Challenge,
    options: Pick<
      McpClient.wrap.Config,
      'authorize' | 'funders' | 'maxPayment' | 'trustedTempoProofRealms'
    > = {},
  ) => {
    const callTool = server(challenge)
    const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
      Credential.serialize({
        challenge,
        payload: { signature: '0xsignature', type: 'transaction' },
      }),
    )
    const mcp = McpClient.wrap({ callTool } as unknown as Pick<Client, 'callTool'>, {
      ...options,
      methods: [
        Method.toClient(
          Method.from({ name: 'tempo', intent: challenge.intent, schema: Methods.charge.schema }),
          { createCredential },
        ),
      ],
    })
    return { callTool, createCredential, mcp }
  }

  test('error: refuses a payment over maxPayment before signing', async () => {
    const { callTool, createCredential, mcp } = setup(offer('2000000'), {
      maxPayment: { value: '1', currency: 'USD' },
    })

    const error = await mcp.callTool({ name: 'paid_tool' }).catch((error) => error)

    expect(error).toBeInstanceOf(PaymentLimitExceededError)
    expect(error).toMatchObject({ limit: 'maxPayment', reason: 'amount' })
    expect(createCredential).not.toHaveBeenCalled()
    expect(callTool).toHaveBeenCalledOnce()
  })

  test('behavior: counts payments against a budget and funds them before signing', async () => {
    const steps: string[] = []
    const budget = Budget.create({ total: { value: '1.5', currency: 'USD' } })
    const { createCredential, mcp } = setup(offer('1000000'), {
      authorize: budget,
      funders: [{ fund: async () => void steps.push('fund') }],
    })
    createCredential.mockImplementation(async ({ challenge }) => {
      steps.push('sign')
      return Credential.serialize({ challenge, payload: { signature: '0x', type: 'transaction' } })
    })

    expect((await mcp.callTool({ name: 'paid_tool' })).content).toEqual([
      { type: 'text', text: 'ok' },
    ])
    await expect(mcp.callTool({ name: 'paid_tool' })).rejects.toMatchObject({
      limit: 'budget',
      reason: 'amount',
    })

    expect(steps).toEqual(['fund', 'sign'])
    expect(budget.spent()).toEqual({ value: '1', currency: 'USD' })
    expect(budget.reserved()).toEqual({ value: '0', currency: 'USD' })
  })

  test('error: refuses sessions and a challenge that expires while authorize runs', async () => {
    const authorize = vi.fn()
    const session = setup(offer('1', 'session'), {
      authorize,
      trustedTempoProofRealms: ['api.example.com'],
    })
    await expect(session.mcp.callTool({ name: 'paid_tool' })).rejects.toMatchObject({
      reason: 'intent',
    })
    expect(session.createCredential).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()

    const expires = new Date(Date.now() + 60_000).toISOString()
    const release = vi.fn()
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      const expiring = setup(offer('1', 'charge', expires), {
        authorize: async () => {
          vi.setSystemTime(new Date(expires).getTime() + 1)
          return { commit: vi.fn(), release }
        },
      })
      await expect(expiring.mcp.callTool({ name: 'paid_tool' })).rejects.toBeInstanceOf(
        PaymentExpiredError,
      )
      expect(expiring.createCredential).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test('default: without spending options, any amount is paid as before', async () => {
    const { callTool, createCredential, mcp } = setup(offer('5000000000'))

    await mcp.callTool({ name: 'paid_tool' })

    expect(createCredential).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  test('error: rejects invalid spending options at wrap()', () => {
    expect(() =>
      setup(offer('1'), { maxPayment: { value: 'one', currency: 'USD' } as never }),
    ).toThrow(TypeError)
  })
})

describe('MCP client payment approval', () => {
  test('stops resuming a pending Zone settlement once the call is aborted', async () => {
    const challenge = Challenge.from({
      id: 'abort-test',
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
    const controller = new AbortController()
    const reason = new Error('aborted by caller')
    const createCredential = vi.fn(async (): Promise<string> => {
      controller.abort(reason)
      throw new ZoneSettlementPendingError({ challengeId: challenge.id, zoneId: 3 })
    })
    const mcp = McpClient.wrap(client as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })

    await expect(
      mcp.callTool({ name: 'paid_tool', arguments: {} }, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
    expect(createCredential).toHaveBeenCalledOnce()
  })

  test('does not create a credential after cancellation during approval', async () => {
    const challenge = Challenge.from({
      id: 'cancel-approval',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: {},
    })
    const callTool = vi.fn(async () => {
      throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
        challenges: [challenge],
        httpStatus: 402,
      })
    })
    const controller = new AbortController()
    const reason = new Error('cancelled during approval')
    const createCredential = vi.fn(async () => 'unexpected credential')
    const mcp = McpClient.wrap({ callTool } as unknown as Pick<Client, 'callTool'>, {
      methods: [Method.toClient(Methods.charge, { createCredential })],
    })
    await expect(
      mcp.callTool({ name: 'paid_tool' }, undefined, {
        signal: controller.signal,
        onPaymentRequired: async () => {
          await Promise.resolve()
          controller.abort(reason)
          return true
        },
      }),
    ).rejects.toBe(reason)
    expect(createCredential).not.toHaveBeenCalled()
    expect(callTool).toHaveBeenCalledOnce()
  })

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

describe('MCP client challenge credential header', () => {
  const challenge = (id: string) =>
    Challenge.from({ id, intent: 'charge', method: 'tempo', realm: 'api.example.com', request: {} })

  function setup(challenges: readonly unknown[]) {
    const calls: { _meta?: Record<string, unknown> }[] = []
    const client = {
      async callTool(params: { _meta?: Record<string, unknown> }) {
        calls.push(params)
        if (calls.length === 1)
          throw new McpError(core_Mcp.paymentRequiredCode, 'Payment Required', {
            challenges,
            httpStatus: 402,
          })
        return { content: [{ type: 'text', text: 'ok' }] }
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
    return { calls, createCredential, mcp }
  }

  test.each(['Authorization', 'X-Payment'])(
    'pays the valid challenge when another selects the credential header "%s"',
    async (header) => {
      const { calls, createCredential, mcp } = setup([
        { ...challenge('unsupported'), header },
        challenge('valid'),
      ])

      const result = await mcp.callTool({ name: 'paid_tool', arguments: {} })

      expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
      expect(createCredential).toHaveBeenCalledOnce()
      expect(createCredential.mock.calls[0]![0].challenge.id).toBe('valid')
      expect(calls).toHaveLength(2)
    },
  )

  test.each(['Authorization', 'X-Payment'])(
    'creates no credential when the only challenge selects the credential header "%s"',
    async (header) => {
      const { calls, createCredential, mcp } = setup([{ ...challenge('unsupported'), header }])

      await expect(mcp.callTool({ name: 'paid_tool', arguments: {} })).rejects.toThrow(
        'No compatible payment method. Server offers: . Client has: tempo.charge. Skipped 1 challenge that selects a credential header other than Payment-Authorization',
      )
      expect(createCredential).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
    },
  )

  test('does not treat a malformed challenge with another credential header as payment required', async () => {
    const { id: _, ...malformed } = challenge('malformed')
    const { calls, createCredential, mcp } = setup([
      { ...malformed, header: 'X-Payment' },
      challenge('valid'),
    ])

    const error = await mcp.callTool({ name: 'paid_tool', arguments: {} }).catch((e) => e)

    expect(error).toBeInstanceOf(McpError)
    expect(error.code).toBe(core_Mcp.paymentRequiredCode)
    expect(createCredential).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })
})
