import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import type * as Credential from '../../../Credential.js'
import { VerificationFailedError } from '../../../Errors.js'
import type * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import { createSessionReceipt } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  applyVerifiedHttpAccounting,
  chargeSessionChannel,
  isSettlementDue,
  readRequestFeePayer,
  resolveCredentialFeePayer,
  resolveRequestFeePayer,
  resolveSettlementProgress,
  type SettleChargedSessionChannel,
} from './Settlement.js'

describe('FeePayerResolution', () => {
  const defaultFeePayer = privateKeyToAccount(
    '0x59c6995e998f97a5a0044976f5d56aabe9517a7f3146b789fe719a97d0a9b49f',
  )
  const requestFeePayer = privateKeyToAccount(
    '0x5de4111a56d1f1ad3c74c8a3be6fba32114d0f9f8e9e4b0d4d4f5a7833f1b6c9',
  )
  const feePayerUrl = 'https://fee-payer.example/relay'

  function credential(): Credential.Credential {
    return {
      challenge: Challenge.from({
        id: 'challenge-1',
        intent: 'session',
        method: 'tempo',
        realm: 'test',
        request: {},
      }),
      payload: {},
    }
  }

  describe('FeePayerResolution', () => {
    test('reads fee-payer values from untrusted request objects', () => {
      expect(readRequestFeePayer(null)).toBeUndefined()
      expect(readRequestFeePayer({ feePayer: true })).toBe(true)
      expect(readRequestFeePayer({ feePayer: false })).toBe(false)
      expect(readRequestFeePayer({ feePayer: requestFeePayer })).toBe(requestFeePayer)
      expect(readRequestFeePayer({ feePayer: {} })).toBeUndefined()
    })

    test('advertises fee-payer support on challenges without exposing the account', () => {
      expect(
        resolveRequestFeePayer({
          credential: null,
          defaultFeePayer,
        }),
      ).toBe(true)

      expect(
        resolveRequestFeePayer({
          credential: null,
          parameterFeePayer: true,
        }),
      ).toBe(true)

      expect(
        resolveRequestFeePayer({
          credential: null,
          parameterFeePayer: feePayerUrl,
        }),
      ).toBe(true)
    })

    test('does not advertise fee-payer support when request disables it', () => {
      expect(
        resolveRequestFeePayer({
          credential: null,
          defaultFeePayer,
          requestFeePayer: false,
        }),
      ).toBeUndefined()
    })

    test('resolves credential-time fee-payer values from request and defaults', () => {
      expect(
        resolveRequestFeePayer({
          credential: credential(),
          defaultFeePayer,
        }),
      ).toBe(defaultFeePayer)

      expect(
        resolveRequestFeePayer({
          credential: credential(),
          defaultFeePayer,
          requestFeePayer,
        }),
      ).toBe(requestFeePayer)

      expect(
        resolveRequestFeePayer({
          credential: credential(),
          defaultFeePayer,
          requestFeePayer: false,
        }),
      ).toBe(false)

      expect(
        resolveRequestFeePayer({
          credential: credential(),
          parameterFeePayer: feePayerUrl,
        }),
      ).toBe(true)
    })

    test('allows credential fee sponsorship only when method details and request permit it', () => {
      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: true },
          request: { feePayer: true },
        }),
      ).toBe(defaultFeePayer)

      expect(
        resolveCredentialFeePayer({
          feePayer: feePayerUrl,
          methodDetails: { feePayer: true },
          request: { feePayer: true },
        }),
      ).toBe(true)

      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: true },
          request: { feePayer: requestFeePayer },
        }),
      ).toBe(requestFeePayer)

      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: true },
          request: { feePayer: false },
        }),
      ).toBeUndefined()

      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: false },
          request: { feePayer: true },
        }),
      ).toBeUndefined()
    })

    test('ignores malformed credential request fee-payer overrides', () => {
      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: true },
          request: null,
        }),
      ).toBe(defaultFeePayer)

      expect(
        resolveCredentialFeePayer({
          feePayer: defaultFeePayer,
          methodDetails: { feePayer: true },
          request: { feePayer: {} },
        }),
      ).toBe(defaultFeePayer)
    })
  })
})

