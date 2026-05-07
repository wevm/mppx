import { Challenge, Credential } from 'mppx'
import { Base64 } from 'ox'
import { describe, expect, test } from 'vp/test'

const challenge = Challenge.from({
  id: 'x7Tg2pLqR9mKvNwY3hBcZa',
  realm: 'api.example.com',
  method: 'tempo',
  intent: 'charge',
  request: { amount: '1000' },
})

describe('from', () => {
  test('behavior: creates credential with parsed request', () => {
    const credential = Credential.from({
      challenge,
      payload: { signature: '0x1234' },
    })

    expect(credential).toMatchInlineSnapshot(`
      {
        "challenge": {
          "id": "x7Tg2pLqR9mKvNwY3hBcZa",
          "intent": "charge",
          "method": "tempo",
          "realm": "api.example.com",
          "request": {
            "amount": "1000",
          },
        },
        "payload": {
          "signature": "0x1234",
        },
      }
    `)
  })

  test('behavior: creates credential with source', () => {
    const credential = Credential.from({
      challenge,
      source: 'did:pkh:eip155:1:0x1234567890abcdef',
      payload: { hash: '0xabcd' },
    })

    expect(credential).toMatchInlineSnapshot(`
      {
        "challenge": {
          "id": "x7Tg2pLqR9mKvNwY3hBcZa",
          "intent": "charge",
          "method": "tempo",
          "realm": "api.example.com",
          "request": {
            "amount": "1000",
          },
        },
        "payload": {
          "hash": "0xabcd",
        },
        "source": "did:pkh:eip155:1:0x1234567890abcdef",
      }
    `)
  })

  test('behavior: includes optional challenge fields', () => {
    const credential = Credential.from({
      challenge: {
        ...challenge,
        expires: '2025-01-15T12:00:00Z',
        digest: 'sha-256=abc123',
      },
      payload: { signature: '0x1234' },
    })

    expect(credential.challenge.expires).toBe('2025-01-15T12:00:00Z')
    expect(credential.challenge.digest).toBe('sha-256=abc123')
  })
})

describe('serialize', () => {
  test('behavior: serializes credential to Authorization header format', () => {
    const credential = Credential.from({
      challenge,
      payload: { signature: '0x1234' },
    })

    const header = Credential.serialize(credential)

    expect(header).toMatch(/^Payment /)
    const deserialized = Credential.deserialize(header)
    expect(deserialized.challenge.request).toEqual({ amount: '1000' })
  })

  test('behavior: serializes opaque as a base64url string', () => {
    const credential = Credential.from({
      challenge: Challenge.from({
        id: 'opaque123',
        intent: 'charge',
        meta: { pi: 'pi_3abc123XYZ' },
        method: 'tempo',
        realm: 'api.example.com',
        request: { amount: '1000' },
      }),
      payload: { signature: '0x1234' },
    })

    const header = Credential.serialize(credential)
    const encoded = header.replace(/^Payment\s+/i, '')
    const parsed = JSON.parse(Base64.toString(encoded)) as {
      challenge: { opaque?: unknown }
    }

    expect(parsed.challenge.opaque).toBe('eyJwaSI6InBpXzNhYmMxMjNYWVoifQ')
  })

  test('behavior: echoes raw opaque unchanged', () => {
    const rawChallenge = Challenge.deserialize(
      'Payment id="opaque123", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwIn0", opaque="eXkgd3Jvbmc"',
    )
    const credential = Credential.from({
      challenge: rawChallenge,
      payload: { signature: '0x1234' },
    })

    const header = Credential.serialize(credential)
    const encoded = header.replace(/^Payment\s+/i, '')
    const parsed = JSON.parse(Base64.toString(encoded)) as {
      challenge: { opaque?: unknown }
    }

    expect(parsed.challenge.opaque).toBe('eXkgd3Jvbmc')
  })
})

