import { createClient, custom, encodeFunctionResult, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Constants from '../../Constants.js'
import * as Credential from '../../Credential.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { entryKey, type ChannelStore } from '../../tempo/session/client/ChannelStore.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import * as Channel from '../../tempo/session/precompile/Channel.js'
import { escrowAbi } from '../../tempo/session/precompile/escrow.abi.js'
import {
  createSessionReceipt,
  formatNeedVoucherEvent,
  serializeSessionReceipt,
  tip20ChannelEscrow,
  type ChannelDescriptor,
  type NeedVoucherEvent,
  type SessionCredentialPayload,
} from '../../tempo/session/precompile/Protocol.js'
import type { SessionSnapshot } from '../../tempo/session/Snapshot.js'
import { closeWithSessionManager, requestWithSessionManager } from './Manager.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const client = createClient({
  account,
  chain: { id: 4217 } as never,
  transport: custom({
    async request(args) {
      throw new Error(`unexpected RPC request: ${args.method}`)
    },
  }),
})
const transactionClient = createClient({
  account,
  chain: { id: 4217 } as never,
  transport: custom({
    async request(args) {
      if (args.method === 'eth_chainId') return '0x1079'
      if (args.method === 'eth_getTransactionCount') return '0x0'
      if (args.method === 'eth_estimateGas') return '0x5208'
      if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
      if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
      if (args.method === 'eth_call')
        return encodeFunctionResult({
          abi: escrowAbi,
          functionName: 'getChannelState',
          result: { settled: 0n, deposit: 1n, closeRequestedAt: 0 },
        })
      throw new Error(`unexpected RPC request: ${args.method}`)
    },
  }),
})
const descriptor: ChannelDescriptor = {
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'11'.repeat(32)}` as Hex,
  operator: '0x0000000000000000000000000000000000000000',
  payee: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
  payer: account.address,
  salt: `0x${'22'.repeat(32)}` as Hex,
  token: '0x20c0000000000000000000000000000000000001',
}
const channelId = Channel.computeId({
  ...descriptor,
  chainId: 4217,
  escrow: tip20ChannelEscrow,
})

function channelEntry(): ChannelEntry {
  return {
    channelId,
    chainId: 4217,
    cumulativeAmount: 1n,
    deposit: 10n,
    descriptor,
    escrow: tip20ChannelEscrow,
    opened: true,
  }
}

function challengeResponse(
  id = 'challenge-1',
  snapshot?: SessionSnapshot,
  requestOverrides: Record<string, unknown> = {},
): {
  challenge: TempoSessionChallenge
  response: Response
} {
  const challenge = Challenge.from({
    id,
    intent: Constants.Intents.session,
    method: Constants.Methods.tempo,
    realm: 'api.example.test',
    request: {
      amount: '1',
      currency: descriptor.token,
      decimals: 0,
      methodDetails: {
        chainId: 4217,
        escrowContract: tip20ChannelEscrow,
        sessionProtocol: Constants.SessionProtocols.v2,
        ...(snapshot && { [Constants.MethodDetailKeys.sessionSnapshot]: snapshot }),
      },
      recipient: descriptor.payee,
      unitType: 'request',
      ...requestOverrides,
    },
  }) as TempoSessionChallenge
  return {
    challenge,
    response: new Response(null, {
      status: 402,
      headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) },
    }),
  }
}

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    acceptedCumulative: '4',
    chainId: 4217,
    channelId,
    deposit: '10',
    descriptor,
    escrow: tip20ChannelEscrow,
    requiredCumulative: '4',
    settled: '0',
    spent: '4',
    units: 2,
    ...overrides,
  }
}

function channelStore(entry = channelEntry()) {
  const channels = new Map([[entryKey(entry), entry]])
  const remove = vi.fn((key: string) => {
    channels.delete(key)
  })
  const store: ChannelStore = {
    delete: remove,
    get: (key) => channels.get(key),
    set(next) {
      channels.set(entryKey(next), next)
    },
  }
  return { remove, store }
}

function credentialPayload(init: RequestInit | undefined): SessionCredentialPayload | undefined {
  const authorization = new Headers(init?.headers).get(Constants.Headers.authorization)
  if (!authorization) return undefined
  return Credential.deserialize<SessionCredentialPayload>(authorization).payload
}

function managerParameters(store: ChannelStore) {
  return {
    account,
    channelStore: store,
    client,
    decimals: 0,
    maxDeposit: '10',
  }
}

describe('CLI session manager adapter', () => {
  test('replays the selected 402 and performs one ordinary paid request', async () => {
    const { challenge, response: initialResponse } = challengeResponse()
    const { store } = channelStore()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = credentialPayload(init)
      expect(payload).toMatchObject({
        action: 'voucher',
        channelId,
        cumulativeAmount: '2',
      })
      return new Response('paid body', {
        headers: {
          [Constants.Headers.paymentReceipt]: serializeSessionReceipt(
            createSessionReceipt({
              acceptedCumulative: 2n,
              challengeId: challenge.id,
              channelId,
              spent: 2n,
              units: 1,
            }),
          ),
        },
      })
    })

    const result = await requestWithSessionManager({
      challengeResponse: initialResponse,
      fetch,
      input: 'https://api.example.test/resource?chainId=testnet',
      manager: managerParameters(store),
    })

    expect(result.kind).toBe('response')
    expect(await result.response.text()).toBe('paid body')
    expect(result.manager.cumulative).toBe(2n)
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('rehydrates and persists a top-up before reusing a durable channel', async () => {
    const { challenge, response: initialResponse } = challengeResponse()
    let stored = channelEntry()
    stored.deposit = 1n
    const set = vi.fn((entry: ChannelEntry) => {
      stored = structuredClone(entry)
    })
    const store: ChannelStore = {
      delete: vi.fn(),
      get: () => structuredClone(stored),
      set,
    }
    const posted: SessionCredentialPayload[] = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = credentialPayload(init)
      if (!payload) throw new Error('expected session credential')
      posted.push(payload)
      if (payload.action === 'topUp') return new Response(null, { status: 204 })
      if (payload.action !== 'voucher') throw new Error('expected voucher credential')
      expect(new Headers(init?.headers).get(Constants.Headers.paymentSession)).toBe(channelId)
      return new Response('paid body', {
        headers: {
          [Constants.Headers.paymentReceipt]: serializeSessionReceipt(
            createSessionReceipt({
              acceptedCumulative: 2n,
              challengeId: challenge.id,
              channelId,
              spent: 2n,
              units: 1,
            }),
          ),
        },
      })
    })

    const result = await requestWithSessionManager({
      challengeResponse: initialResponse,
      fetch,
      input: 'https://api.example.test/resource?chainId=testnet',
      manager: {
        account,
        channelStore: store,
        client: transactionClient,
        decimals: 0,
        maxDeposit: '10',
      },
      resume: { channel: structuredClone(stored), challenge, spent: 1n },
    })

    expect(posted).toMatchObject([
      { action: 'topUp', additionalDeposit: '1', channelId },
      { action: 'voucher', cumulativeAmount: '2', channelId },
    ])
    expect(stored).toMatchObject({ cumulativeAmount: 2n, deposit: 2n })
    expect(set).toHaveBeenCalledTimes(2)
    expect(result.manager.channelId).toBe(channelId)
  })

  test('consumes the paid SSE response without a second resource request', async () => {
    const { challenge, response: initialResponse } = challengeResponse()
    const { store } = channelStore()
    const receipt = createSessionReceipt({
      acceptedCumulative: 3n,
      challengeId: challenge.id,
      channelId,
      spent: 3n,
      units: 2,
    })
    const needVoucher: NeedVoucherEvent = {
      acceptedCumulative: '2',
      channelId,
      deposit: '10',
      requiredCumulative: '3',
    }
    const resourceUrl = 'https://api.example.test/stream?chainId=testnet'
    const resourceRequests: string[] = []
    const posted: SessionCredentialPayload[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const payload = credentialPayload(init)
      if (payload) posted.push(payload)
      if (init?.method === 'POST') return new Response(null, { status: 204 })

      resourceRequests.push(input.toString())
      return new Response(
        [
          'event: message\ndata: first\n\n',
          formatNeedVoucherEvent(needVoucher),
          'event: message\ndata: second\n\n',
          `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`,
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const onReceipt = vi.fn()

    const result = await requestWithSessionManager({
      challengeResponse: initialResponse,
      fetch,
      init: { onReceipt },
      input: resourceUrl,
      manager: managerParameters(store),
    })
    if (result.kind !== 'event-stream') throw new Error('expected event stream')

    const messages: string[] = []
    for await (const message of result.stream) messages.push(message)

    expect(messages).toEqual(['first', 'second'])
    expect(resourceRequests).toEqual([resourceUrl])
    expect(posted).toMatchObject([
      { action: 'voucher', cumulativeAmount: '2' },
      { action: 'voucher', cumulativeAmount: '3' },
    ])
    expect(onReceipt).toHaveBeenCalledWith(receipt)
    expect(result.manager.state).toMatchObject({ status: 'active', spent: '3', units: 2 })
  })

  test('rehydrates durable context and closes at receipt-confirmed spend', async () => {
    const { challenge } = challengeResponse()
    const entry = channelEntry()
    entry.cumulativeAmount = 5n
    const refreshed = challengeResponse('challenge-2', sessionSnapshot())
    const { remove, store } = channelStore(entry)
    const closeUrl = 'https://api.example.test/resource?chainId=testnet'
    let closeRequests = 0
    const closeAmounts: string[] = []
    const onChallenge = vi.fn()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(closeUrl)
      expect(init?.method).toBe('POST')
      const payload = credentialPayload(init)
      if (payload?.action !== 'close') throw new Error('expected close credential')
      expect(payload.channelId).toBe(channelId)
      closeAmounts.push(payload.cumulativeAmount)
      closeRequests++
      if (closeRequests === 1) return refreshed.response
      return new Response(null, {
        headers: {
          [Constants.Headers.paymentReceipt]: serializeSessionReceipt(
            createSessionReceipt({
              acceptedCumulative: 4n,
              challengeId: refreshed.challenge.id,
              channelId,
              spent: 4n,
              txHash: `0x${'aa'.repeat(32)}` as Hex,
            }),
          ),
        },
      })
    })

    const result = await closeWithSessionManager({
      channel: entry,
      challenge,
      fetch,
      input: closeUrl,
      manager: managerParameters(store),
      onChallenge,
      spent: 3n,
    })

    expect(result.receipt).toMatchObject({ channelId, spent: '4' })
    expect(result.manager.state).toMatchObject({ status: 'closed', channelId })
    expect(closeAmounts).toEqual(['3', '4'])
    expect(onChallenge).toHaveBeenCalledOnce()
    expect(onChallenge).toHaveBeenCalledWith(refreshed.challenge)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledOnce()
  })

  test('restores newer snapshot spend before retrying a close', async () => {
    const { challenge } = challengeResponse('challenge-2', sessionSnapshot())
    const entry = channelEntry()
    entry.cumulativeAmount = 5n
    const { remove, store } = channelStore(entry)
    const closeAmounts: string[] = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = credentialPayload(init)
      if (payload?.action !== 'close') throw new Error('expected close credential')
      closeAmounts.push(payload.cumulativeAmount)
      return new Response(null, {
        headers: {
          [Constants.Headers.paymentReceipt]: serializeSessionReceipt(
            createSessionReceipt({
              acceptedCumulative: 4n,
              challengeId: challenge.id,
              channelId,
              spent: 4n,
              txHash: `0x${'aa'.repeat(32)}` as Hex,
            }),
          ),
        },
      })
    })

    const result = await closeWithSessionManager({
      channel: entry,
      challenge,
      fetch,
      input: 'https://api.example.test/resource?chainId=testnet',
      manager: managerParameters(store),
      spent: 3n,
    })

    expect(result.receipt).toMatchObject({ channelId, spent: '4' })
    expect(closeAmounts).toEqual(['4'])
    expect(remove).toHaveBeenCalledOnce()
  })

  test('rejects refreshed snapshot spend beyond local cumulative authorization', async () => {
    const { challenge } = challengeResponse()
    const entry = channelEntry()
    entry.cumulativeAmount = 5n
    const refreshed = challengeResponse(
      'challenge-2',
      sessionSnapshot({ acceptedCumulative: '6', requiredCumulative: '6', spent: '6' }),
    )
    const { store } = channelStore(entry)
    const fetch = vi.fn(async () => refreshed.response)

    await expect(
      closeWithSessionManager({
        channel: entry,
        challenge,
        fetch,
        input: 'https://api.example.test/resource?chainId=testnet',
        manager: managerParameters(store),
        spent: 3n,
      }),
    ).rejects.toThrow('close snapshot accepted cumulative exceeds local voucher state')
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('rejects a final close receipt without a settlement transaction hash', async () => {
    const { challenge } = challengeResponse()
    const entry = channelEntry()
    entry.cumulativeAmount = 5n
    const { store } = channelStore(entry)
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          headers: {
            [Constants.Headers.paymentReceipt]: serializeSessionReceipt(
              createSessionReceipt({
                acceptedCumulative: 3n,
                challengeId: challenge.id,
                channelId,
                spent: 3n,
              }),
            ),
          },
        }),
    )

    await expect(
      closeWithSessionManager({
        channel: entry,
        challenge,
        fetch,
        input: 'https://api.example.test/resource?chainId=testnet',
        manager: managerParameters(store),
        spent: 3n,
      }),
    ).rejects.toThrow('Session close response included a mismatched payment receipt.')
  })

  test('rejects a stored close challenge with a different payee before sending', async () => {
    const { challenge } = challengeResponse('challenge-1', undefined, {
      recipient: '0x0000000000000000000000000000000000000009',
    })
    const entry = channelEntry()
    const { store } = channelStore(entry)
    const fetch = vi.fn()

    await expect(
      closeWithSessionManager({
        channel: entry,
        challenge,
        fetch,
        input: 'https://api.example.test/resource?chainId=testnet',
        manager: managerParameters(store),
        spent: 1n,
      }),
    ).rejects.toThrow('Close challenge changed the session payee.')
    expect(fetch).not.toHaveBeenCalled()
  })
})
