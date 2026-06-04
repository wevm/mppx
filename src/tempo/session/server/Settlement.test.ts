import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import type * as Credential from '../../../Credential.js'
import type * as ChannelStore from './ChannelStore.js'
import {
  isSettlementDue,
  readRequestFeePayer,
  resolveCredentialFeePayer,
  resolveRequestFeePayer,
  resolveSettlementProgress,
} from './Settlement.js'

describe('FeePayerResolution', () => {
  const defaultFeePayer = privateKeyToAccount(
    '0x59c6995e998f97a5a0044976f5d56aabe9517a7f3146b789fe719a97d0a9b49f',
  )
  const requestFeePayer = privateKeyToAccount(
    '0x5de4111a56d1f1ad3c74c8a3be6fba32114d0f9f8e9e4b0d4d4f5a7833f1b6c9',
  )

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
