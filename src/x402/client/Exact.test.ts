import { Challenge } from 'mppx'
import type { Account } from 'viem'
import { tokens } from 'viem/tokens'
import { describe, expect, test, vi } from 'vp/test'

import * as Chains from '../../evm/Chains.js'
import * as Assets from '../Assets.js'
import * as Header from '../Header.js'
import * as RouteBinding from '../internal/RouteBinding.js'
import * as Types from '../Types.js'
import { createCredential } from './Exact.js'

type X402Challenge = Parameters<typeof createCredential>[0]['challenge']

const account = {
  address: '0x1111111111111111111111111111111111111111',
  signTypedData: vi.fn(async () => '0x1234'),
} as unknown as Account
const usdc = Assets.define({
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  decimals: 6,
  network: 'eip155:84532',
  transfer: {
    name: 'USDC',
    type: 'eip3009',
    version: '2',
  },
})

describe('x402 exact credential helper', () => {
  test('enforces max amount, network, and currency policy before signing', async () => {
    const config = {
      account,
      currencies: [usdc],
      maxAmount: '0.01',
      networks: [Chains.baseSepolia],
    } as const

    await expect(
      createCredential({
        challenge: challenge({ amount: '10001' }),
        config,
        context: {},
      }),
    ).rejects.toThrow('x402 exact amount exceeds maxAmount.')

    await expect(
      createCredential({
        challenge: challenge({ network: 'eip155:8453' }),
        config,
        context: {},
      }),
    ).rejects.toThrow('x402 exact chain ID is not allowed: 8453.')

    await expect(
      createCredential({
        challenge: challenge({ asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
        config,
        context: {},
      }),
    ).rejects.toThrow(
      'x402 exact currency is not allowed: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.',
    )

    expect(account.signTypedData).not.toHaveBeenCalled()
  })

  test('requires network policy for raw hex currencies', async () => {
    await expect(
      createCredential({
        challenge: challenge(),
        config: {
          account,
          currencies: [usdc.address],
          maxAmount: '0.01',
        },
        context: {},
      }),
    ).rejects.toThrow('x402 exact raw currency allowlists require networks.')
  })

  test('uses known asset metadata for currency policy and maxAmount decimals', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    const credential = await createCredential({
      challenge: challenge(),
      config: {
        account: {
          ...account,
          signTypedData,
        } as unknown as Account,
        currencies: [Assets.baseSepolia.USDC],
        maxAmount: '0.01',
      },
      context: {},
    })
    const paymentPayload = Header.decodePaymentSignature(credential)

    expect(signTypedData).toHaveBeenCalledOnce()
    expect(paymentPayload.accepted.asset).toBe(Assets.baseSepolia.USDC.address)
  })

  test('pins known asset currency policy to its network', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    await expect(
      createCredential({
        challenge: challenge({ network: 'eip155:8453' }),
        config: {
          account: {
            ...account,
            signTypedData,
          } as unknown as Account,
          currencies: [Assets.baseSepolia.USDC],
          maxAmount: '0.01',
        },
        context: {},
      }),
    ).rejects.toThrow(
      'x402 exact currency is not allowed: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
    )
    expect(signTypedData).not.toHaveBeenCalled()
  })

  test('accepts viem token sets for currency policy and decimals', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    const credential = await createCredential({
      challenge: challenge({ amount: '1000000' }),
      config: {
        account: {
          ...account,
          signTypedData,
        } as unknown as Account,
        currencies: tokens.popular,
        maxAmount: '1',
      },
      context: {},
    })
    const paymentPayload = Header.decodePaymentSignature(credential)

    expect(signTypedData).toHaveBeenCalledOnce()
    expect(paymentPayload.accepted.asset).toBe(Assets.baseSepolia.USDC.address)
  })

  test('uses viem token decimals for maxAmount policy', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    await expect(
      createCredential({
        challenge: challenge({ amount: '1000001' }),
        config: {
          account: {
            ...account,
            signTypedData,
          } as unknown as Account,
          currencies: tokens.popular,
          maxAmount: '1',
        },
        context: {},
      }),
    ).rejects.toThrow('x402 exact amount exceeds maxAmount.')
    expect(signTypedData).not.toHaveBeenCalled()
  })

  test('accepts viem token sets through legacy assets policy', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    const credential = await createCredential({
      challenge: challenge({ amount: '1000000' }),
      config: {
        account: {
          ...account,
          signTypedData,
        } as unknown as Account,
        assets: tokens.popular,
        maxAmount: '1',
      },
      context: {},
    })

    expect(signTypedData).toHaveBeenCalledOnce()
    expect(Header.decodePaymentSignature(credential).accepted.asset).toBe(
      Assets.baseSepolia.USDC.address,
    )
  })

  test('pins viem token currency policy to available networks', async () => {
    const signTypedData = vi.fn(async () => '0x1234')

    await expect(
      createCredential({
        challenge: challenge({ network: 'eip155:999999' }),
        config: {
          account: {
            ...account,
            signTypedData,
          } as unknown as Account,
          currencies: tokens.popular,
          maxAmount: '1',
        },
        context: {},
      }),
    ).rejects.toThrow(
      'x402 exact currency is not allowed: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.',
    )
    expect(signTypedData).not.toHaveBeenCalled()
  })

  test('signs EIP-3009 exact payment payloads', async () => {
    const signTypedData = vi.fn(async () => '0x1234')
    const config = {
      account: {
        ...account,
        signTypedData,
      } as unknown as Account,
      currencies: [usdc],
      maxAmount: '0.01',
      networks: [Chains.baseSepolia],
    } as const

    const credential = await createCredential({
      challenge: challenge(),
      config,
      context: {},
    })
    const paymentPayload = Header.decodePaymentSignature(credential)

    expect(signTypedData).toHaveBeenCalledOnce()
    expect(paymentPayload.x402Version).toBe(2)
    expect(paymentPayload.accepted.scheme).toBe('exact')
    expect('authorization' in paymentPayload.payload).toBe(true)
    if (!('authorization' in paymentPayload.payload)) throw new Error()
    expect(paymentPayload.extensions?.mppx?.info.method).toBe('GET')
    expect(paymentPayload.extensions?.mppx?.info.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(paymentPayload.payload.authorization.nonce).toBe(
      RouteBinding.nonce({
        accepted: paymentPayload.accepted,
        extensions: paymentPayload.extensions!,
        resource: paymentPayload.resource!,
      }),
    )
    expect(paymentPayload.payload.signature).toBe('0x1234')
  })

  test('uses a fresh route-bound nonce for repeated payments', async () => {
    const config = {
      account,
      currencies: [usdc],
      maxAmount: '0.01',
      networks: [Chains.baseSepolia],
    } as const

    const first = Header.decodePaymentSignature(
      await createCredential({
        challenge: challenge(),
        config,
        context: {},
      }),
    )
    const second = Header.decodePaymentSignature(
      await createCredential({
        challenge: challenge(),
        config,
        context: {},
      }),
    )

    expect(first.extensions?.mppx?.info.nonce).not.toBe(second.extensions?.mppx?.info.nonce)
    if (!('authorization' in first.payload) || !('authorization' in second.payload))
      throw new Error()
    expect(first.payload.authorization.nonce).not.toBe(second.payload.authorization.nonce)
  })
})

function challenge(overrides: Partial<Types.PaymentRequirements> = {}): X402Challenge {
  return Challenge.from({
    id: 'x402-test',
    intent: 'charge',
    method: 'evm',
    realm: 'example.com',
    request: {
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDC',
        version: '2',
      },
      maxTimeoutSeconds: 60,
      network: 'eip155:84532',
      payTo: '0x2222222222222222222222222222222222222222',
      scheme: 'exact',
      extensions: {
        mppx: {
          info: { method: 'GET' },
          schema: {
            additionalProperties: false,
            properties: { method: { type: 'string' }, nonce: { type: 'string' } },
            required: ['method'],
            type: 'object',
          },
        },
      },
      resource: { url: 'https://example.com/paid' },
      ...overrides,
    },
  }) as X402Challenge
}
