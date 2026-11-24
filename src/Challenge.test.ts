import { Challenge, Constants, Credential, PaymentRequest } from 'mppx'
import { Methods } from 'mppx/tempo'
import { Base64, Bytes, Hash } from 'ox'
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

  test('behavior: accepts expires as a Date', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      expires: new Date('2025-01-06T12:00:00Z'),
    })

    expect(challenge.expires).toBe('2025-01-06T12:00:00.000Z')
  })

  test('behavior: preserves an alternate credential header', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      header: Constants.Headers.paymentAuthorization,
    })

    expect(Challenge.serialize(challenge)).toContain(
      `header="${Constants.Headers.paymentAuthorization}"`,
    )
    expect(Challenge.credentialHeader(Challenge.deserialize(Challenge.serialize(challenge)))).toBe(
      Constants.Headers.paymentAuthorization,
    )
  })

  test('behavior: omits the default credential header', () => {
    const parameters = {
      secretKey: 'test-secret-key-test-secret-key-32',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    }
    const challenge = Challenge.from({ ...parameters, header: Constants.Headers.authorization })
    const implicitChallenge = Challenge.from(parameters)

    expect(challenge.header).toBeUndefined()
    expect(challenge.id).toBe(implicitChallenge.id)
    expect(Challenge.serialize(challenge)).not.toContain('header=')
    expect(Challenge.credentialHeader(challenge)).toBe(Constants.Headers.authorization)
  })

  test.each(['authorization', 'AUTHORIZATION'])(
    'behavior: treats %s as the default credential header',
    (header) => {
      const challenge = Challenge.from({
        id: 'abc123',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        header,
      })

      expect(challenge.header).toBeUndefined()
      expect(Challenge.serialize(challenge)).not.toContain('header=')
    },
  )

  test('behavior: canonicalizes the Payment-Authorization credential header', () => {
    const parameters = {
      secretKey: 'test-secret-key-test-secret-key-32',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    }
    const challenge = Challenge.from({ ...parameters, header: 'payment-authorization' })
    const canonical = Challenge.from({
      ...parameters,
      header: Constants.Headers.paymentAuthorization,
    })

    expect(challenge.header).toBe(Constants.Headers.paymentAuthorization)
    expect(challenge.id).toBe(canonical.id)
    expect(Challenge.serialize(challenge)).toContain('header="Payment-Authorization"')
  })

  test.each(['X-Payment', 'Payment-Credential', ''])(
    'error: rejects the credential header "%s"',
    (header) => {
      expect(() =>
        Challenge.from({
          id: 'abc123',
          realm: 'api.example.com',
          method: 'tempo',
          intent: 'charge',
          request: { amount: '1000000' },
          header,
        }),
      ).toThrow('Unsupported credential header')
    },
  )

  test('error: rejects empty id', () => {
    expect(() =>
      Challenge.from({
        id: '',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
      }),
    ).toThrow()
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
      label: 'with opaque',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        meta: { pi: 'pi_3abc123XYZ' },
      },
      expectedId: 'rxzKZ2qjXvinqCH96RORTZEPs1KXsA-0AUjrCAPFOWc',
    },
    {
      label: 'with opaque and expires',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        expires: '2025-01-06T12:00:00Z',
        meta: { pi: 'pi_3abc123XYZ' },
      },
      expectedId: 'KAfoMrA4fnzS1DPWN_cUv_b3_yHxCizdp6OhH7gluMY',
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
      label: 'with empty opaque',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        meta: {},
      },
      expectedId: 'vb4IyH-0LdJ3s7L0QAw8jIzcZkyxksPhIvEfmHmzA9k',
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
    {
      label: 'with multi-key opaque',
      params: {
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        meta: { deposit: 'dep_456', pi: 'pi_3abc123XYZ' },
      },
      expectedId: 'aKskU8sadR5ZuFbUCsIwhO-ENxuVpTw17FdwHEXsJDk',
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

  test('error: rejects explicit empty id instead of falling back to secretKey', () => {
    expect(() =>
      Challenge.fromMethod(Methods.charge, {
        id: '',
        secretKey: 'my-secret',
        realm: 'api.example.com',
        request: {
          amount: '1',
          currency: '0x20c0000000000000000000000000000000000001',
          decimals: 6,
          recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        },
      } as any),
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

  test.each([
    {
      description: 'Plain payment description',
      escaped: 'Plain payment description',
      label: 'plain values',
    },
    {
      description: 'Pay "premium"',
      escaped: 'Pay \\"premium\\"',
      label: 'double quotes',
    },
    {
      description: 'Path C:\\tempo\\api',
      escaped: 'Path C:\\\\tempo\\\\api',
      label: 'backslashes',
    },
    {
      description: 'Pay "premium" path C:\\tempo\\api',
      escaped: 'Pay \\"premium\\" path C:\\\\tempo\\\\api',
      label: 'mixed quotes and backslashes',
    },
    {
      description: 'Ends with slash \\',
      escaped: 'Ends with slash \\\\',
      label: 'trailing backslash',
    },
    {
      description: 'caf\u00e9 na\u00efve',
      escaped: 'caf\u00e9 na\u00efve',
      label: 'raw Latin-1',
    },
  ])('behavior: escapes quoted-string values: $label', ({ description, escaped }) => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      description,
    })

    const header = Challenge.serialize(challenge)
    expect(header).toContain(`description="${escaped}"`)
    expect(Challenge.deserialize(header).description).toBe(description)
  })

  test.each([
    {
      description: '1 \u00d7 Classmatic \u2014 General Admission',
      escaped: '1 \u00d7 Classmatic \\u2014 General Admission',
      parsed: '1 \u00d7 Classmatic u2014 General Admission',
      label: 'characters above Latin-1 (em dash)',
    },
    {
      description: 'Tickets \ud83c\udf9f\ufe0f "VIP"',
      escaped: 'Tickets \\ud83c\\udf9f\\ufe0f \\"VIP\\"',
      parsed: 'Tickets ud83cudf9fufe0f "VIP"',
      label: 'surrogate pairs and quotes',
    },
  ])(
    'behavior: escapes description characters above Latin-1 as display-only text: $label',
    ({ description, escaped, parsed }) => {
      const challenge = Challenge.from({
        id: 'abc123',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        description,
      })

      const header = Challenge.serialize(challenge)
      expect(header).toContain(`description="${escaped}"`)
      // quoted-pair keeps the escaped character, not a decoded code point.
      expect(Challenge.deserialize(header).description).toBe(parsed)
    },
  )

  test.each(['realm', 'intent', 'id'] as const)(
    'error: rejects characters above Latin-1 in %s',
    (field) => {
      const challenge = Challenge.from({
        id: 'abc123',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '1000000' },
        [field]: 'merchant\u2014api',
      })

      expect(() => Challenge.serialize(challenge)).toThrow(
        `Invalid ${field}: characters above U+00FF cannot be sent in a header.`,
      )
    },
  )

  test.each(['Tempo', 'tempo2', 'x402', 'a1:b_2-c', 'my-method', ''])(
    'error: rejects method %j outside the a-z grammar',
    (method) => {
      const challenge = Challenge.from({
        id: 'abc123',
        realm: 'api.example.com',
        method,
        intent: 'charge',
        request: { amount: '1000000' },
      })
      expect(() => Challenge.serialize(challenge)).toThrow(`Invalid method: "${method}"`)
    },
  )

  test('behavior: serialized challenges are valid HTTP header values', () => {
    const description = '1 \u00d7 Classmatic \u2014 General Admission \ud83c\udf9f\ufe0f'
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      description,
    })

    const header = Challenge.serialize(challenge)
    // Header values are ByteStrings: anything above 0xFF makes Response
    // construction throw in fetch-compliant runtimes.
    expect([...header].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true)
    expect(() => new Headers({ 'WWW-Authenticate': header })).not.toThrow()
  })

  test('error: rejects CRLF in quoted-string values', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      description: 'Line one\r\nLine two',
    })

    expect(() => Challenge.serialize(challenge)).toThrow('Invalid quoted-string value.')
  })
})

