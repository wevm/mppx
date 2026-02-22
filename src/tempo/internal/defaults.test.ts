import { describe, expect, test } from 'vitest'
import {
  defaultCurrencyForChain,
  mainnetChainId,
  pathUsd,
  testnetChainId,
  usdc,
} from './defaults.js'

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
})
