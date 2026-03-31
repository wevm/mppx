import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'

import { getTransfers } from './charge.js'

const recipient = '0x1234567890abcdef1234567890abcdef12345678' as Address

describe('getTransfers', () => {
  test('returns single transfer when no splits', () => {
    const transfers = getTransfers({ amount: '100', recipient })
    expect(transfers).toEqual([{ amount: '100', memo: undefined, recipient }])
  })

  test('splits amount between primary and split recipients', () => {
    const splitRecipient = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
    const transfers = getTransfers({
      amount: '100',
      methodDetails: { splits: [{ amount: '30', recipient: splitRecipient }] },
      recipient,
    })
    expect(transfers).toHaveLength(2)
    expect(transfers[0]!.amount).toBe('70')
    expect(transfers[0]!.recipient).toBe(recipient)
    expect(transfers[1]!.amount).toBe('30')
    expect(transfers[1]!.recipient).toBe(splitRecipient)
  })

  test('throws when amount is zero with no splits', () => {
    expect(() => getTransfers({ amount: '0', recipient })).toThrow(
      'split total must be less than total amount',
    )
  })

  test('throws when amount is zero with splits', () => {
    const splitRecipient = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
    expect(() =>
      getTransfers({
        amount: '0',
        methodDetails: { splits: [{ amount: '0', recipient: splitRecipient }] },
        recipient,
      }),
    ).toThrow()
  })

  test('throws when split total equals amount', () => {
    const splitRecipient = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
    expect(() =>
      getTransfers({
        amount: '100',
        methodDetails: { splits: [{ amount: '100', recipient: splitRecipient }] },
        recipient,
      }),
    ).toThrow('split total must be less than total amount')
  })

  test('throws when split total exceeds amount', () => {
    const splitRecipient = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
    expect(() =>
      getTransfers({
        amount: '100',
        methodDetails: { splits: [{ amount: '200', recipient: splitRecipient }] },
        recipient,
      }),
    ).toThrow('split total must be less than total amount')
  })
})
