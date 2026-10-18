import type { Address } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import { defaultCurrencies, InsufficientFundsError, resolve } from './auto-swap.js'

describe('defaultCurrencies', () => {
  test('default', () => {
    expect(defaultCurrencies).toMatchInlineSnapshot(`
      [
        "0x20c0000000000000000000000000000000000000",
        "0x20C000000000000000000000b9537d11c60E8b50",
        "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
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
          "0x20c0000000000000000000006a37DA5C996874BE",
        ],
      }
    `)
  })
})

describe('resolve with fallback: false', () => {
  const custom = '0x1234567890abcdef1234567890abcdef12345678' as Address

  test('swaps only from tokenIn', () => {
    expect(resolve({ tokenIn: [custom], fallback: false }, defaultCurrencies)).toEqual({
      slippage: 1,
      tokenIn: [custom],
    })
  })

  test('keeps a default currency listed in tokenIn', () => {
    expect(
      resolve({ tokenIn: [defaultCurrencies[1]!, custom], fallback: false }, defaultCurrencies),
    ).toEqual({ slippage: 1, tokenIn: [defaultCurrencies[1], custom] })
  })

  test('fallback: true appends the defaults', () => {
    expect(resolve({ tokenIn: [custom], fallback: true }, defaultCurrencies)).toEqual(
      resolve({ tokenIn: [custom] }, defaultCurrencies),
    )
  })

  test('is ignored without tokenIn', () => {
    expect(resolve({ fallback: false }, defaultCurrencies)).toEqual({
      slippage: 1,
      tokenIn: defaultCurrencies,
    })
  })
})

describe('findCalls', () => {
  test('uses current viem Tempo call builder signatures', async () => {
    vi.resetModules()
    const account = '0x1111111111111111111111111111111111111111' as Address
    const tokenOut = '0x2222222222222222222222222222222222222222' as Address
    const tokenIn = '0x3333333333333333333333333333333333333333' as Address
    const client = { chain: { id: 42431 } }
    const builderCalls: { client: unknown; name: string; parameters: Record<string, unknown> }[] =
      []

    function getBalanceCall(client: unknown, parameters: Record<string, unknown>) {
      builderCalls.push({ client, name: 'getBalance', parameters })
      return { kind: parameters.token === tokenOut ? 'targetBalance' : 'candidateBalance' }
    }

    function approveCall(client: unknown, parameters: Record<string, unknown>) {
      builderCalls.push({ client, name: 'approve', parameters })
      return { kind: 'approve' }
    }

    function buyCall(parameters: Record<string, unknown>) {
      builderCalls.push({ client: undefined, name: 'buy', parameters })
      return { kind: 'buy' }
    }

    vi.doMock('viem/actions', () => ({
      readContract: vi.fn(async (_client, call: { kind: string }) =>
        call.kind === 'targetBalance' ? 0n : 2_000_000n,
      ),
    }))
    vi.doMock('viem/tempo', () => ({
      Actions: {
        dex: {
          buy: { call: buyCall },
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
      expect(builderCalls.map((call) => call.client)).toEqual([client, client, client, undefined])
      expect(builderCalls.map((call) => call.name)).toEqual([
        'getBalance',
        'getBalance',
        'approve',
        'buy',
      ])
      expect(builderCalls[0]!.parameters).toMatchObject({ account, token: tokenOut })
      expect(builderCalls[1]!.parameters).toMatchObject({ account, token: tokenIn })
      expect(builderCalls[2]!.parameters).toMatchObject({
        amount: 1_010_000n,
        spender: '0x4444444444444444444444444444444444444444',
        token: tokenIn,
      })
      expect(builderCalls[3]!.parameters).toMatchObject({
        amountOut: 1_000_000n,
        maxAmountIn: 1_010_000n,
        tokenIn,
        tokenOut,
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

describe('autoswap spend boundaries', () => {
  test.each([
    { held: 900n, quote: 100n, expected: 101n },
    { held: 900n, quote: 101n, expected: 101n },
    { held: 900n, quote: 102n, expected: undefined },
    { held: 900n, quote: 500n, cap: 600n, expected: 505n },
    { held: 900n, quote: 500n, cap: 499n, expected: undefined },
    { held: 900n, quote: 0n, expected: undefined },
    { held: 900n, quote: 100n, balance: 100n, expected: undefined },
  ])('bounds quote case $#', async ({ held, quote, cap, balance, expected }) => {
    vi.resetModules()
    const tokenIn = '0x0000000000000000000000000000000000000001' as Address
    const tokenOut = '0x0000000000000000000000000000000000000002' as Address
    const getBuyQuote = vi.fn(async () => quote)
    vi.doMock('viem/actions', () => ({
      readContract: vi.fn(async (_, call) =>
        call.token === tokenOut ? held : (balance ?? 10000n),
      ),
    }))
    vi.doMock('viem/tempo', () => ({
      Addresses: { stablecoinDex: tokenIn },
      Actions: {
        token: {
          getBalance: { call: (_: unknown, args: Record<string, unknown>) => args },
          approve: { call: (_: unknown, args: Record<string, unknown>) => args },
        },
        dex: { getBuyQuote, buy: { call: (args: Record<string, unknown>) => args } },
      },
    }))
    try {
      const { findCalls } = await import('./auto-swap.js')
      const result = findCalls({} as never, {
        account: tokenIn,
        amountOut: 1000n,
        tokenIn: [tokenIn],
        tokenOut,
        slippage: 1,
        maxAmountIn: cap,
      })
      if (expected === undefined) await expect(result).rejects.toThrow()
      else {
        const calls = await result
        expect(calls?.[0]).toMatchObject({ amount: expected })
        expect(calls?.[1]).toMatchObject({ amountOut: 100n, maxAmountIn: expected })
      }
      expect(getBuyQuote).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amountOut: 100n }),
      )
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })
})
