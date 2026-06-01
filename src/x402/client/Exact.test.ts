import { Challenge } from 'mppx'
import type { Account } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import * as Assets from '../Assets.js'
import * as Header from '../Header.js'
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
      networks: ['eip155:84532'],
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
    ).rejects.toThrow('x402 exact network is not allowed: eip155:8453.')

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

  test('signs EIP-3009 exact payment payloads', async () => {
    const signTypedData = vi.fn(async () => '0x1234')
    const config = {
      account: {
        ...account,
        signTypedData,
      } as unknown as Account,
      currencies: [usdc],
      maxAmount: '0.01',
      networks: ['eip155:84532'],
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
    expect(paymentPayload.payload.signature).toBe('0x1234')
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
      ...overrides,
    },
  }) as X402Challenge
}
