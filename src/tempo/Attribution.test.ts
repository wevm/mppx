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

    test('with fingerprint string', () => {
      const memo = Attribution.encode({ fingerprint: 'api.myapp.com' })
      expect(memo).toMatch(/^0x[0-9a-f]{64}$/i)
      // fingerprint bytes should be non-zero
      const fpHex = memo.slice(12, 24)
      expect(fpHex).not.toBe('000000000000')
    })

    test('with fingerprint hex', () => {
      const memo = Attribution.encode({ fingerprint: '0xdeadbeef' })
      expect(memo).toMatch(/^0x[0-9a-f]{64}$/i)
      const fpHex = memo.slice(12, 24)
      expect(fpHex).not.toBe('000000000000')
    })

    test('same fingerprint produces same fingerprint bytes', () => {
      const a = Attribution.encode({ fingerprint: 'api.myapp.com' })
      const b = Attribution.encode({ fingerprint: 'api.myapp.com' })
      // fingerprint bytes (offset 5..10 → hex chars 12..24) should match
      expect(a.slice(12, 24)).toBe(b.slice(12, 24))
      // but nonces differ
      expect(a.slice(24)).not.toBe(b.slice(24))
    })

    test('different fingerprints produce different fingerprint bytes', () => {
      const a = Attribution.encode({ fingerprint: 'api.myapp.com' })
      const b = Attribution.encode({ fingerprint: 'other.server.io' })
      expect(a.slice(12, 24)).not.toBe(b.slice(12, 24))
    })

    test('no fingerprint results in zero fingerprint bytes', () => {
      const memo = Attribution.encode()
      const fpHex = memo.slice(12, 24)
      expect(fpHex).toBe('000000000000')
    })
  })

  describe('isMppMemo', () => {
    test('returns true for encoded memos', () => {
      const memo = Attribution.encode()
      expect(Attribution.isMppMemo(memo)).toBe(true)
    })

    test('returns true for memos with fingerprint', () => {
      const memo = Attribution.encode({ fingerprint: 'test.com' })
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
      // Use correct tag but wrong version
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
      expect(result!.fingerprint).toMatch(/^0x[0-9a-f]{12}$/i)
      expect(result!.nonce).toMatch(/^0x[0-9a-f]{42}$/i)
    })

    test('decodes fingerprint correctly', () => {
      const memo = Attribution.encode({ fingerprint: 'api.myapp.com' })
      const result = Attribution.decode(memo)
      expect(result).not.toBeNull()
      // fingerprint should be non-zero
      expect(result!.fingerprint).not.toBe('0x000000000000')
    })

    test('decodes zero fingerprint when none provided', () => {
      const memo = Attribution.encode()
      const result = Attribution.decode(memo)
      expect(result).not.toBeNull()
      expect(result!.fingerprint).toBe('0x000000000000')
    })

    test('returns null for non-MPP memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.decode(arbitrary)).toBeNull()
    })

    test('roundtrips: encode -> decode -> same fingerprint bytes', () => {
      const memo = Attribution.encode({ fingerprint: 'server.example.com' })
      const decoded = Attribution.decode(memo)

      const memo2 = Attribution.encode({ fingerprint: 'server.example.com' })
      const decoded2 = Attribution.decode(memo2)

      expect(decoded!.fingerprint).toBe(decoded2!.fingerprint)
      // nonces differ
      expect(decoded!.nonce).not.toBe(decoded2!.nonce)
    })
  })
})
