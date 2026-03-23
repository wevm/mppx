import type { Hex } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  createSessionReceipt,
  deserializeSessionReceipt,
  serializeSessionReceipt,
} from './Receipt.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

describe('Receipt', () => {
  test('createSessionReceipt', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId,
      acceptedCumulative: 5000000n,
      spent: 3000000n,
      units: 42,
    })

    expect(receipt.method).toBe('tempo')
    expect(receipt.intent).toBe('session')
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe(channelId)
    expect(receipt.challengeId).toBe('test-challenge-id')
    expect(receipt.channelId).toBe(channelId)
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
      channelId,
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
      channelId,
      acceptedCumulative: 1000n,
      spent: 0n,
    })

    expect('units' in receipt).toBe(false)
    expect('txHash' in receipt).toBe(false)
  })

  test('serialize and deserialize round-trip', () => {
    const receipt = createSessionReceipt({
      challengeId: 'test-challenge-id',
      channelId,
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
      channelId,
      acceptedCumulative: 1n,
      spent: 0n,
    })

    const encoded = serializeSessionReceipt(receipt)
    // base64url uses - and _ instead of + and /, no = padding
    expect(encoded).not.toMatch(/[+/=]/)
  })
})
