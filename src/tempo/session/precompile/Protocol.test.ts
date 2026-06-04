import { Base64 } from 'ox'
import type { Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import {
  createSessionReceipt,
  deserializeSessionReceipt,
  extractData,
  formatApplicationMessage,
  formatAuthorizationMessage,
  formatCloseReadyMessage,
  formatCloseRequestMessage,
  formatErrorMessage,
  formatMessageEvent,
  formatNeedVoucherEvent,
  formatNeedVoucherMessage,
  formatReceiptEvent,
  formatReceiptMessage,
  isNeedVoucherEvent,
  isSessionCredentialAction,
  isSessionCredentialContext,
  isSessionReceipt,
  parseEvent,
  parseMessage,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
  serializeSessionReceipt,
  type NeedVoucherEvent,
  type SessionReceipt,
} from './Protocol.js'
import * as Types from './Protocol.js'

const maxUint96 = (1n << 96n) - 1n

describe('precompile Uint96', () => {
  test('accepts lower and upper bounds', () => {
    expect(Types.uint96(0n)).toBe(0n)
    expect(Types.uint96(maxUint96)).toBe(maxUint96)
    expect(Types.isUint96(0n)).toBe(true)
    expect(Types.isUint96(maxUint96)).toBe(true)
  })

  test('rejects values outside uint96 bounds', () => {
    expect(() => Types.uint96(-1n)).toThrow('outside uint96 bounds')
    expect(() => Types.uint96(maxUint96 + 1n)).toThrow('outside uint96 bounds')
    expect(Types.isUint96(-1n)).toBe(false)
    expect(Types.isUint96(maxUint96 + 1n)).toBe(false)
  })

  test('assertUint96 validates valid values and throws for invalid values', () => {
    const amount: bigint = 1n
    Types.assertUint96(amount)
    expect(amount).toBe(1n)
    expect(() => Types.assertUint96(maxUint96 + 1n)).toThrow('outside uint96 bounds')
  })
})

const credentialContextChannelId = `0x${'11'.repeat(32)}` as const

describe('session credential context guards', () => {
  test('accepts transport context with a channel ID and known action', () => {
    expect(isSessionCredentialContext({ channelId: credentialContextChannelId })).toBe(true)
    expect(
      isSessionCredentialContext({ action: 'voucher', channelId: credentialContextChannelId }),
    ).toBe(true)
  })

  test('rejects missing channel IDs and unknown actions', () => {
    expect(isSessionCredentialContext({ action: 'voucher' })).toBe(false)
    expect(
      isSessionCredentialContext({ action: 'refund', channelId: credentialContextChannelId }),
    ).toBe(false)
    expect(isSessionCredentialContext(null)).toBe(false)
  })

  test('narrows supported action names', () => {
    expect(isSessionCredentialAction('open')).toBe(true)
    expect(isSessionCredentialAction('topUp')).toBe(true)
    expect(isSessionCredentialAction('voucher')).toBe(true)
    expect(isSessionCredentialAction('close')).toBe(true)
    expect(isSessionCredentialAction('refund')).toBe(false)
  })

  test('requires context with custom error message', () => {
    expect(requireSessionCredentialContext({ channelId: credentialContextChannelId })).toEqual({
      channelId: credentialContextChannelId,
    })
    expect(() => requireSessionCredentialContext({}, 'missing context')).toThrow('missing context')
  })

  test('reads raw session challenge amount', () => {
    expect(
      readSessionChallengeAmount({
        id: 'challenge-1',
        realm: 'test',
        method: 'tempo',
        intent: 'session',
        request: { amount: '25' },
      }),
    ).toBe(25n)
  })

  test('rejects missing session challenge amount', () => {
    expect(() =>
      readSessionChallengeAmount({
        id: 'challenge-1',
        realm: 'test',
        method: 'tempo',
        intent: 'session',
        request: {},
      }),
    ).toThrow('Session challenge is missing amount.')
  })
})

describe('session transport payload guards', () => {
  test('accepts complete need-voucher events', () => {
    expect(
      isNeedVoucherEvent({
        channelId: credentialContextChannelId,
        requiredCumulative: '200',
        acceptedCumulative: '100',
        deposit: '1000',
      }),
    ).toBe(true)
  })

  test('rejects incomplete need-voucher events', () => {
    expect(
      isNeedVoucherEvent({ channelId: credentialContextChannelId, requiredCumulative: '200' }),
    ).toBe(false)
  })

  test('accepts complete session receipts', () => {
    expect(
      isSessionReceipt({
        method: 'tempo',
        intent: 'session',
        status: 'success',
        timestamp: '2026-01-01T00:00:00.000Z',
        reference: credentialContextChannelId,
        challengeId: 'challenge-1',
        channelId: credentialContextChannelId,
        acceptedCumulative: '100',
        spent: '50',
        units: 1,
      }),
    ).toBe(true)
  })

  test('rejects incomplete session receipts', () => {
    expect(
      isSessionReceipt({
        challengeId: 'challenge-1',
        channelId: credentialContextChannelId,
      }),
    ).toBe(false)
  })
})

const receiptChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

describe('Receipt', () => {
  test('createSessionReceipt', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId: receiptChannelId,
      acceptedCumulative: 5000000n,
      spent: 3000000n,
      units: 42,
    })

    expect(receipt.method).toBe('tempo')
    expect(receipt.intent).toBe('session')
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe(receiptChannelId)
    expect(receipt.challengeId).toBe('test-challenge-id')
    expect(receipt.channelId).toBe(receiptChannelId)
    expect(receipt.acceptedCumulative).toBe('5000000')
    expect(receipt.spent).toBe('3000000')
    expect(receipt.units).toBe(42)
    expect(receipt.timestamp).toBeTruthy()
    expect(receipt.txHash).toBeUndefined()
  })

  test('createSessionReceipt with txHash', () => {
    const txHash = '0xabcdef' as Hex
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId: receiptChannelId,
      acceptedCumulative: 5000000n,
      spent: 3000000n,
      txHash,
    })

    expect(receipt.txHash).toBe(txHash)
    expect(receipt.units).toBeUndefined()
  })

  test('createSessionReceipt omits optional fields when undefined', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId: receiptChannelId,
      acceptedCumulative: 1000n,
      spent: 0n,
    })

    expect('units' in receipt).toBe(false)
    expect('txHash' in receipt).toBe(false)
  })

  test('serialize and deserialize round-trip', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId: receiptChannelId,
      acceptedCumulative: 5000000n,
      spent: 3000000n,
      units: 42,
    })

    const encoded = serializeSessionReceipt(receipt)
    expect(typeof encoded).toBe('string')

    const decoded = deserializeSessionReceipt(encoded)
    expect(decoded).toEqual(receipt)
  })

  test('serialize produces base64url without padding', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId: receiptChannelId,
      acceptedCumulative: 1n,
      spent: 0n,
    })

    const encoded = serializeSessionReceipt(receipt)
    // base64url uses - and _ instead of + and /, no = padding
    expect(encoded).not.toMatch(/[+/=]/)
  })

  test('deserialize rejects incomplete receipts', () => {
    const malformed = Base64.fromString(JSON.stringify({ channelId: receiptChannelId }), {
      pad: false,
      url: true,
    })

    expect(() => deserializeSessionReceipt(malformed)).toThrow('Invalid session receipt.')
  })
})

const sseChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

const sseReceipt: SessionReceipt = {
  method: 'tempo',
  intent: 'session',
  status: 'success',
  timestamp: '2026-01-01T00:00:00.000Z',
  reference: sseChannelId,
  challengeId: 'challenge-1',
  channelId: sseChannelId,
  acceptedCumulative: '100',
  spent: '50',
  units: 2,
}

const sseNeedVoucher: NeedVoucherEvent = {
  channelId: sseChannelId,
  requiredCumulative: '200',
  acceptedCumulative: '100',
  deposit: '1000',
}

describe('SseProtocol', () => {
  test('round-trips built-in payment events', () => {
    expect(parseEvent(formatReceiptEvent(sseReceipt))).toEqual({
      type: 'payment-receipt',
      data: sseReceipt,
    })
    expect(parseEvent(formatNeedVoucherEvent(sseNeedVoucher))).toEqual({
      type: 'payment-need-voucher',
      data: sseNeedVoucher,
    })
  })

  test('formats multiline application messages as one event', () => {
    const formatted = formatMessageEvent('first\n\nthird')

    expect(formatted).toBe('event: message\ndata: first\ndata: \ndata: third\n\n')
    expect(parseEvent(formatted)).toEqual({ type: 'message', data: 'first\n\nthird' })
  })

  test('treats unknown event types as application messages', () => {
    expect(parseEvent('event: custom\ndata: payload\n\n')).toEqual({
      type: 'message',
      data: 'payload',
    })
  })

  test('extractData returns joined data lines or null', () => {
    expect(extractData('event: message\ndata: a\ndata: b\n')).toBe('a\nb')
    expect(extractData(': comment only')).toBeNull()
  })

  test('rejects malformed payment events', () => {
    expect(parseEvent('event: payment-receipt\ndata: {"channelId":"0x01"}\n\n')).toBeNull()
    expect(parseEvent('event: payment-need-voucher\ndata: not json\n\n')).toBeNull()
  })
})

const wsReceipt: SessionReceipt = {
  method: 'tempo',
  intent: 'session',
  status: 'success',
  timestamp: '2026-01-01T00:00:00.000Z',
  reference: '0x01',
  challengeId: 'challenge-1',
  channelId: '0x02',
  acceptedCumulative: '100',
  spent: '50',
  units: 1,
}

const wsNeedVoucher: NeedVoucherEvent = {
  channelId: '0x01',
  requiredCumulative: '200',
  acceptedCumulative: '100',
  deposit: '1000',
}

describe('WsProtocol', () => {
  test.each([
    ['authorization', formatAuthorizationMessage('credential'), { mpp: 'authorization' }],
    ['message', formatApplicationMessage('payload'), { mpp: 'message', data: 'payload' }],
    ['close request', formatCloseRequestMessage(), { mpp: 'payment-close-request' }],
    [
      'close ready',
      formatCloseReadyMessage(wsReceipt),
      { mpp: 'payment-close-ready', data: wsReceipt },
    ],
    ['error', formatErrorMessage({ status: 402, message: 'pay' }), { mpp: 'payment-error' }],
    [
      'need voucher',
      formatNeedVoucherMessage(wsNeedVoucher),
      { mpp: 'payment-need-voucher', data: wsNeedVoucher },
    ],
    ['receipt', formatReceiptMessage(wsReceipt), { mpp: 'payment-receipt', data: wsReceipt }],
  ])('round-trips %s frames', (_name, raw, expected) => {
    expect(parseMessage(raw)).toMatchObject(expected)
  })

  test('rejects malformed or application-only frames', () => {
    expect(parseMessage('not json')).toBeNull()
    expect(parseMessage('{"hello":"world"}')).toBeNull()
    expect(parseMessage('{"mpp":"payment-receipt","data":true}')).toBeNull()
    expect(parseMessage('{"mpp":"payment-receipt","data":{"channelId":"0x01"}}')).toBeNull()
    expect(parseMessage('{"mpp":"payment-need-voucher","data":{"channelId":"0x01"}}')).toBeNull()
  })
})
