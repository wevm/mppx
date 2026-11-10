import { createClient, custom, encodeFunctionData } from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as defaults from './defaults.js'

const chainId = defaults.chainId.testnet
const deployment = defaults.machineToken[chainId]
const targetToken = '0x20c0000000000000000000000000000000000001'
const recipient = '0x2222222222222222222222222222222222222222'
const payer = '0x1111111111111111111111111111111111111111'
const accessKey = '0x3333333333333333333333333333333333333333'
const memo = `0x${'ab'.repeat(32)}` as const
const client = createClient({
  transport: custom({ request: async () => undefined as never }),
})
const transfers = [{ amount: 1_000_000n, memo, recipient }] as const
const calls = [{ data: '0x1234', to: deployment.token }] as const

describe('Tempo machine-token charges', () => {
  test('builds and validates the exact first-party approve + swapTo calls', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 1_000_000n),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      const route = await MachineTokenCharge.findRoute(client, {
        account: payer,
        chainId,
        currency: targetToken,
        transfers,
      })

      expect(route?.calls).toHaveLength(2)
      expect(
        MachineTokenCharge.matchRoute({
          calls: route!.calls,
          chainId,
          currency: targetToken,
          transfers,
        })?.transfers,
      ).toEqual(transfers)
      expect(
        MachineTokenCharge.matchRoute({
          calls: route!.calls,
          chainId,
          currency: targetToken,
          transfers: [{ amount: transfers[0]!.amount, recipient }],
        })?.transfers,
      ).toEqual(transfers)
      expect(route?.settlementSender).toBe(deployment.swap)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('skips the MACH route when the payer lacks sufficient machine tokens', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 999_999n),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      await expect(
        MachineTokenCharge.findRoute(client, {
          account: payer,
          chainId,
          currency: targetToken,
          transfers,
        }),
      ).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('skips the MACH route when the swap cannot be simulated', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(async () => {
        throw new Error('merchant is not allowlisted')
      }),
      readContract: vi.fn(async () => 1_000_000n),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      await expect(
        MachineTokenCharge.findRoute(client, {
          account: payer,
          chainId,
          currency: targetToken,
          transfers,
        }),
      ).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('rejects extra calls and any mismatch in the owned swap', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 1_000_000n),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      const route = await MachineTokenCharge.findRoute(client, {
        account: payer,
        chainId,
        currency: targetToken,
        transfers,
      })

      expect(
        MachineTokenCharge.matchRoute({
          calls: [...route!.calls, route!.calls[0]!],
          chainId,
          currency: targetToken,
          transfers,
        }),
      ).toBeUndefined()
      expect(
        MachineTokenCharge.matchRoute({
          calls: [
            route!.calls[0]!,
            {
              ...route!.calls[1],
              data: encodeFunctionData({
                abi: Abis.tip20,
                functionName: 'transfer',
                args: [recipient, transfers[0]!.amount],
              }),
            },
          ],
          chainId,
          currency: targetToken,
          transfers,
        }),
      ).toBeUndefined()
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('does not use unconfigured chains', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    await expect(
      MachineTokenCharge.findRoute(client, {
        account: payer,
        chainId: 69420,
        currency: targetToken,
        transfers,
      }),
    ).resolves.toBeUndefined()
    expect(MachineTokenCharge.getSettlementSender(69420)).toBeUndefined()
  })

  test('does not construct a MACH route for split charges', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    await expect(
      MachineTokenCharge.findRoute(client, {
        account: payer,
        chainId,
        currency: targetToken,
        transfers: [...transfers, transfers[0]!],
      }),
    ).resolves.toBeUndefined()
  })
})

