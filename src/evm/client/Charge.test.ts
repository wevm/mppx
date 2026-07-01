import { Challenge } from 'mppx'
import type { Account } from 'viem'
import { tokens } from 'viem/tokens'
import { describe, expect, test, vi } from 'vp/test'

import * as Assets from '../Assets.js'
import * as Chains from '../Chains.js'
import { charge } from './Charge.js'

const account = {
  address: '0x1111111111111111111111111111111111111111',
  signTypedData: vi.fn(async () => '0x1234'),
} as unknown as Account

describe('evm charge client', () => {
  test('does not sign x402 payloads from unbranded Payment-auth challenges', async () => {
    const signTypedData = vi.fn(async () => '0x1234')
    const client = charge({
      account: {
        ...account,
        signTypedData,
      } as unknown as Account,
      currencies: [Assets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: [Chains.baseSepolia],
    })
    const challenge = Challenge.from({
      id: 'attacker-controlled',
      intent: 'charge',
      method: 'evm',
      realm: 'api.example.com',
      request: {
        amount: '10000',
        asset: Assets.baseSepolia.USDC.address,
        maxTimeoutSeconds: 60,
        network: 'eip155:84532',
        payTo: '0x2222222222222222222222222222222222222222',
        scheme: 'exact',
      },
    })

    await expect(client.createCredential({ challenge } as never)).rejects.toThrow()
    expect(signTypedData).not.toHaveBeenCalled()
  })

  test('does not use server-supplied decimals for maxAmount policy', async () => {
    const client = charge({
      account,
      maxAmount: '1',
    })
    const challenge = Challenge.from({
      id: 'native',
      intent: 'charge',
      method: 'evm',
      realm: 'api.example.com',
      request: {
        amount: '1000000000000000000',
        currency: Assets.baseSepolia.USDC.address,
        methodDetails: {
          chainId: 84532,
          credentialTypes: ['authorization'],
          decimals: 18,
        },
        recipient: '0x2222222222222222222222222222222222222222',
      },
    })

    await expect(client.createCredential({ challenge } as never)).rejects.toThrow(
      'EVM charge maxAmount requires currency decimals.',
    )
  })

  test('requires network policy for raw hex currencies', async () => {
    const client = charge({
      account,
      currencies: [Assets.baseSepolia.USDC.address],
      maxAmount: '1',
    })
    const challenge = Challenge.from({
      id: 'native',
      intent: 'charge',
      method: 'evm',
      realm: 'api.example.com',
      request: {
        amount: '1000000',
        currency: Assets.baseSepolia.USDC.address,
        methodDetails: {
          chainId: 84532,
          credentialTypes: ['authorization'],
          decimals: 6,
        },
        recipient: '0x2222222222222222222222222222222222222222',
      },
    })

    await expect(client.createCredential({ challenge } as never)).rejects.toThrow(
      'EVM raw currency allowlists require networks.',
    )
  })

  test('accepts viem token sets for currency policy and decimals', async () => {
    const signTypedData = vi.fn(async () => '0x1234')
    const client = charge({
      account: {
        ...account,
        signTypedData,
      } as unknown as Account,
      authorization: { name: 'USD Coin', version: '2' },
      currencies: tokens.popular,
      maxAmount: '1',
    })
    const challenge = Challenge.from({
      id: 'native',
      intent: 'charge',
      method: 'evm',
      realm: 'api.example.com',
      request: {
        amount: '1000000',
        currency: Assets.baseSepolia.USDC.address,
        methodDetails: {
          chainId: 84532,
          credentialTypes: ['authorization'],
          decimals: 18,
        },
        recipient: '0x2222222222222222222222222222222222222222',
      },
    })

    await client.createCredential({ challenge } as never)

    expect(signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          name: 'USD Coin',
          verifyingContract: Assets.baseSepolia.USDC.address,
          version: '2',
        }),
      }),
    )
  })
})
