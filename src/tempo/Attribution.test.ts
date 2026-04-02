import { Bytes, Hash, Hex } from 'ox'
import { describe, expect, test } from 'vp/test'

import * as Attribution from './Attribution.js'

describe('Attribution', () => {
  describe('tag', () => {
    test('is a 4-byte hex string', () => {
      expect(Attribution.tag).toMatch(/^0x[0-9a-f]{8}$/i)
    })

    test('is deterministic (keccak256("mpp")[0..3])', () => {
      expect(Attribution.tag).toBe('0xef1ed712')
    })
  })

  describe('encode', () => {
    test('returns a 32-byte hex string', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      // 0x prefix + 64 hex chars = 32 bytes
      expect(memo).toMatch(/^0x[0-9a-f]{64}$/i)
    })

    test('starts with TAG + version byte', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const tag = memo.slice(0, 10) // 0x + 8 hex chars
      expect(tag.toLowerCase()).toBe(Attribution.tag.toLowerCase())
      const version = memo.slice(10, 12)
      expect(version).toBe('01')
    })

    test('produces deterministic memos (challenge-bound nonce)', () => {
      const a = Attribution.encode({ challengeId: 'challenge-a', serverId: 'api.example.com' })
      const b = Attribution.encode({ challengeId: 'challenge-b', serverId: 'api.example.com' })
      expect(a).not.toBe(b)
      const c = Attribution.encode({ challengeId: 'challenge-a', serverId: 'api.example.com' })
      expect(a).toBe(c)
    })

    test('encodes server fingerprint from serverId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const expectedFingerprint = Hex.slice(
        Hash.keccak256(Bytes.fromString('api.example.com'), { as: 'Hex' }),
        0,
        10,
      )
      const serverHex = `0x${memo.slice(12, 32)}` as `0x${string}`
      expect(serverHex.toLowerCase()).toBe(expectedFingerprint.toLowerCase())
    })

    test('encodes client fingerprint from clientId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: 'my-app',
        serverId: 'api.example.com',
      })
      const expectedFingerprint = Hex.slice(
        Hash.keccak256(Bytes.fromString('my-app'), { as: 'Hex' }),
        0,
        10,
      )
      const clientHex = `0x${memo.slice(32, 52)}` as `0x${string}`
      expect(clientHex.toLowerCase()).toBe(expectedFingerprint.toLowerCase())
    })

    test('encodes zero client bytes when no clientId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const clientHex = `0x${memo.slice(32, 52)}` as `0x${string}`
      expect(clientHex).toBe(Attribution.anonymous)
    })

    test('treats empty string clientId as anonymous', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: '',
        serverId: 'api.example.com',
      })
      const clientHex = `0x${memo.slice(32, 52)}` as `0x${string}`
      expect(clientHex).toBe(Attribution.anonymous)
      const decoded = Attribution.decode(memo)
      expect(decoded).not.toBeNull()
      expect(decoded!.clientFingerprint).toBeNull()
    })
  })

  describe('isMppMemo', () => {
    test('returns true for encoded memos', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      expect(Attribution.isMppMemo(memo)).toBe(true)
    })

    test('returns true for encoded memos with clientId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: 'my-app',
        serverId: 'api.example.com',
      })
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
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const wrongVersion = `${memo.slice(0, 10)}ff${memo.slice(12)}` as `0x${string}`
      expect(Attribution.isMppMemo(wrongVersion)).toBe(false)
    })

    test('handles mixed case hex', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const tagUpper = memo.slice(0, 10).toUpperCase()
      const mixed = `0x${tagUpper.slice(2)}${memo.slice(10)}` as `0x${string}`
      expect(Attribution.isMppMemo(mixed)).toBe(true)
    })
  })

  describe('verifyServer', () => {
    test('returns true for matching serverId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      expect(Attribution.verifyServer(memo, 'api.example.com')).toBe(true)
    })

    test('returns true for matching serverId with clientId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: 'my-app',
        serverId: 'api.example.com',
      })
      expect(Attribution.verifyServer(memo, 'api.example.com')).toBe(true)
    })

    test('returns false for wrong serverId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      expect(Attribution.verifyServer(memo, 'other.example.com')).toBe(false)
    })

    test('returns false for non-MPP memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.verifyServer(arbitrary, 'api.example.com')).toBe(false)
    })
  })

  describe('decode', () => {
    test('decodes an encoded memo with serverId and clientId', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: 'my-app',
        serverId: 'api.example.com',
      })
      const result = Attribution.decode(memo)
      expect(result).not.toBeNull()
      expect(result!.version).toBe(1)
      expect(result!.serverFingerprint).toMatch(/^0x[0-9a-f]{20}$/i) // 10 bytes = 20 hex chars
      expect(result!.clientFingerprint).toMatch(/^0x[0-9a-f]{20}$/i)
      expect(result!.clientFingerprint).not.toBeNull()
      expect(result!.nonce).toMatch(/^0x[0-9a-f]{14}$/i) // 7 bytes = 14 hex chars
    })

    test('decodes anonymous client as null', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const result = Attribution.decode(memo)
      expect(result).not.toBeNull()
      expect(result!.clientFingerprint).toBeNull()
    })

    test('returns null for non-MPP memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.decode(arbitrary)).toBeNull()
    })

    test('different challengeIds produce different nonces', () => {
      const a = Attribution.decode(
        Attribution.encode({ challengeId: 'challenge-a', serverId: 'api.example.com' }),
      )
      const b = Attribution.decode(
        Attribution.encode({ challengeId: 'challenge-b', serverId: 'api.example.com' }),
      )
      expect(a!.nonce).not.toBe(b!.nonce)
    })

    test('serverId fingerprint matches expected keccak hash', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        clientId: 'my-app',
        serverId: 'api.example.com',
      })
      const result = Attribution.decode(memo)!
      const expectedServer = Hex.slice(
        Hash.keccak256(Bytes.fromString('api.example.com'), { as: 'Hex' }),
        0,
        10,
      )
      expect(result.serverFingerprint.toLowerCase()).toBe(expectedServer.toLowerCase())
    })

    test('returns null for wrong version via decode', () => {
      const memo = Attribution.encode({
        challengeId: 'test-challenge-1',
        serverId: 'api.example.com',
      })
      const corrupted = `${memo.slice(0, 10)}ff${memo.slice(12)}` as `0x${string}`
      expect(Attribution.decode(corrupted)).toBeNull()
    })
  })

  describe('challengeNonce', () => {
    test('returns 7 bytes', () => {
      const nonce = Attribution.challengeNonce('challenge-123')
      expect(nonce.length).toBe(7)
    })

    test('is deterministic', () => {
      const a = Attribution.challengeNonce('challenge-123')
      const b = Attribution.challengeNonce('challenge-123')
      expect(Hex.fromBytes(a)).toBe(Hex.fromBytes(b))
    })

    test('differs for different challengeIds', () => {
      const a = Attribution.challengeNonce('challenge-123')
      const b = Attribution.challengeNonce('challenge-456')
      expect(Hex.fromBytes(a)).not.toBe(Hex.fromBytes(b))
    })
  })

  describe('verifyChallengeBinding', () => {
    test('returns true for matching challengeId', () => {
      const memo = Attribution.encode({
        challengeId: 'challenge-123',
        serverId: 'api.example.com',
      })
      expect(Attribution.verifyChallengeBinding(memo, 'challenge-123')).toBe(true)
    })

    test('returns false for wrong challengeId', () => {
      const memo = Attribution.encode({
        challengeId: 'challenge-123',
        serverId: 'api.example.com',
      })
      expect(Attribution.verifyChallengeBinding(memo, 'challenge-456')).toBe(false)
    })

    test('returns false for non-MPP memo', () => {
      const arbitrary =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`
      expect(Attribution.verifyChallengeBinding(arbitrary, 'challenge-123')).toBe(false)
    })
  })
})
