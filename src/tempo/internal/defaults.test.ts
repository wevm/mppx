import { describe, expect, test } from 'vitest'
import {
  decimals,
  defaultCurrencyForChain,
  escrowContract,
  mainnetChainId,
  pathUsd,
  rpcUrl,
  testnetChainId,
  usdc,
} from './defaults.js'

describe('chain ID constants', () => {
  test('mainnetChainId is 4217', () => {
    expect(mainnetChainId).toBe(4217)
  })

  test('testnetChainId is 42431', () => {
    expect(testnetChainId).toBe(42431)
  })
})

describe('token address constants', () => {
  test('usdc address', () => {
    expect(usdc).toBe('0x20C000000000000000000000b9537d11c60E8b50')
  })

  test('pathUsd address', () => {
    expect(pathUsd).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('usdc and pathUsd are different addresses', () => {
    expect(usdc).not.toBe(pathUsd)
  })

  test('decimals is 6', () => {
    expect(decimals).toBe(6)
  })
})

describe('rpcUrl', () => {
  test('mainnet RPC URL', () => {
    expect(rpcUrl[mainnetChainId]).toBe('https://rpc.tempo.xyz')
  })

  test('testnet RPC URL', () => {
    expect(rpcUrl[testnetChainId]).toBe('https://rpc.moderato.tempo.xyz')
  })
})

describe('escrowContract', () => {
  test('mainnet escrow contract', () => {
    expect(escrowContract[mainnetChainId]).toBe('0x0901aED692C755b870F9605E56BAA66C35BEfF69')
  })

  test('testnet escrow contract', () => {
    expect(escrowContract[testnetChainId]).toBe('0x542831e3E4Ace07559b7C8787395f4Fb99F70787')
  })
})

describe('defaultCurrencyForChain', () => {
  test('mainnet (4217) returns USDC', () => {
    expect(defaultCurrencyForChain(mainnetChainId)).toBe(usdc)
  })

  test('testnet (42431) returns pathUSD', () => {
    expect(defaultCurrencyForChain(testnetChainId)).toBe(pathUsd)
  })

  test('undefined returns pathUSD', () => {
    expect(defaultCurrencyForChain(undefined)).toBe(pathUsd)
  })

  test('unknown chain ID returns pathUSD', () => {
    expect(defaultCurrencyForChain(999999)).toBe(pathUsd)
  })

  test('zero chain ID returns pathUSD', () => {
    expect(defaultCurrencyForChain(0)).toBe(pathUsd)
  })

  test('negative chain ID returns pathUSD', () => {
    expect(defaultCurrencyForChain(-1)).toBe(pathUsd)
  })

  test('returns consistent values across repeated calls', () => {
    const first = defaultCurrencyForChain(mainnetChainId)
    const second = defaultCurrencyForChain(mainnetChainId)
    expect(first).toBe(second)
  })

  test('mainnet and testnet return different currencies', () => {
    expect(defaultCurrencyForChain(mainnetChainId)).not.toBe(
      defaultCurrencyForChain(testnetChainId),
    )
  })
})
