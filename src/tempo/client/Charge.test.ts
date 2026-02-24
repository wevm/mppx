import { describe, expect, test, vi } from 'vitest'
import type { resolveSettlement as resolveSettlementType, SettlementResolution, charge as chargeType } from './Charge.js'

// ---------------------------------------------------------------------------
// Mock viem/tempo Actions so we can test resolveSettlement without a network.
// ---------------------------------------------------------------------------

const mockGetBalance = vi.fn<() => Promise<bigint>>()
const mockGetBuyQuote = vi.fn<() => Promise<bigint>>()
const mockGetMetadata = vi.fn<() => Promise<{ currency?: string }>>()

vi.mock('viem/tempo', () => ({
  Actions: {
    token: {
      getBalance: (..._args: unknown[]) => mockGetBalance(),
      getMetadata: (..._args: unknown[]) => mockGetMetadata(),
      transfer: { call: (args: unknown) => ({ type: 'transfer', ...args as object }) },
    },
    dex: {
      getBuyQuote: (..._args: unknown[]) => mockGetBuyQuote(),
      buy: { call: (args: unknown) => ({ type: 'buy', ...args as object }) },
    },
  },
}))

const mockPrepare = vi.fn<() => Promise<{ gas: bigint }>>()
const mockSign = vi.fn<() => Promise<string>>()

vi.mock('viem/actions', () => ({
  prepareTransactionRequest: (..._args: unknown[]) => mockPrepare(),
  signTransaction: (..._args: unknown[]) => mockSign(),
}))

vi.mock('viem/chains', () => ({
  tempo: { id: 4217, name: 'Tempo' },
}))

// Import after mock setup
const { resolveSettlement, charge } = await import('./Charge.js')

const account = { address: '0x1111111111111111111111111111111111111111' as `0x${string}` }
const client = {} as Parameters<typeof resolveSettlementType>[0]['client']

const tokenA = '0xAAAA000000000000000000000000000000000000' as const
const tokenB = '0xBBBB000000000000000000000000000000000000' as const

describe('resolveSettlement', () => {
  test('direct: picks first settlement token with sufficient balance', async () => {
    mockGetBalance.mockResolvedValueOnce(1_000_000n) // tokenA balance

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [tokenA, tokenB],
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'direct',
      token: tokenA,
    })
  })

  test('direct: skips token with insufficient balance', async () => {
    mockGetBalance
      .mockResolvedValueOnce(500n) // tokenA: insufficient
      .mockResolvedValueOnce(1_000_000n) // tokenB: sufficient

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [tokenA, tokenB],
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'direct',
      token: tokenB,
    })
  })

  test('direct: skips token with dust balance (less than amount)', async () => {
    mockGetBalance
      .mockResolvedValueOnce(1n) // tokenA: dust
      .mockResolvedValueOnce(0n) // tokenB: zero
      // Falls through to swap path — known USD tokens
      .mockResolvedValueOnce(2_000_000n) // usdc: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n) // quoted amount

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [tokenA, tokenB],
    })

    expect(result.type).toBe('swap')
  })

  test('swap: uses DEX quote for maxAmountIn', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(5_000_000n) // usdc: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_500n) // quoted: slightly above 1:1

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [tokenA],
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'swap',
      heldToken: expect.stringMatching(/^0x/) as `0x${string}`,
      targetToken: tokenA,
      maxAmountIn: 1_000_500n,
    })
  })

  test('swap: throws on insufficient balance for quoted amount', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(500n) // usdc: less than quote

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n) // need 1M but only have 500

    await expect(
      resolveSettlement({
        client,
        account,
        amount: 1_000_000n,
        settlementCurrencies: [tokenA],
      }),
    ).rejects.toThrow('Insufficient balance')
  })

  test('swap: throws on DEX liquidity failure', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(5_000_000n) // usdc: has balance

    mockGetBuyQuote.mockRejectedValueOnce(new Error('INSUFFICIENT_LIQUIDITY'))

    await expect(
      resolveSettlement({
        client,
        account,
        amount: 1_000_000n,
        settlementCurrencies: [tokenA],
      }),
    ).rejects.toThrow('Insufficient DEX liquidity')
  })

  test('throws when no USD tokens available', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(0n) // usdc: zero
      .mockResolvedValueOnce(0n) // pathUsd: zero

    await expect(
      resolveSettlement({
        client,
        account,
        amount: 1_000_000n,
        settlementCurrencies: [tokenA],
      }),
    ).rejects.toThrow('No USD tokens available for settlement')
  })

  test('swap: skips known tokens already in settlementCurrencies', async () => {
    // pathUsd is in settlementCurrencies, so it's already checked in the direct pass.
    // It should not be checked again in the swap pass.
    const pathUsd = '0x20c0000000000000000000000000000000000000'

    mockGetBalance
      .mockResolvedValueOnce(0n) // pathUsd in settlement: insufficient
      .mockResolvedValueOnce(5_000_000n) // usdc (known): sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [pathUsd],
    })

    // Should pick usdc for swap (pathUsd was already checked in direct pass)
    expect(result.type).toBe('swap')
    expect((result as { heldToken: string }).heldToken.toLowerCase()).toBe(
      '0x20C000000000000000000000b9537d11c60E8b50'.toLowerCase(),
    )
  })

  test('swap: uses injected knownUsdTokens', async () => {
    const customUsd = '0xCCCC000000000000000000000000000000000000' as const

    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero (direct pass)
      .mockResolvedValueOnce(5_000_000n) // customUsd: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      settlementCurrencies: [tokenA],
      knownUsdTokens: [customUsd],
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'swap',
      heldToken: customUsd,
      targetToken: tokenA,
      maxAmountIn: 1_000_000n,
    })
  })

  test('swap: injected knownUsdTokens ignores defaults', async () => {
    const customUsd = '0xCCCC000000000000000000000000000000000000' as const

    mockGetBalance.mockReset()
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero (direct pass)
      .mockResolvedValueOnce(0n) // customUsd: zero

    // With custom list containing only 1 token, and that token has no balance,
    // should throw immediately without checking default tokens
    await expect(
      resolveSettlement({
        client,
        account,
        amount: 1_000_000n,
        settlementCurrencies: [tokenA],
        knownUsdTokens: [customUsd],
      }),
    ).rejects.toThrow('No USD tokens available for settlement')

    // Only 2 getBalance calls: tokenA (direct) + customUsd (swap)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
  })
})

