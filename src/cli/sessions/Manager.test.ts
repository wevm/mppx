import { createClient, custom, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Constants from '../../Constants.js'
import * as Credential from '../../Credential.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { entryKey, type ChannelStore } from '../../tempo/session/client/ChannelStore.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import * as Channel from '../../tempo/session/precompile/Channel.js'
import {
  createSessionReceipt,
  serializeSessionReceipt,
  tip20ChannelEscrow,
  type ChannelDescriptor,
  type SessionCredentialPayload,
} from '../../tempo/session/precompile/Protocol.js'
import type { SessionSnapshot } from '../../tempo/session/Snapshot.js'
import { closeWithSessionManager } from './Manager.js'

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
  test('rehydrates durable context and closes at receipt-confirmed spend', async () => {
    const { challenge } = challengeResponse(
      'challenge-1',
      sessionSnapshot({ acceptedCumulative: '3', requiredCumulative: '3', spent: '3' }),
    )
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
      spent: 2n,
    })

    expect(result.receipt).toMatchObject({ channelId, spent: '4' })
    expect(result.manager.state).toMatchObject({ status: 'closed', channelId })
    expect(closeAmounts).toEqual(['3', '4'])
    expect(onChallenge).toHaveBeenCalledOnce()
    expect(onChallenge).toHaveBeenCalledWith(refreshed.challenge)
    expect(fetch).toHaveBeenCalledTimes(2)
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
    const onChallenge = vi.fn()

    await expect(
      closeWithSessionManager({
        channel: entry,
        challenge,
        fetch,
        input: 'https://api.example.test/resource?chainId=testnet',
        manager: managerParameters(store),
        onChallenge,
        spent: 3n,
      }),
    ).rejects.toThrow('close snapshot accepted cumulative exceeds local voucher state')
    expect(fetch).toHaveBeenCalledOnce()
    expect(onChallenge).not.toHaveBeenCalled()
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