describe('MACH funding', () => {
  const mainnet = defaults.chainId.mainnet

  test('builds the MACH onramp link on Tempo mainnet', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    expect(MachineTokenCharge.fundingUrl()).toBe(
      'https://wallet.tempo.xyz/agent?action=fund&intent=mach&chainId=4217',
    )
    expect(MachineTokenCharge.fundingUrl({ address: payer, amount: 1_250_000n })).toBe(
      `https://wallet.tempo.xyz/agent?action=fund&intent=mach&chainId=4217&address=${payer}&amount=1.25`,
    )
  })

  test('rounds the amount up to whole cents', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    const amount = (value: bigint) =>
      new URL(MachineTokenCharge.fundingUrl({ amount: value })!).searchParams.get('amount')
    expect(amount(1_000_000n)).toBe('1')
    expect(amount(1_500_000n)).toBe('1.5')
    expect(amount(1_250_001n)).toBe('1.26')
    expect(amount(50_000n)).toBe('0.05')
    expect(amount(1n)).toBe('0.01')
    expect(amount(100_000_000n)).toBe('100')
    expect(amount(0n)).toBeNull()
  })

  test('omits an invalid address', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    const url = MachineTokenCharge.fundingUrl({ address: '0x1234' as never })!
    expect(new URL(url).searchParams.has('address')).toBe(false)
  })

  test('returns no link off Tempo mainnet', async () => {
    const MachineTokenCharge = await import('./machine-token-charge.js')
    expect(MachineTokenCharge.fundingUrl({ chainId: defaults.chainId.testnet })).toBeUndefined()
    expect(MachineTokenCharge.fundingUrl({ chainId: 69420 })).toBeUndefined()
  })

  test('reports a MACH shortfall with the onramp link', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 250_000n),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      const Errors = await import('../../Errors.js')
      const error = await MachineTokenCharge.getInsufficientBalanceError(client, {
        account: payer,
        amount: 1_500_000n,
        chainId: mainnet,
      })
      expect(error).toBeInstanceOf(Errors.InsufficientBalanceError)
      expect(error?.fundingUrl).toBe(
        `${defaults.machineTokenFundingBaseUrl}&address=${payer}&amount=1.25`,
      )
      expect(error?.message).toBe(
        `Insufficient balance: requested 1.5 MACH, available 0.25 MACH. Add funds at ${error?.fundingUrl}`,
      )
      expect(error?.toProblemDetails().fundingUrl).toBe(error?.fundingUrl)

      const testnet = await MachineTokenCharge.getInsufficientBalanceError(client, {
        account: payer,
        amount: 1_500_000n,
        chainId: defaults.chainId.testnet,
      })
      expect(testnet?.fundingUrl).toBeUndefined()
      expect(testnet?.message).toBe(
        'Insufficient balance: requested 1.5 MACH, available 0.25 MACH.',
      )
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('reports no shortfall when the payer holds enough MACH or the balance is unknown', async () => {
    vi.resetModules()
    let balance: Promise<bigint> = Promise.resolve(2_000_000n)
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(() => balance),
    }))

    try {
      const MachineTokenCharge = await import('./machine-token-charge.js')
      const parameters = { account: payer, amount: 1_500_000n, chainId: mainnet } as const
      await expect(MachineTokenCharge.getShortfall(client, parameters)).resolves.toBeUndefined()
      balance = Promise.reject(new Error('rpc down'))
      await expect(MachineTokenCharge.getShortfall(client, parameters)).resolves.toBeUndefined()
      await expect(
        MachineTokenCharge.getShortfall(client, { ...parameters, chainId: 69420 }),
      ).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })
})

describe('canPayDirect', () => {
  async function load(options: {
    balance: bigint
    remaining?: bigint | undefined
    simulate?: 'ok' | 'revert' | undefined
    spendPolicy?: 'limited' | 'unlimited' | undefined
  }) {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(async () => {
        if (options.simulate === 'revert') throw new Error('PolicyForbids')
      }),
      readContract: vi.fn(async () => options.balance),
    }))
    vi.doMock('viem/tempo', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem/tempo')>()
      return {
        ...actual,
        Actions: {
          ...actual.Actions,
          accessKey: {
            ...actual.Actions.accessKey,
            getMetadata: vi.fn(async () => ({ spendPolicy: options.spendPolicy ?? 'limited' })),
            getRemainingLimit: vi.fn(async () => ({ remaining: options.remaining ?? 0n })),
          },
        },
      }
    })
    return import('./machine-token-charge.js')
  }

  async function canPay(
    options: Parameters<typeof load>[0],
    account: Record<string, unknown> = { address: payer, type: 'local' },
  ) {
    try {
      const MachineToken = await load(options)
      return await MachineToken.canPayDirect({} as never, {
        account: account as never,
        amount: 1_000_000n,
        calls,
        token: deployment.token,
      })
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  }

  test('pays directly when the balance covers the amount and the transfer simulates', async () => {
    expect(await canPay({ balance: 1_000_000n })).toBe(true)
  })

  test('falls back when the balance is short', async () => {
    expect(await canPay({ balance: 999_999n })).toBe(false)
  })

  test('falls back when the transfer cannot be simulated', async () => {
    expect(await canPay({ balance: 1_000_000n, simulate: 'revert' })).toBe(false)
  })

  test('checks the remaining limit of a limited access key', async () => {
    const keyAccount = { accessKeyAddress: accessKey, address: payer, type: 'local' }

    expect(await canPay({ balance: 1_000_000n, remaining: 999_999n }, keyAccount)).toBe(false)
    expect(await canPay({ balance: 1_000_000n, remaining: 1_000_000n }, keyAccount)).toBe(true)
    expect(await canPay({ balance: 1_000_000n, spendPolicy: 'unlimited' }, keyAccount)).toBe(true)
  })
})
