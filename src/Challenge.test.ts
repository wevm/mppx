import { Challenge } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vitest'

describe('from', () => {
  test('behavior: creates challenge', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000', currency: '0x1234', recipient: '0xabcd' },
    })

    expect(challenge).toMatchInlineSnapshot(`
      {
        "id": "abc123",
        "intent": "charge",
        "method": "tempo",
        "realm": "api.example.com",
        "request": {
          "amount": "1000000",
          "currency": "0x1234",
          "recipient": "0xabcd",
        },
      }
    `)
  })

  test('behavior: creates challenge with optional fields', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      digest: 'sha-256=abc',
      expires: '2025-01-06T12:00:00Z',
    })

    expect(challenge).toMatchInlineSnapshot(`
      {
        "digest": "sha-256=abc",
        "expires": "2025-01-06T12:00:00Z",
        "id": "abc123",
        "intent": "charge",
        "method": "tempo",
        "realm": "api.example.com",
        "request": {
          "amount": "1000000",
        },
      }
    `)
  })

  // ---------------------------------------------------------------------------
  // HMAC Challenge ID Test Vectors
  //
  // HMAC input: realm | method | intent | base64url(canonicalize(request)) | expires | digest
  // HMAC key:   UTF-8 bytes of secretKey
  // Output:     base64url(HMAC-SHA256(key, input), no padding)
  //
  // These vectors cover every combination of optional HMAC fields (expires, digest)
  // and variations in each required field (realm, method, intent, request).
  // Use them to verify HMAC challenge ID computation in other implementations.
  // ---------------------------------------------------------------------------
  const hmacVectors = [
    {
      label: 'required fields only',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
      },
      expectedId: 'SOfbA51LV3LCkGE7RbomqwXdbWVlrZwlW-Z9aOHolxw',
    },
    {
      label: 'with expires',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        expires: '2025-01-06T12:00:00Z',
      },
      expectedId: 'R1ZSIwoIjkFhMCSzUGiCTesiigf5vV65EQ_3gVNtsNw',
    },
    {
      label: 'with digest',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        digest: 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE',
      },
      expectedId: 'AiMmBdsSOkOYpXTupMnzVnrzZbqMY_P2i80vENRUSN4',
    },
    {
      label: 'with expires and digest',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        expires: '2025-01-06T12:00:00Z',
        digest: 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE',
      },
      expectedId: 'FMBGqN7MzpKagHsCcartZM09CnUqv7UgmaCy45Ozgug',
    },
    {
      label: 'with description (not in HMAC input)',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        description: 'Test payment',
      },
      expectedId: 'SOfbA51LV3LCkGE7RbomqwXdbWVlrZwlW-Z9aOHolxw',
    },
    {
      label: 'with multi-field request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000', currency: '0x1234', recipient: '0xabcd' },
      },
      expectedId: '5CXJi4bWMz2W54WjnlmoxnwTYe-JKwhw0z32ICQ65Es',
    },
    {
      label: 'with nested methodDetails in request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000', currency: '0x1234', methodDetails: { chainId: 42431 } },
      },
      expectedId: 'eid66xXUZsj46Pb30AfAf7m5kPehgianI16rZ-QY8HU',
    },
    {
      label: 'with empty request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: {},
      },
      expectedId: '6kq-PYTyXtaGAHTHCVUrc_hIsAwLeskeQFtDZerMYhM',
    },
    {
      label: 'different realm',
      params: {
        realm: 'payments.other.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
      },
      expectedId: '-gMjd8UeUvBcqUaUzarVj6ikH_YoDowpaNbEwK1Tmx8',
    },
    {
      label: 'different method',
      params: {
        realm: 'api.example.com',
        method: 'stripe',
        intent: 'charge',
        request: { amount: '1000000' },
      },
      expectedId: 'DRH9ycmIlZ2lYUatIHCrxpm9K7ig5pniZ3ulleb7vl0',
    },
    {
      label: 'different intent',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'session',
        request: { amount: '1000000' },
      },
      expectedId: 'INeBi93MhinvbwdUxeUUIaT5Q_ufgLKPYZb5Tg43A1o',
    },
  ] as const

  test.each(hmacVectors)('hmac: $label', ({ params, expectedId }) => {
    const challenge = Challenge.from({ ...params, secretKey: 'test-vector-secret' })
    expect(challenge.id).toBe(expectedId)
  })

  test('hmac: description does not affect id', () => {
    const withDesc = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      description: 'Test payment',
      secretKey: 'test-vector-secret',
    })
    const without = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'test-vector-secret',
    })
    expect(withDesc.id).toBe(without.id)
  })

  test('hmac: same params with same secretKey produce same id', () => {
    const challenge1 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'secret',
    })
    const challenge2 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'secret',
    })

    expect(challenge1.id).toBe(challenge2.id)
  })

  test('hmac: different secretKey produces different id', () => {
    const challenge1 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'secret1',
    })
    const challenge2 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'secret2',
    })

    expect(challenge1.id).not.toBe(challenge2.id)
  })
})