describe('serialize: credential header', () => {
  const challenge = {
    id: 'abc123',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '1000000' },
  }

  test.each([
    { header: undefined, expected: undefined },
    { header: 'Authorization', expected: undefined },
    { header: 'authorization', expected: undefined },
    { header: 'Payment-Authorization', expected: 'Payment-Authorization' },
    { header: 'payment-authorization', expected: 'payment-authorization' },
  ])('behavior: serializes header $header as $expected', ({ header, expected }) => {
    const serialized = Challenge.serialize({ ...challenge, header })
    if (expected === undefined) expect(serialized).not.toContain('header=')
    else expect(serialized).toContain(`header="${expected}"`)
  })

  test.each(['X-Payment', ''])(
    'error: refuses to serialize the credential header "%s"',
    (header) => {
      expect(() => Challenge.serialize({ ...challenge, header })).toThrow(
        'Unsupported credential header',
      )
    },
  )
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

  test('behavior: reads \\uXXXX in a quoted-string as quoted-pair, not a unicode escape', () => {
    const challenge = Challenge.deserialize(
      'Payment id="a", realm="merchant\\u2014api.example.com", method="tempo", intent="charge", request="e30", description="literal \\\\u2014"',
    )
    expect(challenge.realm).toBe('merchantu2014api.example.com')
    expect(challenge.description).toBe('literal \\u2014')
  })

  test.each([
    { name: 'realm \\u00e9', params: 'realm="caf\\u00e9.example.com"', legacy: true },
    { name: 'realm \\u2014', params: 'realm="merchant\\u2014api"', legacy: true },
    { name: 'uppercase hex', params: 'realm="caf\\u00E9", opaque="x"', legacy: true },
    { name: 'other bound param', params: 'realm="a", digest="sha-256=\\u00e9"', legacy: true },
    { name: 'escaped quote', params: 'realm="say \\"hi\\""', legacy: false },
    { name: 'escaped backslash', params: 'realm="a\\\\u00e9"', legacy: false },
    { name: 'not four hex digits', params: 'realm="\\u00g9"', legacy: false },
    { name: 'description only', params: 'realm="a", description="caf\\u00e9"', legacy: false },
    { name: 'unknown param', params: 'realm="a", foo="caf\u00e9"', legacy: false },
  ])(
    'behavior: flags a legacy \\uXXXX escape in a bound parameter ($name)',
    ({ params, legacy }) => {
      const challenge = Challenge.deserialize(
        `Payment id="a", ${params}, method="tempo", intent="charge", request="e30"`,
      )
      expect(Challenge.isLegacyUnicodeEscaped(challenge)).toBe(legacy)
      // The flag stays out of the JSON and wire forms.
      expect(JSON.stringify(challenge)).not.toContain('legacy')
      expect(Challenge.isLegacyUnicodeEscaped({ ...challenge })).toBe(legacy)
      // Re-serializing would drop the escape that marks it.
      if (legacy) expect(() => Challenge.serialize(challenge)).toThrow('Legacy unicode-escaped')
      else expect(() => Challenge.serialize(challenge)).not.toThrow()
      if (legacy)
        expect(() => Challenge.assertNotLegacyUnicodeEscaped(challenge)).toThrow(
          'Legacy unicode-escaped challenge: the server escaped a bound parameter as \\uXXXX; upgrade the server.',
        )
    },
  )

  test.each([
    {
      name: 'uppercase',
      header: paymentHeader.replace(/\b(id|realm|method|intent|request)=/g, (param) =>
        param.toUpperCase(),
      ),
    },
    {
      name: 'mixed-case',
      header: paymentHeader.replace(
        /\b(id|realm|method|intent|request)=/g,
        (param) => `${param[0]?.toUpperCase()}${param.slice(1)}`,
      ),
    },
  ])('behavior: deserializes $name auth-param names', ({ header }) => {
    expect(Challenge.deserialize(header)).toEqual(Challenge.deserialize(paymentHeader))
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

  test.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'behavior: accepts extension parameter named %s',
    (name) => {
      const header = `${paymentHeader}, ${name}="value"`

      expect(Challenge.deserialize(header).id).toBe('abc123')
      expect(() => Challenge.deserialize(`${header}, ${name}="duplicate"`)).toThrow(
        `Duplicate parameter: ${name.toLowerCase()}`,
      )
    },
  )

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
      name: 'case-insensitive duplicate parameters',
      header: 'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", ID="b"',
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
      error: 'Invalid method: "Tempo". Must be lowercase letters a-z per spec.',
    },
    {
      name: 'method with digits',
      header: 'Payment id="a", realm="api", method="tempo2", intent="charge", request="e30"',
      error: 'Invalid method: "tempo2". Must be lowercase letters a-z per spec.',
    },
    {
      name: 'method with punctuation',
      header: 'Payment id="a", realm="api", method="a1:b_2-c", intent="charge", request="e30"',
      error: 'Invalid method: "a1:b_2-c". Must be lowercase letters a-z per spec.',
    },
    {
      name: 'malformed auth-param',
      header:
        'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", ="value"',
      error: 'Malformed auth-param.',
    },
    {
      name: 'empty id',
      header: 'Payment id="", realm="api", method="tempo", intent="charge", request="e30"',
      error: 'Invalid input',
    },
  ])('error: throws for $name', ({ header, error }) => {
    expect(() => Challenge.deserialize(header)).toThrow(error)
  })

  test.each([
    {
      name: 'params without commas',
      header: 'Payment method="tempo" realm="api" intent="charge" request="e30" id="a"',
    },
    {
      name: 'text after a closing quote',
      header:
        'Payment id="a", method="tempo", intent="charge", request="e30", realm="p"ay.example.com:8443"',
    },
    {
      name: 'unquoted value followed by another param without a comma',
      header: 'Payment id="a", method=tempo realm="api", intent="charge", request="e30"',
    },
    {
      name: 'unquoted value with a non-token character',
      header: 'Payment id="a", realm=api/v1, method="tempo", intent="charge", request="e30"',
    },
    {
      name: 'empty unquoted value',
      header: 'Payment id="a", realm=, method="tempo", intent="charge", request="e30"',
    },
  ])('error: rejects malformed auth-param list ($name)', ({ header }) => {
    expect(() => Challenge.deserialize(header)).toThrow('Malformed auth-param.')
  })

  test('behavior: parses token values and OWS around commas', () => {
    const challenge = Challenge.deserialize(
      'Payment id=a ,realm=api.example.com ,  method=tempo,intent=charge , request=e30 ',
    )
    expect(challenge).toMatchObject({
      id: 'a',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
    })
  })

  test.each([
    'Payment id="a", realm="api", method="tempo", intent="charge", request="e30", Basic realm="x"',
    'Basic realm="x", Payment id="a", realm="api", method="tempo", intent="charge", request="e30"',
    'Payment id=a, realm=api, method=tempo, intent=charge, request=e30, Bearer token68==',
  ])('behavior: parses Payment beside other schemes (%s)', (header) => {
    expect(Challenge.deserialize(header)).toMatchObject({ id: 'a', realm: 'api' })
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

  test('error: rejects oversized request parameter before decoding', () => {
    const oversizedRequest = 'a'.repeat(16 * 1024 + 1)
    const header = `Payment id="a", realm="api", method="tempo", intent="charge", request="${oversizedRequest}"`

    expect(() => Challenge.deserialize(header)).toThrow('Request parameter too large.')
  })

  test.each([
    { header: undefined, expected: Constants.Headers.authorization },
    { header: 'Payment-Authorization', expected: Constants.Headers.paymentAuthorization },
    { header: 'payment-authorization', expected: Constants.Headers.paymentAuthorization },
    { header: 'Authorization', expected: undefined },
    { header: '', expected: undefined },
    { header: 'X-Payment', expected: undefined },
  ])(
    'behavior: credential header $header selects $expected (undefined: rejected)',
    ({ header, expected }) => {
      const value = header === undefined ? paymentHeader : `${paymentHeader}, header="${header}"`

      if (expected === undefined) {
        expect(() => Challenge.deserialize(value)).toThrow(
          'Unsupported credential header: challenges may only select Payment-Authorization.',
        )
        return
      }
      const challenge = Challenge.deserialize(value)
      expect(Challenge.credentialHeader(challenge)).toBe(expected)
      // The received spelling is kept so the credential echoes it unchanged.
      expect(challenge.header).toBe(header)
    },
  )
})

