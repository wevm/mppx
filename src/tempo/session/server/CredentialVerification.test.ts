import type { Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import {
  requireSessionCredentialAction,
  requireSessionCredentialPayload,
  requireSessionCredentialPayloadHeader,
} from './CredentialVerification.js'

describe('SessionCredentialGuards', () => {
  const channelId = `0x${'aa'.repeat(32)}` as Hex
  const descriptor = {
    authorizedSigner: '0x0000000000000000000000000000000000000001',
    expiringNonceHash: `0x${'11'.repeat(32)}`,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000002',
    payer: '0x0000000000000000000000000000000000000003',
    salt: `0x${'22'.repeat(32)}`,
    token: '0x20c0000000000000000000000000000000000001',
  } as const
  const signature = `0x${'ab'.repeat(65)}` as Hex
  const transaction = `0x${'cd'.repeat(32)}` as Hex

  describe('SessionCredentialGuards', () => {
    test('reads valid action discriminators', () => {
      expect(requireSessionCredentialAction({ action: 'open' })).toBe('open')
      expect(requireSessionCredentialAction({ action: 'topUp' })).toBe('topUp')
      expect(requireSessionCredentialAction({ action: 'voucher' })).toBe('voucher')
      expect(requireSessionCredentialAction({ action: 'close' })).toBe('close')
    })

    test('rejects non-object or unknown action payloads', () => {
      expect(() => requireSessionCredentialAction(null)).toThrow(
        'invalid session credential payload',
      )
      expect(() => requireSessionCredentialAction({ action: 'refund' })).toThrow(
        'invalid session credential action',
      )
    })

    test('requires shared channel ID header fields', () => {
      expect(requireSessionCredentialPayloadHeader({ action: 'voucher', channelId })).toEqual({
        action: 'voucher',
        channelId,
      })
      expect(
        requireSessionCredentialPayloadHeader({
          action: 'voucher',
          channelId: `0x${'AA'.repeat(32)}`,
        }),
      ).toEqual({
        action: 'voucher',
        channelId,
      })
      expect(() => requireSessionCredentialPayloadHeader({ action: 'voucher' })).toThrow(
        'invalid session credential channelId',
      )
    })

    test('normalizes and returns a typed voucher payload after action-specific validation', () => {
      expect(
        requireSessionCredentialPayload({
          action: 'voucher',
          channelId: `0x${'AA'.repeat(32)}`,
          cumulativeAmount: '1',
          descriptor,
          signature,
        }),
      ).toEqual({
        action: 'voucher',
        channelId,
        cumulativeAmount: '1',
        descriptor,
        signature,
      })
    })

    test('validates transaction payload fields by action', () => {
      expect(
        requireSessionCredentialPayload({
          action: 'open',
          type: 'transaction',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature,
          transaction,
        }),
      ).toMatchObject({
        action: 'open',
        type: 'transaction',
        channelId,
        cumulativeAmount: '1',
      })
      expect(() =>
        requireSessionCredentialPayload({
          action: 'topUp',
          type: 'transaction',
          channelId,
          descriptor,
          transaction,
        }),
      ).toThrow('invalid session credential additionalDeposit')
    })

    test('rejects malformed descriptor and raw amount fields', () => {
      expect(() =>
        requireSessionCredentialPayload({
          action: 'close',
          channelId,
          cumulativeAmount: '-1',
          descriptor,
          signature,
        }),
      ).toThrow('invalid session credential cumulativeAmount')
      expect(() =>
        requireSessionCredentialPayload({
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor: { ...descriptor, payer: 'not-an-address' },
          signature,
        }),
      ).toThrow('invalid session credential descriptor.payer')
    })
  })
})
