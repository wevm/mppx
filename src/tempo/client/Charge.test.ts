import { describe, expect, test, vi } from 'vitest'
import type { resolveSettlement as resolveSettlementType, SettlementResolution } from './Charge.js'

// ---------------------------------------------------------------------------
// Mock viem/tempo Actions so we can test resolveSettlement without a network.
// ---------------------------------------------------------------------------

const mockGetBalance = vi.fn<() => Promise<bigint>>()
const mockGetBuyQuote = vi.fn<() => Promise<bigint>>()

vi.mock('viem/tempo', () => ({
  Actions: {
    token: {
      getBalance: (..._args: unknown[]) => mockGetBalance(),
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

describe('resolveSettlement', () => {
  test('direct: client holds target token with sufficient balance', async () => {
    mockGetBalance.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'direct',
      token: tokenA,
    })
  })

  test('swap: falls back when target token balance insufficient', async () => {
    mockGetBalance
      .mockResolvedValueOnce(1n) // tokenA: insufficient
      .mockResolvedValueOnce(2_000_000n) // usdc: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
    })

    expect(result.type).toBe('swap')
  })

  test('swap: uses DEX quote for maxAmountIn', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(5_000_000n) // usdc: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_500n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'swap',
      heldToken: expect.stringMatching(/^0x/) as `0x${string}`,
      targetToken: tokenA,
      maxAmountIn: 1_000_500n,
    })
  })

  test('swap: skips token with insufficient balance for quote, tries next', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(500n) // usdc: less than quote
      .mockResolvedValueOnce(5_000_000n) // pathUsd: sufficient

    mockGetBuyQuote
      .mockResolvedValueOnce(1_000_000n) // usdc quote: too expensive
      .mockResolvedValueOnce(900_000n) // pathUsd quote: affordable

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'swap',
      heldToken: expect.stringMatching(/^0x/) as `0x${string}`,
      targetToken: tokenA,
      maxAmountIn: 900_000n,
    })
  })

  test('swap: skips token on DEX quote failure, tries next', async () => {
    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(5_000_000n) // usdc: has balance
      .mockResolvedValueOnce(5_000_000n) // pathUsd: has balance

    mockGetBuyQuote
      .mockRejectedValueOnce(new Error('INSUFFICIENT_LIQUIDITY')) // usdc: no route
      .mockResolvedValueOnce(1_000_000n) // pathUsd: works

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
    })

    expect(result).toEqual<SettlementResolution>({
      type: 'swap',
      heldToken: expect.stringMatching(/^0x/) as `0x${string}`,
      targetToken: tokenA,
      maxAmountIn: 1_000_000n,
    })
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
        token: tokenA,
      }),
    ).rejects.toThrow('No USD tokens available for settlement')
  })

  test('swap: skips target token in knownUsdTokens', async () => {
    const pathUsd = '0x20c0000000000000000000000000000000000000'

    mockGetBalance
      .mockResolvedValueOnce(0n) // pathUsd (target): insufficient
      .mockResolvedValueOnce(5_000_000n) // usdc (known): sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: pathUsd as `0x${string}`,
    })

    expect(result.type).toBe('swap')
    expect((result as { heldToken: string }).heldToken.toLowerCase()).toBe(
      '0x20C000000000000000000000b9537d11c60E8b50'.toLowerCase(),
    )
  })

  test('swap: uses injected knownUsdTokens', async () => {
    const customUsd = '0xCCCC000000000000000000000000000000000000' as const

    mockGetBalance
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(5_000_000n) // customUsd: sufficient

    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

    const result = await resolveSettlement({
      client,
      account,
      amount: 1_000_000n,
      token: tokenA,
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
      .mockResolvedValueOnce(0n) // tokenA: zero
      .mockResolvedValueOnce(0n) // customUsd: zero

    await expect(
      resolveSettlement({
        client,
        account,
        amount: 1_000_000n,
        token: tokenA,
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

    mockPrepare.mockResolvedValue({ gas: 100n })
    mockSign.mockResolvedValue('0xsigned')
  }

  test('direct: builds single transfer call', async () => {
    setup()
    mockGetBalance.mockResolvedValueOnce(1_000_000n) // sufficient balance

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
  })

  test('swap: builds dex buy + transfer calls', async () => {
    setup()
    mockGetBalance
      .mockResolvedValueOnce(0n) // target token: insufficient
      .mockResolvedValueOnce(5_000_000n) // usdc: sufficient
    mockGetBuyQuote.mockResolvedValueOnce(1_000_000n)

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
    expect(mockGetBuyQuote).toHaveBeenCalledTimes(1)
  })
})