describe('applyVerifiedHttpAccounting', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

  function receipt() {
    return createSessionReceipt({
      acceptedCumulative: 200n,
      challengeId: 'challenge-1',
      channelId,
      spent: 0n,
      units: 0,
    })
  }

  function capturedRequest(overrides: Partial<Method.CapturedRequest>): Method.CapturedRequest {
    return {
      hasBody: false,
      headers: new Headers(),
      method: 'GET',
      url: new URL('https://api.example.com/session'),
      ...overrides,
    }
  }

  async function channelStore() {
    const store = ChannelStore.fromStore(Store.memory())
    await store.updateChannel(
      channelId,
      () =>
        ({
          channelId,
          closeRequestedAt: 0n,
          finalized: false,
          highestVoucherAmount: 200n,
          spent: 0n,
          units: 0,
        }) as ChannelStore.State,
    )
    return store
  }

  test('precharges SSE GET content and marks the receipt as prepaid', async () => {
    const store = await channelStore()
    const markPrepaidReceipt = vi.fn((value) => value)

    await applyVerifiedHttpAccounting({
      capturedRequest: capturedRequest({ method: 'GET' }),
      store,
      getRequestAmount: () => 75n,
      markPrepaidReceipt,
      payloadAction: 'voucher',
      receipt: receipt(),
      settleCharged: async () => undefined,
      sseEnabled: true,
    })

    expect(await store.getChannel(channelId)).toMatchObject({ spent: 75n, units: 1 })
    expect(markPrepaidReceipt).toHaveBeenCalledOnce()
  })

  test('does not charge SSE voucher management POSTs', async () => {
    const store = await channelStore()

    const result = await applyVerifiedHttpAccounting({
      capturedRequest: capturedRequest({ hasBody: true, method: 'POST' }),
      store,
      getRequestAmount: () => 75n,
      payloadAction: 'voucher',
      receipt: receipt(),
      settleCharged: async () => undefined,
      sseEnabled: true,
    })

    expect(await store.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
    expect(result.spent).toBe('0')
  })

  test('keeps non-SSE POST content accounting unchanged', async () => {
    const store = await channelStore()

    await applyVerifiedHttpAccounting({
      capturedRequest: capturedRequest({ hasBody: true, method: 'POST' }),
      store,
      getRequestAmount: () => 75n,
      payloadAction: 'voucher',
      receipt: receipt(),
      settleCharged: async () => undefined,
      sseEnabled: false,
    })

    expect(await store.getChannel(channelId)).toMatchObject({ spent: 75n, units: 1 })
  })
})

