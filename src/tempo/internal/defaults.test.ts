import { describe, expect, test } from 'vp/test'

import {
  chainId,
  currency,
  decimals,
  escrowContract,
  machineToken,
  resolveCurrency,
  rpcUrl,
  tokens,
} from './defaults.js'

describe('chain ID constants', () => {
  test('mainnet is 4217', () => {
    expect(chainId.mainnet).toBe(4217)
  })

  test('testnet is 42431', () => {
    expect(chainId.testnet).toBe(42431)
  })
})

describe('token address constants', () => {
  test('usdc address', () => {
    expect(tokens.usdc).toBe('0x20C000000000000000000000b9537d11c60E8b50')
  })

  test('pathUsd address', () => {
    expect(tokens.pathUsd).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('usdc and pathUsd are different addresses', () => {
    expect(tokens.usdc).not.toBe(tokens.pathUsd)
  })

  test('decimals is 6', () => {
    expect(decimals).toBe(6)
  })
})

describe('rpcUrl', () => {
  test('mainnet RPC URL', () => {
    expect(rpcUrl[chainId.mainnet]).toBe('https://rpc.tempo.xyz')
  })

  test('testnet RPC URL', () => {
    expect(rpcUrl[chainId.testnet]).toBe('https://rpc.moderato.tempo.xyz')
  })
})

describe('escrowContract', () => {
  test('mainnet escrow contract', () => {
    expect(escrowContract[chainId.mainnet]).toBe('0x33b901018174DDabE4841042ab76ba85D4e24f25')
  })

  test('testnet escrow contract', () => {
    expect(escrowContract[chainId.testnet]).toBe('0xe1c4d3dce17bc111181ddf716f75bae49e61a336')
  })
})

describe('machineToken', () => {
  test('mainnet uses the MACH swapper deployment', () => {
    expect(machineToken[chainId.mainnet]).toEqual({
      swap: '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F',
      token: '0x20c000000000000000000000f37de3740ADec032',
    })
  })

  test('testnet uses the MACH swapper deployment', () => {
    expect(machineToken[chainId.testnet]).toEqual({
      swap: '0xd05f8EdFBB54Da0d765C9fE9b2B3f7d2E3a8C466',
      token: '0x20c000000000000000000000f37de3740ADec032',
    })
  })
})

describe('currency', () => {
  test('mainnet (4217) returns USDC', () => {
    expect(currency[chainId.mainnet]).toBe(tokens.usdc)
  })

  test('testnet (42431) returns pathUSD', () => {
    expect(currency[chainId.testnet]).toBe(tokens.pathUsd)
  })

  test('mainnet and testnet return different currencies', () => {
    expect(currency[chainId.mainnet]).not.toBe(currency[chainId.testnet])
  })
})

describe('resolveCurrency', () => {
  test('defaults to USDC (mainnet)', () => {
    expect(resolveCurrency({})).toBe(tokens.usdc)
  })

  test('testnet: true returns pathUSD', () => {
    expect(resolveCurrency({ testnet: true })).toBe(tokens.pathUsd)
  })

  test('testnet: false returns USDC', () => {
    expect(resolveCurrency({ testnet: false })).toBe(tokens.usdc)
  })

  test('chainId takes precedence over testnet', () => {
    expect(resolveCurrency({ chainId: chainId.testnet, testnet: false })).toBe(tokens.pathUsd)
  })

  test('unknown chainId falls back to pathUSD', () => {
    expect(resolveCurrency({ chainId: 999999 })).toBe(tokens.pathUsd)
  })
})