describe('createCredential', () => {
  const challengeBase = {
    id: 'test-id',
    realm: 'api.example.com',
    method: 'tempo' as const,
    intent: 'charge' as const,
  }

  function setup() {
    mockPrepare.mockReset()
    mockSign.mockReset()
    mockGetBalance.mockReset()
    mockGetBuyQuote.mockReset()
    mockGetMetadata.mockReset()

    mockPrepare.mockResolvedValue({ gas: 100n })
    mockSign.mockResolvedValue('0xsigned')
  }

  test('legacy: builds single transfer call', async () => {
    setup()

    const method = charge({ account: account as never, getClient: () => client })
    const credential = await method.createCredential({
      challenge: {
        ...challengeBase,
        request: {
          amount: '1000000',
          currency: '0xAAAA000000000000000000000000000000000000',
          expires: '2099-01-01T00:00:00Z',
          recipient: '0x2222222222222222222222222222222222222222',

        },
      },
      context: {},
    })

    expect(credential).toContain('Payment ')
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    expect(mockSign).toHaveBeenCalledTimes(1)
    // Should NOT call getMetadata for legacy mode
    expect(mockGetMetadata).not.toHaveBeenCalled()
  })

  test('base currency direct: verifies metadata on chosen token', async () => {
    setup()
    // resolveSettlement: tokenA has sufficient balance
    mockGetBalance.mockResolvedValueOnce(1_000_000n)
    // getMetadata for chosen token
    mockGetMetadata.mockResolvedValueOnce({ currency: 'usd' })

    const method = charge({ account: account as never, getClient: () => client })
    const credential = await method.createCredential({
      challenge: {
        ...challengeBase,
        request: {
          amount: '1000000',
          currency: 'usd',
          expires: '2099-01-01T00:00:00Z',
          recipient: '0x2222222222222222222222222222222222222222',
          settlementCurrencies: [tokenA, tokenB],

        },
      },
      context: {},
    })

    expect(credential).toContain('Payment ')
    expect(mockGetMetadata).toHaveBeenCalledTimes(1)
  })

  test('base currency swap: verifies metadata on targetToken', async () => {
    setup()
    // resolveSettlement: no direct match, swap via known USD
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: insufficient
      .mockResolvedValueOnce(5_000_000n) // usdc: sufficient
    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)
    // getMetadata for targetToken (tokenA)
    mockGetMetadata.mockResolvedValueOnce({ currency: 'usd' })

    const method = charge({ account: account as never, getClient: () => client })
    const credential = await method.createCredential({
      challenge: {
        ...challengeBase,
        request: {
          amount: '1000000',
          currency: 'usd',
          expires: '2099-01-01T00:00:00Z',
          recipient: '0x2222222222222222222222222222222222222222',
          settlementCurrencies: [tokenA],

        },
      },
      context: {},
    })

    expect(credential).toContain('Payment ')
    expect(mockGetMetadata).toHaveBeenCalledTimes(1)
  })

  test('base currency: metadata mismatch throws', async () => {
    setup()
    mockGetBalance.mockResolvedValueOnce(1_000_000n) // direct match
    mockGetMetadata.mockResolvedValueOnce({ currency: 'eur' }) // wrong!

    const method = charge({ account: account as never, getClient: () => client })
    await expect(
      method.createCredential({
        challenge: {
          ...challengeBase,
          request: {
            amount: '1000000',
            currency: 'usd',
            expires: '2099-01-01T00:00:00Z',
            recipient: '0x2222222222222222222222222222222222222222',
            settlementCurrencies: [tokenA],
          },
        },
        context: {},
      }),
    ).rejects.toThrow('does not match declared currency')
  })

  test('base currency: missing settlementCurrencies throws', async () => {
    setup()

    const method = charge({ account: account as never, getClient: () => client })
    await expect(
      method.createCredential({
        challenge: {
          ...challengeBase,
          request: {
            amount: '1000000',
            currency: 'usd',
            expires: '2099-01-01T00:00:00Z',
            recipient: '0x2222222222222222222222222222222222222222',
  
          },
        },
        context: {},
      }),
    ).rejects.toThrow('settlementCurrencies required when currency is a base currency code')
  })
})
