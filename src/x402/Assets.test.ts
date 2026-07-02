import { usdc } from 'viem/tokens'
import { describe, expect, test } from 'vp/test'

import * as Assets from './Assets.js'

describe('x402 assets', () => {
  test('defines branded asset metadata', () => {
    const asset = Assets.define({
      address: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      network: 'eip155:1',
      transfer: {
        name: 'USD Coin',
        type: 'eip3009',
        version: '2',
      },
    })

    expect(Assets.isAsset(asset)).toBe(true)
    expect(asset).toMatchObject({
      address: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      network: 'eip155:1',
      transfer: {
        name: 'USD Coin',
        type: 'eip3009',
        version: '2',
      },
    })
  })

  test('rejects unbranded values', () => {
    expect(Assets.isAsset(null)).toBe(false)
    expect(Assets.isAsset('0x1111111111111111111111111111111111111111')).toBe(false)
    expect(
      Assets.isAsset({
        address: '0x1111111111111111111111111111111111111111',
        decimals: 18,
        network: 'eip155:1',
        transfer: {
          name: 'USD Coin',
          type: 'eip3009',
          version: '2',
        },
      }),
    ).toBe(false)
  })

  test('defines asset metadata from viem tokens', () => {
    const asset = Assets.fromToken(usdc, {
      chainId: 84532,
      transfer: {
        type: 'eip3009',
        version: '2',
      },
    })

    expect(Assets.isAsset(asset)).toBe(true)
    expect(asset).toMatchObject({
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      network: 'eip155:84532',
      transfer: {
        name: 'USD Coin',
        type: 'eip3009',
        version: '2',
      },
    })
  })

  test('allows viem token transfer metadata overrides', () => {
    const eip3009Asset = Assets.fromToken(usdc, {
      chainId: 84532,
      transfer: {
        name: 'USDC',
        type: 'eip3009',
        version: '2',
      },
    })
    const permit2Asset = Assets.fromToken(usdc, {
      chainId: 84532,
      transfer: {
        type: 'permit2',
      },
    })

    expect(eip3009Asset.transfer).toEqual({
      name: 'USDC',
      type: 'eip3009',
      version: '2',
    })
    expect(permit2Asset.transfer).toEqual({
      type: 'permit2',
    })
  })

  test('requires token names for EIP-3009 viem token assets', () => {
    const tokenWithoutName = Object.assign(
      () => ({
        address: '0x1111111111111111111111111111111111111111',
        decimals: 6,
        symbol: 'TEST',
      }),
      {
        addresses: { 1: '0x1111111111111111111111111111111111111111' },
        decimals: 6,
      },
    ) as unknown as Assets.ViemToken

    expect(() =>
      Assets.fromToken(tokenWithoutName, {
        chainId: 1,
        transfer: {
          type: 'eip3009',
          version: '2',
        },
      }),
    ).toThrow('EIP-3009 token assets require a token name.')
  })

  test('identifies currency kinds and converts networks', () => {
    expect(Assets.isToken(usdc)).toBe(true)
    expect(Assets.isToken(Assets.baseSepolia.USDC)).toBe(false)
    expect(Assets.isRawAddress('0x1111111111111111111111111111111111111111')).toBe(true)
    expect(Assets.isRawAddress(Assets.baseSepolia.USDC)).toBe(false)
    expect(Assets.toNetwork(84532)).toBe('eip155:84532')
    expect(Assets.toChainId('eip155:84532')).toBe(84532)
  })

  test('resolves and matches raw addresses, known assets, and viem tokens', () => {
    expect(Assets.resolve('0x1111111111111111111111111111111111111111', 'eip155:84532')).toEqual({
      address: '0x1111111111111111111111111111111111111111',
    })
    expect(Assets.resolve(Assets.baseSepolia.USDC, 'eip155:84532')).toEqual({
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      transfer: {
        name: 'USDC',
        type: 'eip3009',
        version: '2',
      },
    })
    expect(Assets.resolve(Assets.baseSepolia.USDC, 'eip155:8453')).toBeUndefined()
    expect(Assets.resolve(usdc, 'eip155:84532')).toEqual({
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      name: 'USD Coin',
    })
    expect(Assets.resolve(usdc, 'eip155:999999')).toBeUndefined()
    expect(Assets.matches(usdc, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'eip155:84532')).toBe(
      true,
    )
    expect(
      Assets.matches(
        '0x1111111111111111111111111111111111111111',
        '0x1111111111111111111111111111111111111111',
        'eip155:84532',
      ),
    ).toBe(true)
    expect(
      Assets.matches(
        Assets.baseSepolia.USDC,
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        'eip155:84532',
      ),
    ).toBe(false)
  })

  test('exports Base USDC metadata', () => {
    expect(Assets.isAsset(Assets.base.USDC)).toBe(true)
    expect(Assets.base.USDC).toMatchObject({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      network: 'eip155:8453',
      transfer: {
        name: 'USD Coin',
        type: 'eip3009',
        version: '2',
      },
    })
  })

  test('exports Base Sepolia USDC metadata', () => {
    expect(Assets.isAsset(Assets.baseSepolia.USDC)).toBe(true)
    expect(Assets.baseSepolia.USDC).toMatchObject({
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      network: 'eip155:84532',
      transfer: {
        name: 'USDC',
        type: 'eip3009',
        version: '2',
      },
    })
  })
})
