import { createClient, custom, encodeFunctionData } from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as defaults from './defaults.js'
import type { Transfer } from './machine-token.js'

const chainId = defaults.chainId.testnet
const deployment = defaults.machineToken[chainId]
const targetToken = '0x20c0000000000000000000000000000000000001'
const recipient = '0x2222222222222222222222222222222222222222'
const payer = '0x1111111111111111111111111111111111111111'
const memo = `0x${'ab'.repeat(32)}` as const
const client = createClient({
  transport: custom({ request: async () => undefined as never }),
})
const transfers = [{ amount: 1_000_000n, memo, recipient }] satisfies readonly Transfer[]

describe('Tempo machine token', () => {
  test('builds and validates the exact first-party approve + swapTo calls', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 1_000_000n),
    }))

    try {
      const MachineToken = await import('./machine-token.js')
      const route = await MachineToken.findRoute(client, {
        account: payer,
        chainId,
        currency: targetToken,
        transfers,
      })

      expect(route?.calls).toHaveLength(2)
      expect(
        MachineToken.matchRoute({
          calls: route!.calls,
          chainId,
          currency: targetToken,
          transfers,
        })?.transfers,
      ).toEqual(transfers)
      expect(
        MachineToken.matchRoute({
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

  test('falls back when the payer lacks sufficient machine tokens', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async () => 999_999n),
    }))

    try {
      const MachineToken = await import('./machine-token.js')
      await expect(
        MachineToken.findRoute(client, {
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

  test('falls back when the swap cannot be simulated', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(async () => {
        throw new Error('merchant is not allowlisted')
      }),
      readContract: vi.fn(async () => 1_000_000n),
    }))

    try {
      const MachineToken = await import('./machine-token.js')
      await expect(
        MachineToken.findRoute(client, {
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
      const MachineToken = await import('./machine-token.js')
      const route = await MachineToken.findRoute(client, {
        account: payer,
        chainId,
        currency: targetToken,
        transfers,
      })

      expect(
        MachineToken.matchRoute({
          calls: [...route!.calls, route!.calls[0]!],
          chainId,
          currency: targetToken,
          transfers,
        }),
      ).toBeUndefined()
      expect(
        MachineToken.matchRoute({
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
    const MachineToken = await import('./machine-token.js')
    await expect(
      MachineToken.findRoute(client, {
        account: payer,
        chainId: 69420,
        currency: targetToken,
        transfers,
      }),
    ).resolves.toBeUndefined()
    expect(MachineToken.getSettlementSender(69420)).toBeUndefined()
  })

  test('falls back for split charges', async () => {
    const MachineToken = await import('./machine-token.js')
    expect(
      MachineToken.getRoute({
        chainId,
        currency: targetToken,
        transfers: [...transfers, transfers[0]!],
      }),
    ).toBeUndefined()
  })
})