describe('SettlementSchedule', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
  const salt = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex
  const expiringNonceHash =
    '0x0000000000000000000000000000000000000000000000000000000000000003' as Hex

  function channel(overrides: Partial<ChannelStore.State> = {}): ChannelStore.State {
    return {
      authorizedSigner: '0x0000000000000000000000000000000000000001',
      backend: 'precompile',
      chainId: 4217,
      channelId,
      closeRequestedAt: 0n,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      deposit: 1_000n,
      descriptor: {
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash,
        operator: '0x0000000000000000000000000000000000000000',
        payee: '0x0000000000000000000000000000000000000002',
        payer: '0x0000000000000000000000000000000000000001',
        salt,
        token: '0x20c0000000000000000000000000000000000001',
      },
      escrowContract: '0x4D50500000000000000000000000000000000000',
      expiringNonceHash,
      finalized: false,
      highestVoucher: {
        channelId,
        cumulativeAmount: 600n,
        signature: '0x1234',
      },
      highestVoucherAmount: 600n,
      operator: '0x0000000000000000000000000000000000000000',
      payee: '0x0000000000000000000000000000000000000002',
      payer: '0x0000000000000000000000000000000000000001',
      salt,
      settledOnChain: 100n,
      spent: 350n,
      token: '0x20c0000000000000000000000000000000000001',
      units: 7,
      ...overrides,
    }
  }

  describe('HTTP settlement accounting', () => {
    async function setup(settleCharged: SettleChargedSessionChannel) {
      const store = ChannelStore.fromStore(Store.memory())
      await store.updateChannel(channelId, () =>
        channel({
          spent: 0n,
          units: 0,
          settledOnChain: 0n,
          highestVoucherAmount: 100n,
          highestVoucher: { channelId, cumulativeAmount: 100n, signature: '0x1234' },
        }),
      )
      const parameters = {
        capturedRequest: {
          hasBody: false,
          headers: new Headers(),
          method: 'GET',
          url: new URL('https://api.example.com/session'),
        },
        getRequestAmount: () => 25n,
        payloadAction: 'voucher' as const,
        receipt: createSessionReceipt({
          acceptedCumulative: 100n,
          challengeId: 'challenge-1',
          channelId,
          spent: 0n,
          units: 0,
        }),
        settleCharged,
        sseEnabled: false,
        store,
      }
      return { parameters, store }
    }

    test('preserves the charge balance after failed settlement and charges a retry once', async () => {
      const { parameters, store } = await setup(async (projected) => {
        expect(projected).toMatchObject({ spent: 25n, units: 1 })
        throw new Error('settlement unavailable')
      })
      await expect(applyVerifiedHttpAccounting(parameters)).rejects.toMatchObject({
        message: 'Session settlement failed',
        cause: { message: 'settlement unavailable' },
      })
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })

      const result = await applyVerifiedHttpAccounting({
        ...parameters,
        settleCharged: async () => `0x${'ab'.repeat(32)}`,
      })
      expect(result).toMatchObject({ spent: '25', units: 1 })
      expect(await store.getChannel(channelId)).toMatchObject({
        spent: 25n,
        units: 1,
        lastSettlementSpent: 25n,
        lastSettlementUnits: 1,
      })
    })

    test('preserves another request charge when settlement fails', async () => {
      const { parameters, store } = await setup(async () => {
        await chargeSessionChannel({ store, channelId, amount: 10n })
        throw new Error('settlement unavailable')
      })
      await expect(applyVerifiedHttpAccounting(parameters)).rejects.toMatchObject({
        message: 'Session settlement failed',
        cause: { message: 'settlement unavailable' },
      })
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 10n, units: 1 })
    })

    test('rechecks voucher coverage after settlement before committing the charge', async () => {
      const { parameters, store } = await setup(async () => {
        await chargeSessionChannel({ store, channelId, amount: 100n })
        return `0x${'ab'.repeat(32)}`
      })
      await expect(applyVerifiedHttpAccounting(parameters)).rejects.toThrow('available 0')
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 100n, units: 1 })
    })

    test('reevaluates the settlement threshold when another request commits a charge', async () => {
      const projections: number[] = []
      const { parameters, store } = await setup(async (projected) => {
        projections.push(projected.units)
        if (projected.units === 1) {
          await chargeSessionChannel({ store, channelId, amount: 10n })
          return undefined
        }
        return `0x${'ab'.repeat(32)}`
      })
      const receipt = await applyVerifiedHttpAccounting(parameters)
      expect(projections).toEqual([1, 2])
      expect(receipt).toMatchObject({ spent: '35', units: 2, txHash: `0x${'ab'.repeat(32)}` })
      expect(await store.getChannel(channelId)).toMatchObject({
        spent: 35n,
        units: 2,
        lastSettlementSpent: 35n,
        lastSettlementUnits: 2,
      })
    })

    test('reports settlement receipt validation errors as operational failures', async () => {
      const cause = new VerificationFailedError({ reason: 'precompile transaction reverted' })
      const { parameters, store } = await setup(async () => {
        throw cause
      })
      await expect(applyVerifiedHttpAccounting(parameters)).rejects.toMatchObject({
        message: 'Session settlement failed',
        cause,
      })
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
    })

    test('rejects a channel closed during settlement without committing a charge', async () => {
      const { parameters, store } = await setup(async () => {
        await store.updateChannel(channelId, (current) => ({ ...current!, closeRequestedAt: 1n }))
        return `0x${'ab'.repeat(32)}`
      })
      await expect(applyVerifiedHttpAccounting(parameters)).rejects.toThrow('pending close request')
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
    })
  })

  describe('SettlementSchedule', () => {
    test('resolves progress from the previous scheduled settlement boundary', () => {
      expect(
        resolveSettlementProgress(
          channel({
            lastSettlementSpent: 125n,
            lastSettlementUnits: 2,
          }),
        ),
      ).toMatchObject({
        amount: 225n,
        units: 5,
      })
    })

    test.each([
      ['unit threshold', { units: 7 }, true],
      ['amount threshold', { amount: 250n }, true],
      ['interval threshold', { intervalMs: 1 }, true],
      ['no threshold crossed', { amount: 251n, units: 8, intervalMs: 60_000 }, false],
    ] as const)('checks %s', (_label, schedule, expected) => {
      expect(isSettlementDue(channel(), schedule)).toBe(expected)
    })

    test.each([
      ['no schedule', undefined],
      ['no accepted voucher', { amount: 1n }],
      ['already settled voucher', { amount: 1n }],
    ] as const)('does not settle when %s', (_label, schedule) => {
      const state =
        _label === 'no accepted voucher'
          ? channel({ highestVoucher: null })
          : _label === 'already settled voucher'
            ? channel({
                highestVoucher: {
                  channelId,
                  cumulativeAmount: 100n,
                  signature: '0x1234',
                },
                settledOnChain: 100n,
              })
            : channel()

      expect(isSettlementDue(state, schedule)).toBe(false)
    })
  })
})
