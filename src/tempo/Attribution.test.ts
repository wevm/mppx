import { describe, expect, test } from 'vitest'
import * as Attribution from './Attribution.js'

describe('Attribution', () => {
  describe('TAG', () => {
    test('is a 4-byte hex string', () => {
      expect(Attribution.TAG).toMatch(/^0x[0-9a-f]{8}$/i)
    })

    test('is deterministic (keccak256("mpp")[0..3])', () => {
      expect(Attribution.TAG).toBe(Attribution.TAG)
    })
  })

  describe('encode', () => {
    test('returns a 32-byte hex string', () => {
      const memo = Attribution.encode()
      // 0x prefix + 64 hex chars = 32 bytes
      expect(memo).toMatch(/^0x[0-9a-f]{64}$/i)
    })

    test('starts with TAG + version byte', () => {
      const memo = Attribution.encode()
      const tag = memo.slice(0, 10) // 0x + 8 hex chars
      expect(tag.toLowerCase()).toBe(Attribution.TAG.toLowerCase())
      const version = memo.slice(10, 12)
      expect(version).toBe('01')
    })

    test('generates unique memos (random nonce)', () => {
      const a = Attribution.encode()
      const b = Attribution.encode()
      expect(a).not.toBe(b)
    })
  })

  describe('isMppMemo', () => {
    test('returns true for encoded memos', () => {
      const memo = Attribution.encode()
      expect(Attribution.isMppMemo(memo)).toBe(true)
    })

    test('returns false for zero memo', () => {
      const zero =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
      expect(Attribution.isMppMemo(zero)).toBe(false)
    })

    test('returns false for arbitrary memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.isMppMemo(arbitrary)).toBe(false)
    })

    test('returns false for short hex', () => {
      expect(Attribution.isMppMemo('0x1234' as `0x${string}`)).toBe(false)
    })

    test('returns false for wrong version', () => {
      const memo = Attribution.encode()
      const wrongVersion = `${memo.slice(0, 10)}ff${memo.slice(12)}` as `0x${string}`
      expect(Attribution.isMppMemo(wrongVersion)).toBe(false)
    })
  })

  describe('decode', () => {
    test('decodes an encoded memo', () => {
      const memo = Attribution.encode()
      const result = Attribution.decode(memo)
      expect(result).not.toBeNull()
      expect(result!.version).toBe(1)
      expect(result!.nonce).toMatch(/^0x[0-9a-f]{54}$/i) // 27 bytes = 54 hex chars
    })

    test('returns null for non-MPP memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.decode(arbitrary)).toBeNull()
    })

    test('different encodes produce different nonces', () => {
      const a = Attribution.decode(Attribution.encode())
      const b = Attribution.decode(Attribution.encode())
      expect(a!.nonce).not.toBe(b!.nonce)
    })
  })
})
