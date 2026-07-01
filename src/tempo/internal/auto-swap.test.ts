import type { Address } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import { defaultCurrencies, InsufficientFundsError, resolve } from './auto-swap.js'

describe('defaultCurrencies', () => {
  test('default', () => {
    expect(defaultCurrencies).toMatchInlineSnapshot(`
      [
        "0x20c0000000000000000000000000000000000000",
        "0x20C000000000000000000000b9537d11c60E8b50",
      ]
    `)
  })
})

describe('resolve', () => {
  const defaults = defaultCurrencies

  test('returns false for undefined', () => {
    expect(resolve(undefined, defaults)).toMatchInlineSnapshot(`false`)
  })

  test('returns false for false', () => {
    expect(resolve(false, defaults)).toMatchInlineSnapshot(`false`)
  })

  test('true resolves to defaults with 1% slippage', () => {
    expect(resolve(true, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('empty options resolves to defaults with 1% slippage', () => {
    expect(resolve({}, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom slippage', () => {
    expect(resolve({ slippage: 5 }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 5,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn prepends to defaults', () => {
    const custom = '0x0000000000000000000000000000000000000099' as Address
    expect(resolve({ tokenIn: [custom] }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x0000000000000000000000000000000000000099",
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn deduplicates against defaults', () => {
    expect(resolve({ tokenIn: [defaults[0]!] }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn + custom slippage', () => {
    const custom = '0x0000000000000000000000000000000000000099' as Address
    expect(resolve({ tokenIn: [custom], slippage: 3 }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 3,
        "tokenIn": [
          "0x0000000000000000000000000000000000000099",
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })
})

describe('findCalls', () => {
  test('passes the client to viem 2.54 Tempo token call builders', async () => {
    vi.resetModules()
    const account = '0x1111111111111111111111111111111111111111' as Address
    const tokenOut = '0x2222222222222222222222222222222222222222' as Address
    const tokenIn = '0x3333333333333333333333333333333333333333' as Address
    const client = { chain: { id: 42431 } }
    const tokenCalls: { client: unknown; name: string; parameters: Record<string, unknown> }[] = []

    function getBalanceCall(client: unknown, parameters: Record<string, unknown>) {
      tokenCalls.push({ client, name: 'getBalance', parameters })
      return { kind: parameters.token === tokenOut ? 'targetBalance' : 'candidateBalance' }
    }

    function approveCall(client: unknown, parameters: Record<string, unknown>) {
      tokenCalls.push({ client, name: 'approve', parameters })
      return { kind: 'approve' }
    }

    vi.doMock('viem/actions', () => ({
      readContract: vi.fn(async (_client, call: { kind: string }) =>
        call.kind === 'targetBalance' ? 0n : 2_000_000n,
      ),
    }))
    vi.doMock('viem/tempo', () => ({
      Actions: {
        dex: {
          buy: { call: vi.fn((parameters) => ({ kind: 'buy', parameters })) },
          getBuyQuote: vi.fn(async () => 1_000_000n),
        },
        token: {
          approve: { call: approveCall },
          getBalance: { call: getBalanceCall },
        },
      },
      Addresses: { stablecoinDex: '0x4444444444444444444444444444444444444444' },
    }))

    try {
      const { findCalls } = await import('./auto-swap.js')

      const calls = await findCalls(client as never, {
        account,
        amountOut: 1_000_000n,
        slippage: 1,
        tokenIn: [tokenIn],
        tokenOut,
      })

      expect(calls).toHaveLength(2)
      expect(tokenCalls.map((call) => call.client)).toEqual([client, client, client])
      expect(tokenCalls.map((call) => call.name)).toEqual(['getBalance', 'getBalance', 'approve'])
      expect(tokenCalls[0]!.parameters).toMatchObject({ account, token: tokenOut })
      expect(tokenCalls[1]!.parameters).toMatchObject({ account, token: tokenIn })
      expect(tokenCalls[2]!.parameters).toMatchObject({
        amount: 1_010_000n,
        spender: '0x4444444444444444444444444444444444444444',
        token: tokenIn,
      })
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })
})

describe('InsufficientFundsError', () => {
  test('default', () => {
    const error = new InsufficientFundsError({
      currency: '0x0000000000000000000000000000000000000001',
    })
    expect(error).toMatchInlineSnapshot(
      `[InsufficientFundsError: Insufficient funds: no balance in 0x0000000000000000000000000000000000000001 and no viable swap route from fallback currencies.]`,
    )
  })
})