describe('deserialize', () => {
  test('behavior: deserializes to credential with parsed request', () => {
    const original = Credential.from({
      challenge,
      payload: { signature: '0x1234' },
    })
    const header = Credential.serialize(original)

    const credential = Credential.deserialize(header)

    expect(credential).toMatchInlineSnapshot(`
      {
        "challenge": {
          "id": "x7Tg2pLqR9mKvNwY3hBcZa",
          "intent": "charge",
          "method": "tempo",
          "realm": "api.example.com",
          "request": {
            "amount": "1000",
          },
        },
        "payload": {
          "signature": "0x1234",
        },
      }
    `)
  })

  test('behavior: roundtrip preserves data', () => {
    const original = Credential.from({
      challenge,
      source: 'did:pkh:eip155:1:0x1234567890abcdef',
      payload: { hash: '0xabcd' },
    })

    const header = Credential.serialize(original)
    const deserialized = Credential.deserialize(header)

    expect(deserialized.challenge.id).toBe(original.challenge.id)
    expect(deserialized.challenge.request).toEqual(original.challenge.request)
    expect(deserialized.payload).toEqual(original.payload)
    expect(deserialized.source).toBe(original.source)
  })

  test('behavior: deserializes spec-compliant opaque string credentials', () => {
    const encoded = Base64.fromString(
      JSON.stringify({
        challenge: {
          id: 'opaque123',
          intent: 'charge',
          method: 'tempo',
          opaque: 'eyJwaSI6InBpXzNhYmMxMjNYWVoifQ',
          realm: 'api.example.com',
          request: 'eyJhbW91bnQiOiIxMDAwIn0',
        },
        payload: { signature: '0x1234' },
      }),
      { pad: false, url: true },
    )

    const credential = Credential.deserialize(`Payment ${encoded}`)

    expect(credential.challenge.opaque).toBe('eyJwaSI6InBpXzNhYmMxMjNYWVoifQ')
    expect(credential.challenge.meta).toBeUndefined()
    expect(credential.challenge.request).toEqual({ amount: '1000' })
  })

  test('behavior: preserves non-json opaque string credentials', () => {
    const encoded = Base64.fromString(
      JSON.stringify({
        challenge: {
          id: 'opaque123',
          intent: 'charge',
          method: 'tempo',
          opaque: 'eXkgd3Jvbmc',
          realm: 'api.example.com',
          request: 'eyJhbW91bnQiOiIxMDAwIn0',
        },
        payload: { signature: '0x1234' },
      }),
      { pad: false, url: true },
    )

    const credential = Credential.deserialize(`Payment ${encoded}`)

    expect(credential.challenge.opaque).toBe('eXkgd3Jvbmc')
    expect(credential.challenge.meta).toBeUndefined()
    expect(credential.challenge.request).toEqual({ amount: '1000' })
  })

  test('behavior: preserves legacy object-shaped opaque credentials', () => {
    const encoded = Base64.fromString(
      JSON.stringify({
        challenge: {
          id: 'opaque123',
          intent: 'charge',
          method: 'tempo',
          opaque: { pi: 'pi_3abc123XYZ' },
          realm: 'api.example.com',
          request: 'eyJhbW91bnQiOiIxMDAwIn0',
        },
        payload: { signature: '0x1234' },
      }),
      { pad: false, url: true },
    )

    const credential = Credential.deserialize(`Payment ${encoded}`)

    expect(credential.challenge.opaque).toBe('eyJwaSI6InBpXzNhYmMxMjNYWVoifQ')
    expect(credential.challenge.meta).toEqual({ pi: 'pi_3abc123XYZ' })
  })

  test('error: rejects legacy object-shaped opaque with non-string values', () => {
    const encoded = Base64.fromString(
      JSON.stringify({
        challenge: {
          id: 'opaque123',
          intent: 'charge',
          method: 'tempo',
          opaque: { pi: 123 },
          realm: 'api.example.com',
          request: 'eyJhbW91bnQiOiIxMDAwIn0',
        },
        payload: { signature: '0x1234' },
      }),
      { pad: false, url: true },
    )

    expect(() => Credential.deserialize(`Payment ${encoded}`)).toThrow('Invalid base64url or JSON.')
  })

  test('error: throws for missing Payment scheme', () => {
    expect(() => Credential.deserialize('Bearer abc123')).toThrow('Missing Payment scheme.')
  })

  test('error: throws for invalid base64url', () => {
    expect(() => Credential.deserialize('Payment !!invalid!!')).toThrow(
      'Invalid base64url or JSON.',
    )
  })

  test('error: throws for invalid JSON', () => {
    const invalidJson = btoa('not valid json')
    expect(() => Credential.deserialize(`Payment ${invalidJson}`)).toThrow(
      'Invalid base64url or JSON.',
    )
  })

  test('error: throws for invalid challenge (missing required fields)', () => {
    const invalidCredential = {
      challenge: {
        id: 'abc123',
        // missing realm, method, intent, request
      },
      payload: { signature: '0x1234' },
    }
    const encoded = btoa(JSON.stringify(invalidCredential))
    expect(() => Credential.deserialize(`Payment ${encoded}`)).toThrow()
  })

  test('error: throws for invalid challenge (invalid digest format)', () => {
    const invalidCredential = {
      challenge: {
        id: 'abc123',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: 'eyJhbW91bnQiOiIxMDAwIn0',
        digest: 'invalid-digest-format',
      },
      payload: { signature: '0x1234' },
    }
    const encoded = btoa(JSON.stringify(invalidCredential))
    expect(() => Credential.deserialize(`Payment ${encoded}`)).toThrow()
  })
})

describe('fromRequest', () => {
  test('behavior: extracts credential from Request', () => {
    const original = Credential.from({
      challenge,
      payload: { signature: '0x1234' },
    })
    const request = new Request('https://api.example.com/resource', {
      headers: { Authorization: Credential.serialize(original) },
    })

    const credential = Credential.fromRequest(request)

    expect(credential.challenge.id).toBe('x7Tg2pLqR9mKvNwY3hBcZa')
    expect(credential.challenge.request).toEqual({ amount: '1000' })
    expect(credential.payload).toEqual({ signature: '0x1234' })
  })

  test('behavior: extracts Payment from multiple Authorization schemes', () => {
    const original = Credential.from({
      challenge,
      payload: { signature: '0x1234' },
    })
    const headers = new Headers()
    headers.append('Authorization', 'Bearer some-jwt-token')
    headers.append('Authorization', Credential.serialize(original))
    const request = new Request('https://api.example.com/resource', { headers })

    const credential = Credential.fromRequest(request)

    expect(credential.challenge.id).toBe('x7Tg2pLqR9mKvNwY3hBcZa')
    expect(credential.payload).toEqual({ signature: '0x1234' })
  })

  test('error: throws for missing Authorization header', () => {
    const request = new Request('https://api.example.com/resource')
    expect(() => Credential.fromRequest(request)).toThrow('Missing Authorization header.')
  })

  test('error: throws when no Payment scheme present', () => {
    const request = new Request('https://api.example.com/resource', {
      headers: { Authorization: 'Bearer some-jwt-token' },
    })
    expect(() => Credential.fromRequest(request)).toThrow('Missing Payment scheme.')
  })
})
