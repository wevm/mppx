import { describe, expect, test } from 'vp/test'

import * as Types from './Types.js'

const maxUint96 = (1n << 96n) - 1n

const descriptor = {
  payer: '0x0000000000000000000000000000000000000001',
  payee: '0x0000000000000000000000000000000000000002',
  operator: '0x0000000000000000000000000000000000000003',
  token: '0x0000000000000000000000000000000000000004',
  salt: `0x${'11'.repeat(32)}`,
  authorizedSigner: '0x0000000000000000000000000000000000000005',
  expiringNonceHash: `0x${'22'.repeat(32)}`,
} as const

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

  test('assertUint96 narrows valid values and throws for invalid values', () => {
    let amount: bigint = 1n
    Types.assertUint96(amount)
    const branded: Types.Uint96 = amount
    expect(branded).toBe(1n)
    expect(() => Types.assertUint96(maxUint96 + 1n)).toThrow('outside uint96 bounds')
  })
})

describe('precompile session credential payloads', () => {
  test('brands open cumulative amounts at the payload boundary', () => {
    const parsed = Types.parseCredentialPayload({
      action: 'open',
      type: 'transaction',
      channelId: `0x${'33'.repeat(32)}`,
      transaction: '0x1234',
      signature: '0xabcd',
      descriptor,
      cumulativeAmount: '10',
    })

    expect(parsed.action).toBe('open')
    expect(parsed.cumulativeAmount).toBe(10n)
    expect(Types.isUint96(parsed.cumulativeAmount)).toBe(true)
  })

  test('brands top-up additional deposits at the payload boundary', () => {
    const parsed = Types.parseCredentialPayload({
      action: 'topUp',
      type: 'transaction',
      channelId: `0x${'44'.repeat(32)}`,
      transaction: '0x1234',
      descriptor,
      additionalDeposit: maxUint96.toString(),
    })

    expect(parsed.action).toBe('topUp')
    expect(parsed.additionalDeposit).toBe(maxUint96)
  })

  test('brands voucher cumulative amounts at the payload boundary', () => {
    const parsed = Types.parseCredentialPayload({
      action: 'voucher',
      channelId: `0x${'55'.repeat(32)}`,
      signature: '0xabcd',
      descriptor,
      cumulativeAmount: maxUint96.toString(),
    })

    expect(parsed.action).toBe('voucher')
    expect(parsed.cumulativeAmount).toBe(maxUint96)
  })

  test('brands close cumulative amounts at the payload boundary', () => {
    const parsed = Types.parseCredentialPayload({
      action: 'close',
      channelId: `0x${'66'.repeat(32)}`,
      signature: '0xabcd',
      descriptor,
      cumulativeAmount: '1',
    })

    expect(parsed.action).toBe('close')
    expect(parsed.cumulativeAmount).toBe(1n)
  })

  test('rejects malformed or overflowing cumulative amounts', () => {
    expect(() => Types.parseUint96Amount('1.5')).toThrow('decimal string')
    expect(() => Types.parseUint96Amount('-1')).toThrow('decimal string')
    expect(() => Types.parseUint96Amount((maxUint96 + 1n).toString())).toThrow(
      'outside uint96 bounds',
    )
  })
})
