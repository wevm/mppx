import { Challenge, Credential } from 'mppx'
import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Account, Secp256k1 } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as Methods from '../Methods.js'
import { charge } from './Charge.js'

const account = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const currency = '0x3333333333333333333333333333333333333333'
const recipient = '0x2222222222222222222222222222222222222222'

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.charge.schema.request.parse>[0]> = {},
): Challenge.Challenge<ChargeRequest, 'charge', 'tempo'> {
  const request = Methods.charge.schema.request.parse({
    amount: '0',
    currency,
    decimals: 6,
    recipient,
    ...overrides,
  })
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'charge',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<ChargeRequest, 'charge', 'tempo'>
}

describe('tempo.charge client', () => {
  test('uses client chain ID when the challenge omits chainId', async () => {
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: () => client,
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge(),
        context: {},
      }),
    )

    expect(credential.source).toBe(`did:pkh:eip155:${tempoLocalnet.id}:${account.address}`)
  })

  test('uses challenge chainId for client resolution and proof source', async () => {
    let requestedChainId: number | undefined
    const chainId = 42431
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: (parameters) => {
        requestedChainId = parameters.chainId
        return client
      },
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge({ chainId }),
        context: {},
      }),
    )

    expect(requestedChainId).toBe(chainId)
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('resolveAccount selects the proof account after challenge resolution', async () => {
    const selectedAccount = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    )
    const chainId = 42431
    const calls: charge.ResolveAccountInfo[] = []
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: () => client,
      resolveAccount(info) {
        if (info.intent !== 'charge') throw new Error('expected charge account resolution')
        calls.push(info)
        return selectedAccount
      },
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge({ chainId }),
        context: {},
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.account.address).toBe(account.address)
    expect(calls[0]!.chainId).toBe(chainId)
    expect(calls[0]!.request.recipient).toBe(recipient)
    expect(calls[0]!.supportedModes).toEqual(['pull', 'push'])
    expect(credential.payload).toMatchObject({ type: 'proof' })
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${selectedAccount.address}`)
  })

  test('zero-amount proof binds to the root payer for an access-key account', async () => {
    vi.resetModules()
    // Capture the typed data so we can assert what the proof commits to.
    let signedTypedData: { message: { account: string } } | undefined
    const signTypedData = vi.fn(async (_client: unknown, parameters: typeof signedTypedData) => {
      signedTypedData = parameters
      return '0xdeadbeef'
    })
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData,
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const chainId = 42431
      // An access-key account signs with its own key but reports the root
      // account as `address`; the proof must bind to that root payer.
      const accessKey = Account.fromSecp256k1(Secp256k1.randomPrivateKey(), {
        access: account,
      })
      expect(accessKey.address).toBe(account.address)
      expect(accessKey.accessKeyAddress).not.toBe(account.address)

      const client = createClient({
        account: accessKey,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account: accessKey,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(signTypedData).toHaveBeenCalledOnce()
      expect(signedTypedData?.message.account).toBe(account.address)
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'proof' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('uses challenge chainId for non-zero transaction source', async () => {
    vi.resetModules()
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const chainId = 42431
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ amount: '1', chainId, supportedModes: ['pull'] }),
          context: {},
        }),
      )

      expect(prepareTransactionRequest).toHaveBeenCalledOnce()
      expect(signTransaction).toHaveBeenCalledOnce()
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  describe('chain pinning', () => {
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })

    test('rejects a challenge whose chainId conflicts with the pin', async () => {
      const getClient = vi.fn(() => client)
      const method = charge({
        account,
        expectedChainId: 42431,
        getClient,
      })

      await expect(
        method.createCredential({
          challenge: createChallenge({ chainId: 1 }),
          context: {},
        }),
      ).rejects.toThrow('Chain ID mismatch: expected 42431, got 1.')

      // The mismatch is rejected before resolving a client or signing.
      expect(getClient).not.toHaveBeenCalled()
    })

    test('accepts a challenge whose chainId matches the pin', async () => {
      const chainId = 42431
      const method = charge({
        account,
        expectedChainId: chainId,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })

    test('signs on the pin when the challenge omits chainId', async () => {
      let requestedChainId: number | undefined
      const chainId = 42431
      const method = charge({
        account,
        expectedChainId: chainId,
        getClient: (parameters) => {
          requestedChainId = parameters.chainId
          return client
        },
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge(),
          context: {},
        }),
      )

      expect(requestedChainId).toBe(chainId)
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })

    test('unpinned client accepts any challenge chainId', async () => {
      const chainId = 1
      const method = charge({
        account,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })
  })
})
