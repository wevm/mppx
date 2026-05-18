import { createClient, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import { charge } from './Charge.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const client = createClient({
  account,
  chain: tempoLocalnet,
  transport: http('http://127.0.0.1'),
})

const currency = '0x3333333333333333333333333333333333333333' as Address
const recipient = '0x2222222222222222222222222222222222222222' as Address
const signature = `0x${'1'.repeat(130)}` as const
const hash = `0x${'2'.repeat(64)}` as const

type ChargeChallenge = charge.FillPayloadParameters['challenge']

function makeChallenge(
  request?: Partial<ChargeChallenge['request']>,
  methodDetails?: Partial<NonNullable<ChargeChallenge['request']['methodDetails']>>,
): ChargeChallenge {
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'charge',
    method: 'tempo',
    realm: 'test.com',
    request: {
      amount: '1000000',
      currency,
      methodDetails: {
        chainId: tempoLocalnet.id,
        ...methodDetails,
      },
      recipient,
      ...request,
    },
  }) as ChargeChallenge
}

describe('tempo charge fillPayload', () => {
  test('uses custom pull payload result as transaction credential', async () => {
    const fillPayload = vi.fn(async (parameters: charge.FillPayloadParameters<'pull'>) => {
      expect(parameters.account.address).toBe(account.address)
      expect(parameters.chainId).toBe(tempoLocalnet.id)
      expect(parameters.mode).toBe('pull')
      expect(parameters.request.calls).toHaveLength(1)
      expect(parameters.request.feePayer).toBe(true)
      expect(parameters.request.nonceKey).toBe('expiring')
      expect(typeof parameters.request.validBefore).toBe('number')
      return { signature, type: 'transaction' as const }
    })
    const method = charge({
      account,
      fillPayload,
      getClient: () => client,
      mode: 'pull',
    })

    const credential = Credential.deserialize<{ signature: string; type: string }>(
      await method.createCredential({
        challenge: makeChallenge(undefined, { feePayer: true }),
        context: {},
      }),
    )

    expect(fillPayload).toHaveBeenCalledOnce()
    expect(credential.payload).toEqual({ signature, type: 'transaction' })
    expect(credential.source).toBe(`did:pkh:eip155:${tempoLocalnet.id}:${account.address}`)
  })

  test('uses custom push payload result as hash credential', async () => {
    const fillPayload = vi.fn(async (parameters: charge.FillPayloadParameters<'push'>) => {
      expect(parameters.mode).toBe('push')
      expect(parameters.request.calls).toHaveLength(1)
      return { hash, type: 'hash' as const }
    })
    const method = charge({
      account,
      fillPayload,
      getClient: () => client,
      mode: 'push',
    })

    const credential = Credential.deserialize<{ hash: string; type: string }>(
      await method.createCredential({
        challenge: makeChallenge(),
        context: {},
      }),
    )

    expect(fillPayload).toHaveBeenCalledOnce()
    expect(credential.payload).toEqual({ hash, type: 'hash' })
  })

  test('does not call fillPayload for zero-amount proof credentials', async () => {
    const fillPayload = vi.fn(async () => ({ signature, type: 'transaction' as const }))
    const method = charge({
      account,
      fillPayload,
      getClient: () => client,
      mode: 'pull',
    })

    const credential = Credential.deserialize<{ signature: string; type: string }>(
      await method.createCredential({
        challenge: makeChallenge({ amount: '0' }),
        context: {},
      }),
    )

    expect(fillPayload).not.toHaveBeenCalled()
    expect(credential.payload.type).toBe('proof')
  })

  test('rejects payload result that does not match selected mode', async () => {
    const method = charge({
      account,
      fillPayload: async () => ({ hash, type: 'hash' as const }) as never,
      getClient: () => client,
      mode: 'pull',
    })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: {},
      }),
    ).rejects.toThrow('fillPayload must return a transaction result for pull mode.')
  })
})
