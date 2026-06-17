import { Challenge, Credential } from 'mppx'
import { createClient, custom, http } from 'viem'
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
  options: { expires?: string | undefined } = {},
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
    ...options,
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

  describe('nonce strategy', () => {
    async function createWithMockedTransaction(
      parameters: Parameters<typeof charge>[0],
      challenge: Challenge.Challenge<ChargeRequest, 'charge', 'tempo'>,
    ) {
      vi.resetModules()
      const prepareTransactionRequest = vi.fn(
        async (_client: unknown, _parameters: Record<string, unknown>) => ({}),
      )
      const signTransaction = vi.fn(async (_client: unknown, _parameters: unknown) => '0xdeadbeef')
      vi.doMock('viem/actions', () => ({
        prepareTransactionRequest,
        sendCallsSync: vi.fn(),
        signTransaction,
        signTypedData: vi.fn(),
      }))

      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
        ...parameters,
      })

      await method.createCredential({ challenge, context: {} })

      return { prepareTransactionRequest, signTransaction }
    }

    test('uses expiring nonce parameters by default', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

      try {
        const { prepareTransactionRequest, signTransaction } = await createWithMockedTransaction(
          {},
          createChallenge({ amount: '1', supportedModes: ['pull'] }),
        )

        expect(prepareTransactionRequest).toHaveBeenCalledOnce()
        expect(signTransaction).toHaveBeenCalledOnce()
        expect(prepareTransactionRequest.mock.calls[0]?.[1]).toMatchObject({
          nonceKey: 'expiring',
          validBefore: 1_735_689_625,
        })
      } finally {
        vi.doUnmock('viem/actions')
        vi.resetModules()
        vi.useRealTimers()
      }
    })

    test('clamps expiring nonce validity to challenge expiration', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

      try {
        const { prepareTransactionRequest } = await createWithMockedTransaction(
          {},
          createChallenge(
            { amount: '1', supportedModes: ['pull'] },
            { expires: '2025-01-01T00:00:10Z' },
          ),
        )

        expect(prepareTransactionRequest).toHaveBeenCalledOnce()
        expect(prepareTransactionRequest.mock.calls[0]?.[1]).toMatchObject({
          nonceKey: 'expiring',
          validBefore: 1_735_689_610,
        })
      } finally {
        vi.doUnmock('viem/actions')
        vi.resetModules()
        vi.useRealTimers()
      }
    })

    test('omits expiring nonce parameters for sequential nonces', async () => {
      try {
        const { prepareTransactionRequest } = await createWithMockedTransaction(
          { nonceStrategy: 'sequential' },
          createChallenge({ amount: '1', supportedModes: ['pull'] }),
        )

        expect(prepareTransactionRequest).toHaveBeenCalledOnce()
        const request = prepareTransactionRequest.mock.calls[0]?.[1] as Record<string, unknown>
        expect(request.nonceKey).toBeUndefined()
        expect(request.validBefore).toBeUndefined()
      } finally {
        vi.doUnmock('viem/actions')
        vi.resetModules()
      }
    })

    test('rejects sequential nonces for fee-sponsored charges', async () => {
      try {
        await expect(
          createWithMockedTransaction(
            { nonceStrategy: 'sequential' },
            createChallenge({ amount: '1', feePayer: true, supportedModes: ['pull'] }),
          ),
        ).rejects.toThrow('Sequential nonces are not supported for fee-sponsored charges.')
      } finally {
        vi.doUnmock('viem/actions')
        vi.resetModules()
      }
    })
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

  describe('wallet_authorizeChallenge', () => {
    const walletAddress = '0x1111111111111111111111111111111111111111' as const
    const chainId = 42431

    test('json-rpc accounts use a supporting wallet instead of local signing', async () => {
      const challenge = createChallenge({ chainId })
      const authorization = Credential.serialize({
        challenge,
        payload: { hash: '0x1234', type: 'hash' },
      })
      const requests: { method: string; params?: unknown }[] = []
      const client = createClient({
        chain: tempoLocalnet,
        transport: custom({
          async request({ method, params }: { method: string; params?: unknown }) {
            requests.push({ method, params })
            if (method === 'wallet_getCapabilities')
              return { '0xa5bf': { mpp: { status: 'supported' } } }
            if (method === 'wallet_authorizeChallenge') return { authorization }
            throw new Error(`unexpected rpc request: ${method}`)
          },
        }),
      })
      const method = charge({
        account: walletAddress,
        getClient: () => client,
      })

      await expect(method.createCredential({ challenge, context: {} })).resolves.toBe(authorization)
      expect(requests.map(({ method }) => method)).toEqual([
        'wallet_getCapabilities',
        'wallet_authorizeChallenge',
      ])
      expect(requests[1]?.params).toEqual([{ challenges: [Challenge.serialize(challenge)] }])
    })

    test('json-rpc accounts fall back to local signing without wallet mpp support', async () => {
      const signature = `0x${'11'.repeat(64)}1b` as const
      const requests: { method: string }[] = []
      const client = createClient({
        chain: tempoLocalnet,
        transport: custom({
          async request({ method }: { method: string }) {
            requests.push({ method })
            if (method === 'wallet_getCapabilities') return {}
            if (method === 'eth_signTypedData_v4') return signature
            throw new Error(`unexpected rpc request: ${method}`)
          },
        }),
      })
      const method = charge({
        account: walletAddress,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(requests.map(({ method }) => method)).toEqual([
        'wallet_getCapabilities',
        'eth_signTypedData_v4',
      ])
      expect(credential.payload).toEqual({ signature, type: 'proof' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${walletAddress}`)
    })
  })
})
