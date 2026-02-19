import { describe, expect, test } from 'vitest'
import type { Challenge } from '../../Challenge.js'
import type { Credential } from '../../Credential.js'
import { VerificationFailedError } from '../../Errors.js'
import * as Mcp from '../../Mcp.js'
import { type Extra, mcpSdk } from './Transport.js'

const challenge: Challenge = {
  id: 'test-challenge-id',
  realm: 'api.example.com',
  method: 'tempo',
  intent: 'session',
  request: { amount: '1000000' },
}

const credential: Credential = {
  challenge,
  payload: {
    action: 'voucher',
    channelId: '0xabc',
    cumulativeAmount: '1000000',
    signature: '0x1234',
  },
  source: 'did:pkh:eip155:42431:0x1111111111111111111111111111111111111111',
}

describe('mcpSdk', () => {
  describe('getCredential', () => {
    test('returns credential from _meta', () => {
      const transport = mcpSdk()
      const extra: Extra = {
        _meta: {
          [Mcp.credentialMetaKey]: credential,
        },
      }
      const result = transport.getCredential(extra)
      expect(result).toEqual(credential)
    })

    test('returns null when _meta is undefined', () => {
      const transport = mcpSdk()
      const extra: Extra = {}
      const result = transport.getCredential(extra)
      expect(result).toBeNull()
    })

    test('returns null when credential key is missing', () => {
      const transport = mcpSdk()
      const extra: Extra = { _meta: { otherKey: 'value' } }
      const result = transport.getCredential(extra)
      expect(result).toBeNull()
    })
  })

  describe('respondChallenge', () => {
    test('creates McpError with correct code and challenge data', async () => {
      const transport = mcpSdk()
      const result = await transport.respondChallenge({
        challenge,
        input: {} as Extra,
      })

      expect(result).toBeInstanceOf(Error)
      const err = result as any
      expect(err.code).toBe(Mcp.paymentRequiredCode)
      expect(err.message).toContain('Payment Required')
      expect(err.data?.httpStatus).toBe(402)
      expect(err.data?.challenges).toEqual([challenge])
    })

    test('includes problem details when error is provided', async () => {
      const transport = mcpSdk()
      const error = new VerificationFailedError({ reason: 'bad signature' })
      const result = await transport.respondChallenge({
        challenge,
        error,
        input: {} as Extra,
      })

      const err = result as any
      expect(err.code).toBe(Mcp.paymentRequiredCode)
      expect(err.message).toContain('verification failed')
      expect(err.data?.problem).toBeDefined()
      expect(err.data?.problem?.type).toBe(error.type)
      expect(err.data?.problem?.challengeId).toBe(challenge.id)
    })

    test('uses default message when no error provided', async () => {
      const transport = mcpSdk()
      const result = await transport.respondChallenge({
        challenge,
        input: {} as Extra,
      })
      const err = result as any
      expect(err.message).toContain('Payment Required')
    })
  })

  describe('respondReceipt', () => {
    test('attaches receipt to response _meta', () => {
      const transport = mcpSdk()
      const receipt = {
        method: 'tempo',
        status: 'success' as const,
        timestamp: '2025-06-15T12:00:00.000Z',
        reference: '0xabc',
      }

      const response = {
        content: [{ type: 'text' as const, text: 'hello' }],
      }

      const result = transport.respondReceipt({
        challengeId: 'test-challenge-id',
        receipt,
        response,
      })

      expect(result._meta?.[Mcp.receiptMetaKey]).toEqual({
        ...receipt,
        challengeId: 'test-challenge-id',
      })
    })

    test('preserves existing _meta fields', () => {
      const transport = mcpSdk()
      const receipt = {
        method: 'tempo',
        status: 'success' as const,
        timestamp: '2025-06-15T12:00:00.000Z',
        reference: '0xabc',
      }

      const response = {
        _meta: { existingKey: 'value' },
        content: [{ type: 'text' as const, text: 'hello' }],
      }

      const result = transport.respondReceipt({
        challengeId: 'cid',
        receipt,
        response,
      })

      expect(result._meta?.existingKey).toBe('value')
      expect(result._meta?.[Mcp.receiptMetaKey]).toBeDefined()
    })

    test('preserves response content', () => {
      const transport = mcpSdk()
      const receipt = {
        method: 'tempo',
        status: 'success' as const,
        timestamp: '2025-06-15T12:00:00.000Z',
        reference: '0xabc',
      }

      const response = {
        content: [{ type: 'text' as const, text: 'result data' }],
      }

      const result = transport.respondReceipt({
        challengeId: 'cid',
        receipt,
        response,
      })

      expect(result.content).toEqual(response.content)
    })
  })
})
