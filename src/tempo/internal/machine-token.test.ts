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
const sessionPayee = '0x44d7c1edfdfdfdfdfdfdfdfd0000000000000001'
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

  test('resolves active session routes without exposing them to merchant configuration', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async (_client, parameters: { functionName: string }) => {
        if (parameters.functionName === 'sessionRouteFor') return sessionPayee
        if (parameters.functionName === 'sessionRoutes') return [recipient, targetToken]
        throw new Error(`unexpected function ${parameters.functionName}`)
      }),
    }))

    try {
      const MachineToken = await import('./machine-token.js')
      await expect(
        MachineToken.findSessionRoute(client, {
          chainId,
          merchant: recipient,
          targetToken,
        }),
      ).resolves.toEqual({
        merchant: recipient,
        operator: deployment.swap,
        payee: sessionPayee,
        targetToken,
        token: deployment.token,
      })
      await expect(
        MachineToken.getSessionRoute(client, { chainId, payee: sessionPayee }),
      ).resolves.toEqual({
        merchant: recipient,
        operator: deployment.swap,
        payee: sessionPayee,
        targetToken,
        token: deployment.token,
      })
      await expect(
        MachineToken.findVerifiedSessionRoute(client, {
          chainId,
          merchant: recipient,
          targetToken,
        }),
      ).resolves.toEqual(expect.objectContaining({ merchant: recipient, payee: sessionPayee }))
      await expect(
        MachineToken.resolveSessionRoute(client, { chainId, payee: sessionPayee }),
      ).resolves.toEqual({
        merchant: recipient,
        operator: deployment.swap,
        payee: sessionPayee,
        targetToken,
        token: deployment.token,
      })
      await expect(
        MachineToken.matchSessionRoute(client, {
          chainId,
          descriptor: {
            operator: deployment.swap,
            payee: sessionPayee,
            token: deployment.token,
          },
          merchant: recipient,
          targetToken,
        }),
      ).resolves.toEqual(expect.objectContaining({ merchant: recipient, targetToken }))
      await expect(
        MachineToken.matchSessionRoute(client, {
          chainId,
          descriptor: {
            operator: deployment.swap,
            payee: sessionPayee,
            token: deployment.token,
          },
          merchant: payer,
          targetToken,
        }),
      ).resolves.toBeUndefined()
      expect(MachineToken.isSessionSupported(chainId)).toBe(true)
      expect(MachineToken.isSessionSupported(defaults.chainId.mainnet)).toBe(false)
      expect(MachineToken.getSessionFeeToken(chainId)).toBe(defaults.tokens.pathUsd)
      expect(MachineToken.getSessionFeeToken(defaults.chainId.mainnet)).toBeUndefined()
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('separates the challenge capability flag from the trusted descriptor pair', async () => {
    const MachineToken = await import('./machine-token.js')
    expect(
      MachineToken.isSessionEnabledChallenge({
        request: { methodDetails: { chainId, machineTokenEnabled: true } },
      }),
    ).toBe(true)
    expect(
      MachineToken.isSessionEnabledChallenge({
        request: { methodDetails: { chainId, machineTokenEnabled: false } },
      }),
    ).toBe(false)
    expect(
      MachineToken.matchSessionDescriptor({
        chainId,
        descriptor: { operator: deployment.swap, token: deployment.token },
      }),
    ).toEqual(deployment)
    expect(
      MachineToken.matchSessionDescriptor({
        chainId,
        descriptor: { operator: recipient, token: deployment.token },
      }),
    ).toBeUndefined()
  })

  test('rejects virtual payees that are no longer the active merchant route', async () => {
    vi.resetModules()
    vi.doMock('viem/actions', () => ({
      call: vi.fn(),
      readContract: vi.fn(async (_client, parameters: { functionName: string }) => {
        if (parameters.functionName === 'sessionRoutes') return [recipient, targetToken]
        if (parameters.functionName === 'sessionRouteFor')
          return '0x0000000000000000000000000000000000000000'
        throw new Error(`unexpected function ${parameters.functionName}`)
      }),
    }))

    try {
      const MachineToken = await import('./machine-token.js')
      await expect(
        MachineToken.resolveSessionRoute(client, { chainId, payee: sessionPayee }),
      ).resolves.toBeUndefined()
      await expect(
        MachineToken.resolveSessionRoute(client, {
          active: false,
          chainId,
          payee: sessionPayee,
        }),
      ).resolves.toEqual(expect.objectContaining({ merchant: recipient, targetToken }))
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })
})
