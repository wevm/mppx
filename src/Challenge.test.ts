import { Challenge } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vp/test'

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
  // HMAC input: realm | method | intent | base64url(canonicalize(request)) | expires | digest | opaque
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
      expectedId: 'X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4',
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
      expectedId: 'ChPX33RkKSZoSUyZcu8ai4hhkvjZJFkZVnvWs5s0iXI',
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
      expectedId: 'JHB7EFsPVb-xsYCo8LHcOzeX1gfXWVoUSzQsZhKAfKM',
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
      expectedId: 'm39jbWWCIfmfJZSwCfvKFFtBl0Qwf9X4nOmDb21peLA',
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
      expectedId: 'X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4',
    },
    {
      label: 'with multi-field request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000', currency: '0x1234', recipient: '0xabcd' },
      },
      expectedId: '_H5TOnnlW0zduQ5OhQ3EyLVze_TqxLDPda2CGZPZxOc',
    },
    {
      label: 'with nested methodDetails in request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000', currency: '0x1234', methodDetails: { chainId: 42431 } },
      },
      expectedId: 'TqujwpuDDg_zsWGINAd5XObO2rRe6uYufpqvtDmr6N8',
    },
    {
      label: 'with empty request',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: {},
      },
      expectedId: 'yLN7yChAejW9WNmb54HpJIWpdb1WWXeA3_aCx4dxmkU',
    },
    {
      label: 'different realm',
      params: {
        realm: 'payments.other.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
      },
      expectedId: '3F5bOo2a9RUihdwKk4hGRvBvzQmVPBMDvW0YM-8GD00',
    },
    {
      label: 'different method',
      params: {
        realm: 'api.example.com',
        method: 'stripe',
        intent: 'charge',
        request: { amount: '1000000' },
      },
      expectedId: 'o0ra2sd7HcB4Ph0Vns69gRDUhSj5WNOnUopcDqKPLz4',
    },
    {
      label: 'different intent',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'session',
        request: { amount: '1000000' },
      },
      expectedId: 'aAY7_IEDzsznNYplhOSE8cERQxvjFcT4Lcn-7FHjLVE',
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
      expires: '2025-01-06T12:00:00Z',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
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
          "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
        },
      }
    `)
  })

  test('behavior: includes methodDetails in request', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'abc123',
      realm: 'api.example.com',
      expires: '2025-01-06T12:00:00Z',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
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
      expires: '2025-01-06T12:00:00Z',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
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
  const paymentHeader = Challenge.serialize(
    Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000', currency: 'USD' },
    }),
  )

  test('behavior: deserializes WWW-Authenticate header', () => {
    const challenge = Challenge.deserialize(paymentHeader)

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

  test.each([
    { name: 'single Payment scheme', header: paymentHeader },
    { name: 'Payment after another scheme', header: `Bearer realm="api", ${paymentHeader}` },
    {
      name: 'scheme token is case-insensitive',
      header: paymentHeader.replace(/^Payment /, 'payment '),
    },
    {
      name: 'quoted values in previous schemes do not interfere',
      header: `Bearer error_description="retry with Payment challenge", ${paymentHeader}`,
    },
    {
      name: 'parses Payment params before the next scheme token',
      header: `${paymentHeader}, Bearer realm="fallback"`,
    },
  ])('behavior: extracts challenge for $name', ({ header }) => {
    const challenge = Challenge.deserialize(header)

    expect(challenge.id).toBe('abc123')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
  })

  const request = /request="([^"]+)"/.exec(paymentHeader)?.[1]
  if (!request) throw new Error('request missing from serialized challenge')

  test.each([
    {
      name: 'escaped quotes',
      headerValue: 'premium \\"access\\"',
      expected: 'premium "access"',
    },
    {
      name: 'escaped comma',
      headerValue: 'tier\\,premium',
      expected: 'tier,premium',
    },
    {
      name: 'escaped backslash',
      headerValue: 'path\\\\alpha',
      expected: 'path\\alpha',
    },
  ])('behavior: deserializes $name in quoted-string values', ({ headerValue, expected }) => {
    const header =
      'Payment id="abc123", realm="api.example.com", method="tempo", intent="charge", request="' +
      request +
      `", description="${headerValue}"`

    const challenge = Challenge.deserialize(header)
    expect(challenge.description).toBe(expected)
  })

  test.each([
    {
      name: 'missing Payment scheme',
      header: 'Bearer token',
      error: 'Missing Payment scheme.',
    },
    {
      name: 'duplicate parameters',
      header: 'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", id="b"',
      error: 'Duplicate parameter: id',
    },
    {
      name: 'unterminated quoted-string',
      header:
        'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", description="oops',
      error: 'Unterminated quoted-string.',
    },
    {
      name: 'invalid method casing',
      header: 'Payment id="a", realm="api", method="Tempo", intent="charge", request="e30"',
      error: 'Invalid method: "Tempo". Must be lowercase per spec.',
    },
    {
      name: 'malformed auth-param',
      header:
        'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", ="value"',
      error: 'Malformed auth-param.',
    },
  ])('error: throws for $name', ({ header, error }) => {
    expect(() => Challenge.deserialize(header)).toThrow(error)
  })

  test('error: missing required fields', () => {
    expect(() => Challenge.deserialize('Payment realm="test"')).toThrow()
  })

  test('error: missing request parameter after valid Payment scheme', () => {
    expect(() =>
      Challenge.deserialize(
        'Bearer realm="api", Payment id="a", realm="api", method="tempo", intent="charge"',
      ),
    ).toThrow('Missing request parameter.')
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

describe('opaque', () => {
  test('behavior: meta sets opaque on challenge via from()', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
    })

    expect(challenge.opaque).toEqual({ pi: 'pi_3abc123XYZ' })
    expect((challenge.request as Record<string, unknown>).opaque).toBeUndefined()
  })

  test('behavior: meta sets opaque on challenge via fromMethod()', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'abc123',
      realm: 'api.example.com',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      },
      meta: { payment_intent: 'pi_3abc123XYZ' },
    })

    expect(challenge.opaque).toEqual({ payment_intent: 'pi_3abc123XYZ' })
  })

  test('behavior: challenge.opaque is undefined when no meta', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    })

    expect(challenge.opaque).toBeUndefined()
  })

  test('behavior: opaque roundtrips through serialize/deserialize', () => {
    const original = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ', deposit: 'dep_456' },
    })

    const header = Challenge.serialize(original)
    const deserialized = Challenge.deserialize(header)

    expect(deserialized.opaque).toEqual({ pi: 'pi_3abc123XYZ', deposit: 'dep_456' })
  })

  test('behavior: meta with empty object produces opaque: {}', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: {},
    })

    expect(challenge.opaque).toEqual({})
  })

  test('hmac: opaque affects challenge ID', () => {
    const withMeta = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
      secretKey: 'test-secret',
    })

    const withoutMeta = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      secretKey: 'test-secret',
    })

    expect(withMeta.id).not.toBe(withoutMeta.id)
  })

  test('hmac: different opaque values produce different IDs', () => {
    const meta1 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_111' },
      secretKey: 'test-secret',
    })

    const meta2 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_222' },
      secretKey: 'test-secret',
    })

    expect(meta1.id).not.toBe(meta2.id)
  })

  test('hmac: same opaque produces same ID', () => {
    const challenge1 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
      secretKey: 'test-secret',
    })

    const challenge2 = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
      secretKey: 'test-secret',
    })

    expect(challenge1.id).toBe(challenge2.id)
  })

  test('hmac: verify succeeds with opaque', () => {
    const challenge = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
      secretKey: 'my-secret',
    })

    expect(Challenge.verify(challenge, { secretKey: 'my-secret' })).toBe(true)
  })

  test('hmac: verify detects tampered opaque', () => {
    const challenge = Challenge.from({
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: { pi: 'pi_3abc123XYZ' },
      secretKey: 'my-secret',
    })

    const tampered = {
      ...challenge,
      opaque: { pi: 'pi_TAMPERED' },
    }
    expect(Challenge.verify(tampered, { secretKey: 'my-secret' })).toBe(false)
  })

  test('behavior: multiple key-value pairs in opaque', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: {
        payment_intent: 'pi_3abc123XYZ',
        customer: 'cus_xyz',
        session_id: 'sess_abc',
      },
    })

    expect(challenge.opaque).toEqual({
      payment_intent: 'pi_3abc123XYZ',
      customer: 'cus_xyz',
      session_id: 'sess_abc',
    })
  })
})