describe('fromMethod', () => {
  test('behavior: creates validated challenge from intent', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'abc123',
      realm: 'api.example.com',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        expires: '2025-01-06T12:00:00Z',
      },
    })

    expect(challenge).toMatchInlineSnapshot(`
      {
        "expires": "2025-01-06T12:00:00Z",
        "id": "abc123",
        "intent": "charge",
        "method": "tempo",
        "realm": "api.example.com",
        "request": {
          "amount": "1000000",
          "currency": "0x20c0000000000000000000000000000000000001",
          "expires": "2025-01-06T12:00:00Z",
          "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
        },
      }
    `)
  })

  test('behavior: includes methodDetails in request', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'abc123',
      realm: 'api.example.com',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        expires: '2025-01-06T12:00:00Z',
        chainId: 42431,
        feePayer: true,
      },
    })

    expect(challenge).toMatchInlineSnapshot(`
      {
        "expires": "2025-01-06T12:00:00Z",
        "id": "abc123",
        "intent": "charge",
        "method": "tempo",
        "realm": "api.example.com",
        "request": {
          "amount": "1000000",
          "currency": "0x20c0000000000000000000000000000000000001",
          "expires": "2025-01-06T12:00:00Z",
          "methodDetails": {
            "chainId": 42431,
            "feePayer": true,
          },
          "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
        },
      }
    `)
  })

  test('behavior: includes optional digest and expires', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'abc123',
      realm: 'api.example.com',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        expires: '2025-01-06T12:00:00Z',
      },
      digest: 'sha-256=abc',
      expires: '2025-01-06T12:00:00Z',
    })

    expect(challenge.digest).toBe('sha-256=abc')
    expect(challenge.expires).toBe('2025-01-06T12:00:00Z')
  })

  test('behavior: creates challenge with HMAC-bound id via secretKey', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      realm: 'api.example.com',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        expires: '2025-01-06T12:00:00Z',
      },
      secretKey: 'my-secret',
    })

    expect(challenge.id).toBeDefined()
    expect(typeof challenge.id).toBe('string')
    expect(challenge.id.length).toBeGreaterThan(0)
  })

  test('error: invalid request', () => {
    expect(() =>
      Challenge.fromMethod(Methods.charge, {
        id: 'abc123',
        realm: 'api.example.com',
        request: {
          amount: 123,
          currency: '0x20c0000000000000000000000000000000000001',
          recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
          expires: '2025-01-06T12:00:00Z',
        } as any,
      }),
    ).toThrow()
  })
})

describe('serialize', () => {
  test('behavior: serializes challenge to WWW-Authenticate header', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000', currency: 'USD' },
    })

    const header = Challenge.serialize(challenge)
    expect(header).toMatch(/^Payment /)
    expect(header).toContain('id="abc123"')
    expect(header).toContain('realm="api.example.com"')
    expect(header).toContain('method="tempo"')
    expect(header).toContain('intent="charge"')
    expect(header).toContain('request="')
  })

  test('behavior: includes optional fields', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      digest: 'sha-256=abc',
      expires: '2025-01-06T12:00:00Z',
    })

    const header = Challenge.serialize(challenge)
    expect(header).toContain('digest="sha-256=abc"')
    expect(header).toContain('expires="2025-01-06T12:00:00Z"')
  })
})

describe('deserialize', () => {
  test('behavior: deserializes WWW-Authenticate header', () => {
    const original = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000', currency: 'USD' },
    })

    const header = Challenge.serialize(original)
    const challenge = Challenge.deserialize(header)

    expect(challenge).toMatchInlineSnapshot(`
      {
        "id": "abc123",
        "intent": "charge",
        "method": "tempo",
        "realm": "api.example.com",
        "request": {
          "amount": "1000000",
          "currency": "USD",
        },
      }
    `)
  })

  test('behavior: roundtrips with optional fields', () => {
    const original = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      digest: 'sha-256=abc',
      expires: '2025-01-06T12:00:00Z',
    })

    const header = Challenge.serialize(original)
    const challenge = Challenge.deserialize(header)

    expect(challenge?.digest).toBe('sha-256=abc')
    expect(challenge?.expires).toBe('2025-01-06T12:00:00Z')
  })

  test('error: throws for missing Payment scheme', () => {
    expect(() => Challenge.deserialize('Bearer token')).toThrow('Missing Payment scheme.')
  })

  test('error: missing required fields', () => {
    expect(() => Challenge.deserialize('Payment realm="test"')).toThrow()
  })
})

describe('fromHeaders', () => {
  test('behavior: extracts challenge from Headers object', () => {
    const original = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    })

    const headers = new Headers({ 'WWW-Authenticate': Challenge.serialize(original) })
    const challenge = Challenge.fromHeaders(headers)

    expect(challenge.id).toBe('abc123')
    expect(challenge.realm).toBe('api.example.com')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
  })

  test('error: throws for missing WWW-Authenticate header', () => {
    const headers = new Headers()
    expect(() => Challenge.fromHeaders(headers)).toThrow('Missing WWW-Authenticate header.')
  })
})

describe('fromResponse', () => {
  test('behavior: extracts challenge from 402 response', () => {
    const original = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    })

    const response = new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': Challenge.serialize(original) },
    })

    const challenge = Challenge.fromResponse(response)
    expect(challenge.id).toBe('abc123')
    expect(challenge.realm).toBe('api.example.com')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
  })

  test('error: throws for non-402 status', () => {
    const response = new Response(null, { status: 401 })
    expect(() => Challenge.fromResponse(response)).toThrow('Response status is not 402.')
  })

  test('error: throws for missing WWW-Authenticate header', () => {
    const response = new Response(null, { status: 402 })
    expect(() => Challenge.fromResponse(response)).toThrow('Missing WWW-Authenticate header.')
  })
})

describe('verifyId', () => {
  test('behavior: returns true for valid HMAC-bound id', () => {
    const challenge = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'my-secret',
    })

    expect(Challenge.verify(challenge, { secretKey: 'my-secret' })).toBe(true)
  })

  test('behavior: returns false for wrong secretKey', () => {
    const challenge = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'my-secret',
    })

    expect(Challenge.verify(challenge, { secretKey: 'wrong-secret' })).toBe(false)
  })

  test('behavior: returns false for tampered challenge', () => {
    const challenge = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'my-secret',
    })

    const tampered = { ...challenge, request: { amount: '2000000' } }
    expect(Challenge.verify(tampered, { secretKey: 'my-secret' })).toBe(false)
  })
})