describe('credential header binding', () => {
  const secretKey = 'test-secret-key-test-secret-key-32'
  const realm = 'api.example.com'
  const request = { amount: '1000000' }

  // A server that bound the lowercase spelling, as earlier releases did for `header` as configured.
  function lowercaseBoundChallenge(): Challenge.Challenge {
    const header = 'payment-authorization'
    const input = [realm, 'tempo', 'charge', PaymentRequest.serialize(request), '', '', header, '']
    const mac = Hash.hmac256(Bytes.fromString(secretKey), Bytes.fromString(input.join('|')), {
      as: 'Bytes',
    })
    const id = Base64.fromBytes(mac, { url: true, pad: false })
    return { id, realm, method: 'tempo', intent: 'charge', request, header }
  }

  test('behavior: a lowercase-bound challenge verifies after a client round trip', () => {
    const issued = lowercaseBoundChallenge()
    expect(Challenge.verify(issued, { secretKey })).toBe(true)

    const wire = Challenge.serialize(issued)
    expect(wire).toContain('header="payment-authorization"')

    const received = Challenge.deserialize(wire)
    expect(received.header).toBe('payment-authorization')
    expect(Challenge.credentialHeader(received)).toBe(Constants.Headers.paymentAuthorization)

    const credential = Credential.deserialize(
      Credential.serialize({ challenge: received, payload: { signature: '0x' } }),
    )
    expect(credential.challenge.header).toBe('payment-authorization')
    expect(Challenge.verify(credential.challenge, { secretKey })).toBe(true)
    // Rewriting the echoed spelling breaks the binding.
    expect(
      Challenge.verify(
        { ...credential.challenge, header: Constants.Headers.paymentAuthorization },
        { secretKey },
      ),
    ).toBe(false)
  })

  test('behavior: locally constructed challenges bind and emit the canonical spelling', () => {
    const issued = Challenge.from({
      secretKey,
      realm,
      method: 'tempo',
      intent: 'charge',
      request,
      header: 'payment-authorization',
    })
    expect(issued.header).toBe(Constants.Headers.paymentAuthorization)
    expect(issued.id).not.toBe(lowercaseBoundChallenge().id)

    const received = Challenge.deserialize(Challenge.serialize(issued))
    expect(received.header).toBe(Constants.Headers.paymentAuthorization)
    expect(Challenge.verify(received, { secretKey })).toBe(true)
  })

  test.each(['X-Payment', 'Payment-Credential', ''])(
    'behavior: verify returns false for the credential header "%s"',
    (header) => {
      const issued = Challenge.from({
        secretKey,
        realm,
        method: 'tempo',
        intent: 'charge',
        request,
      })
      expect(Challenge.verify({ ...issued, header }, { secretKey })).toBe(false)
    },
  )
})

describe('deserializeList', () => {
  const baseChallenge = {
    id: 'first',
    realm: 'api.example.com',
    method: 'stripe',
    intent: 'charge',
    request: { amount: '50', currency: 'usd' },
  } satisfies Challenge.Challenge
  const secondHeader = Challenge.serialize({
    id: 'second',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '1000000', currency: 'USD' },
  })

  test('behavior: skips an offer whose method id is outside a-z', () => {
    const invalid = secondHeader
      .replace('method="tempo"', 'method="tempo2"')
      .replace('id="second"', 'id="invalid"')

    const challenges = Challenge.deserializeList(`${invalid}, ${secondHeader}`)

    expect(challenges).toHaveLength(1)
    expect(challenges[0]).toMatchObject({ id: 'second', method: 'tempo' })
  })

  test('behavior: parses the reported Stripe and Tempo header with payment in description', () => {
    const stripeHeader =
      'Payment id="k3fGx9QpLmZ2vT8sWyR4nB6cD1eH5jA7uN0iO2aS9dU", realm="example.com", method="stripe", intent="charge", request="eyJhbW91bnQiOiI1MCIsImN1cnJlbmN5IjoidXNkIiwiZXh0ZXJuYWxJZCI6Im9yZGVyLTEyMyIsIm1ldGhvZERldGFpbHMiOnsibmV0d29ya0lkIjoicHJvZmlsZV8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicGF5bWVudE1ldGhvZFR5cGVzIjpbImNhcmQiLCJsaW5rIl19fQ", description="Agentcash card payment test", expires="2026-09-01T00:00:00.000Z", opaque="eyJfbXBweF9zY29wZSI6ImNvZmZlZXNob3A6b3JkZXI6b3JkZXItMTIzOnBheSJ9"'

    const challenges = Challenge.deserializeList(`${stripeHeader}, ${secondHeader}`)

    expect(challenges).toHaveLength(2)
    expect(challenges[0]).toMatchObject({
      id: 'k3fGx9QpLmZ2vT8sWyR4nB6cD1eH5jA7uN0iO2aS9dU',
      method: 'stripe',
      description: 'Agentcash card payment test',
    })
    expect(challenges[1]).toMatchObject({ id: 'second', method: 'tempo' })
  })

  test.each([
    ['description', 'Agentcash card payment test'],
    ['description', 'Payment at the start'],
    ['description', 'Use "Payment now", then retry \\'],
    ['description', 'comma, Payment fake challenge'],
    ['id', 'id with Payment text'],
    ['intent', 'payment plan'],
    ['realm', 'Payment realm'],
    ['opaque', 'opaque Payment value'],
  ] as const)('behavior: ignores scheme-like text in the %s parameter', (field, value) => {
    const firstHeader = Challenge.serialize({ ...baseChallenge, [field]: value })
    const challenges = Challenge.deserializeList(`${firstHeader}, ${secondHeader}`)

    expect(challenges).toHaveLength(2)
    expect(challenges[0]?.[field]).toBe(value)
    expect(challenges[1]).toMatchObject({ id: 'second', method: 'tempo' })
  })

  test('behavior: finds case-insensitive Payment schemes among other auth schemes', () => {
    const firstHeader = Challenge.serialize(baseChallenge)
    const header =
      `Bearer error_description="use Payment challenge", ${firstHeader}, ` +
      `Digest realm="fallback Payment realm", ${secondHeader.replace(/^Payment /, 'pAyMeNt\t')}`

    expect(Challenge.deserializeList(header).map(({ id }) => id)).toEqual(['first', 'second'])
  })

  test('error: quoted Payment text is not treated as a challenge', () => {
    const header = 'Bearer error_description="use Payment challenge"'

    expect(() => Challenge.deserializeList(header)).toThrow('No Payment schemes found.')
  })

  test.each(['Authorization', 'X-Payment', ''])(
    'behavior: skips a challenge with the credential header "%s"',
    (header) => {
      const unsupported = `${Challenge.serialize(baseChallenge)}, header="${header}"`

      expect(
        Challenge.deserializeList(`${unsupported}, ${secondHeader}`).map(({ id }) => id),
      ).toEqual(['second'])
      expect(Challenge.deserializeList(unsupported)).toEqual([])
    },
  )

  test('behavior: counts challenges skipped for their credential header', () => {
    const unsupported = `${Challenge.serialize(baseChallenge)}, header="X-Payment"`
    const supported = `${secondHeader}, header="Payment-Authorization"`

    expect(Challenge.countUnsupportedCredentialHeaders(`${unsupported}, ${supported}`)).toBe(1)
    expect(Challenge.countUnsupportedCredentialHeaders(`${unsupported}, ${unsupported}`)).toBe(2)
    expect(Challenge.countUnsupportedCredentialHeaders(supported)).toBe(0)
    expect(Challenge.countUnsupportedCredentialHeaders(null)).toBe(0)
    expect(Challenge.withSkippedChallenges('No method found', 0)).toBe('No method found')
    expect(Challenge.withSkippedChallenges('No method found', 2)).toBe(
      'No method found. Skipped 2 challenges that select a credential header other than Payment-Authorization',
    )
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

    expect(challenge.meta).toEqual({ pi: 'pi_3abc123XYZ' })
    expect(challenge.opaque).toBe('eyJwaSI6InBpXzNhYmMxMjNYWVoifQ')
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

    expect(challenge.meta).toEqual({ payment_intent: 'pi_3abc123XYZ' })
    expect(challenge.opaque).toBe('eyJwYXltZW50X2ludGVudCI6InBpXzNhYmMxMjNYWVoifQ')
  })

  test('behavior: challenge opaque and meta are undefined when no meta', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
    })

    expect(challenge.opaque).toBeUndefined()
    expect(challenge.meta).toBeUndefined()
  })

  test('behavior: opaque roundtrips through serialize/deserialize as a raw string', () => {
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

    expect(deserialized.opaque).toBe('eyJkZXBvc2l0IjoiZGVwXzQ1NiIsInBpIjoicGlfM2FiYzEyM1hZWiJ9')
    expect(deserialized.meta).toBeUndefined()
  })

  test('behavior: deserialize does not parse non-json opaque', () => {
    const header =
      'Payment id="abc123", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAwIn0", opaque="eXkgd3Jvbmc"'

    const challenge = Challenge.deserialize(header)

    expect(challenge.opaque).toBe('eXkgd3Jvbmc')
    expect(challenge.meta).toBeUndefined()
  })

  test('behavior: meta with empty object produces opaque string and meta: {}', () => {
    const challenge = Challenge.from({
      id: 'abc123',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000000' },
      meta: {},
    })

    expect(challenge.meta).toEqual({})
    expect(challenge.opaque).toBe('e30')
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
      meta: { pi: 'pi_TAMPERED' },
      opaque: 'eyJwaSI6InBpX1RBTVBFUkVEIn0',
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

    expect(challenge.meta).toEqual({
      payment_intent: 'pi_3abc123XYZ',
      customer: 'cus_xyz',
      session_id: 'sess_abc',
    })
  })
})
