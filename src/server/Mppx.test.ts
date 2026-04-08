import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx, Transport, tempo } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const method = tempo({
  getClient: () => client,
  account: accounts[0],
})

describe('create', () => {
  test('default', () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    expect(handler.realm).toBe(realm)
    expect(handler.transport.name).toBe('http')
    expect(typeof handler.charge).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey, transport: Transport.mcp() })

    expect(handler.transport.name).toBe('mcp')
  })
})

describe('request handler', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    const request = new Request('https://example.com/resource')

    const result = await handler.charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    expect(result.challenge.headers.get('WWW-Authenticate')).toContain('Payment')

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Payment is required.",
        "instance": "[instance]",
        "status": 402,
        "title": "Payment Required",
        "type": "https://paymentauth.org/problems/payment-required",
      }
    `)
  })

  test('returns 402 with challenge for malformed credential', async () => {
    const request = new Request('https://example.com/resource', {
      headers: { Authorization: 'Payment invalid' },
    })

    const result = await Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Credential is malformed: Invalid base64url or JSON..",
        "instance": "[instance]",
        "status": 402,
        "title": "Malformed Credential",
        "type": "https://paymentauth.org/problems/malformed-credential",
      }
    `)
  })

  test('returns sanitized malformed credential error for unexpected transport failures', async () => {
    const baseTransport = Transport.http()
    const transport = Transport.from({
      ...baseTransport,
      name: 'leaking-http',
      getCredential() {
        throw new Error('request to https://rpc.example.com/?key=secret-key failed')
      },
    })

    const result = await Mppx.create({ methods: [method], realm, secretKey, transport }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(
      new Request('https://example.com/resource', {
        headers: { Authorization: 'Payment invalid' },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toBe('Credential is malformed.')
    expect(body.detail).not.toContain('secret-key')
    expect(body.detail).not.toContain('rpc.example.com')
  })

  test('captures each transport request once and threads the verified envelope additively', async () => {
    const requestMethod = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          recipient: z.string(),
        }),
      },
    })

    let captureCount = 0
    let requestCapturedRequest: Method.CapturedRequest | undefined
    let verifyEnvelope: Method.VerifiedChallengeEnvelope | undefined
    let respondEnvelope: Method.VerifiedChallengeEnvelope | undefined
    let receiptEnvelope: Method.VerifiedChallengeEnvelope | undefined

    const baseTransport = Transport.http()
    const transport = Transport.from({
      ...baseTransport,
      captureRequest(request) {
        captureCount++
        return (
          baseTransport.captureRequest?.(request) ?? {
            headers: new Headers(request.headers),
            method: request.method,
            url: new URL(request.url),
          }
        )
      },
      respondReceipt(options) {
        receiptEnvelope = options.envelope
        return baseTransport.respondReceipt(options)
      },
    })

    const serverMethod = Method.toServer(requestMethod, {
      request({ capturedRequest, credential, request }) {
        if (credential) requestCapturedRequest = capturedRequest
        return request
      },
      async verify({ envelope, request }) {
        verifyEnvelope = envelope
        expect(envelope?.capturedRequest).toBe(requestCapturedRequest)
        expect(request.amount).toBe('1000')
        expect(request.currency).toBe('0x0000000000000000000000000000000000000001')
        expect(request.recipient).toBe('0x0000000000000000000000000000000000000002')
        expect(envelope).toBeDefined()
        expect(Object.isFrozen(envelope!)).toBe(true)

        return {
          method: 'mock',
          reference: 'tx-ref',
          status: 'success',
          timestamp: new Date().toISOString(),
        }
      },
      respond({ envelope }) {
        respondEnvelope = envelope
        return new Response('ok')
      },
    })

    const handler = Mppx.create({ methods: [serverMethod], realm, secretKey, transport })
    const options = {
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    } as const

    const challengeResult = await handler.charge(options)(
      new Request('https://example.com/resource?first=1'),
    )
    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error()

    const credential = Credential.from({
      challenge: Challenge.fromResponse(challengeResult.challenge),
      payload: { token: 'valid' },
    })

    const result = await handler.charge(options)(
      new Request('https://example.com/resource?second=1', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt()
    expect(response.status).toBe(200)
    expect(captureCount).toBe(2)
    expect(requestCapturedRequest?.url.pathname).toBe('/resource')
    expect(requestCapturedRequest?.url.search).toBe('?second=1')
    expect(verifyEnvelope?.capturedRequest).toBe(requestCapturedRequest)
    expect(respondEnvelope?.capturedRequest).toBe(requestCapturedRequest)
    expect(receiptEnvelope?.capturedRequest).toBe(requestCapturedRequest)
    expect(receiptEnvelope?.challenge.id).toBe(credential.challenge.id)
  })

  test('returns 402 when challenge ID mismatch', async () => {
    const wrongChallenge = Challenge.from({
      id: 'wrong-id',
      intent: 'charge',
      method: 'tempo',
      realm,
      request: { amount: '1000', currency: asset, recipient: accounts[0].address },
    })
    const credential = Credential.from({
      challenge: wrongChallenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const request = new Request('https://example.com/resource', {
      headers: { Authorization: Credential.serialize(credential) },
    })

    const result = await Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Challenge "wrong-id" is invalid: challenge was not issued by this server.",
        "instance": "[instance]",
        "status": 402,
        "title": "Invalid Challenge",
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })

  test('returns 402 when credential is from a different route (cross-route scope confusion)', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    // Get a challenge from the "cheap" route
    const cheapHandle = handler.charge({
      amount: '1',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Build a credential from the cheap challenge
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    // Present it at the "expensive" route
    const expensiveHandle = handler.charge({
      amount: '1000000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('does not match')
  })

  test('topUp credential is rejected when replayed across routes with different amounts', async () => {
    // Use a session method whose schema defines action: 'topUp'
    const sessionMethod = Method.from({
      name: 'mock',
      intent: 'session',
      schema: {
        credential: {
          payload: z.discriminatedUnion('action', [
            z.object({ action: z.literal('open'), token: z.string() }),
            z.object({ action: z.literal('topUp'), token: z.string() }),
          ]),
        },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          recipient: z.string(),
        }),
      },
    })
    const sessionServerMethod = Method.toServer(sessionMethod, {
      async verify() {
        return {
          status: 'settled',
          method: 'mock',
          timestamp: new Date().toISOString(),
          reference: 'ref',
        } as any
      },
    })
    const handler = Mppx.create({ methods: [sessionServerMethod], realm, secretKey })

    // Get a challenge from the "cheap" route (simulates HEAD-obtained challenge)
    const cheapHandle = handler['mock/session']({
      amount: '1',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Build a topUp credential from the cheap challenge (echoed from HEAD)
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { action: 'topUp', token: 'valid' },
    })

    // Present it at the "expensive" route — topUp must still match scope.
    const expensiveHandle = handler['mock/session']({
      amount: '1000000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const body = (await result.challenge.json()) as { detail?: string }
    expect(body.detail).toContain('does not match')
  })

  test('voucher credential is rejected when replayed across routes with different amounts', async () => {
    const sessionMethod = Method.from({
      name: 'mock',
      intent: 'session',
      schema: {
        credential: {
          payload: z.discriminatedUnion('action', [
            z.object({ action: z.literal('open'), token: z.string() }),
            z.object({
              action: z.literal('voucher'),
              cumulativeAmount: z.string(),
              signature: z.string(),
            }),
          ]),
        },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          recipient: z.string(),
        }),
      },
    })
    const sessionServerMethod = Method.toServer(sessionMethod, {
      async verify() {
        return {
          status: 'settled',
          method: 'mock',
          timestamp: new Date().toISOString(),
          reference: 'ref',
        } as any
      },
    })
    const handler = Mppx.create({ methods: [sessionServerMethod], realm, secretKey })

    // Get a challenge from the "cheap" route (simulates initial SSE request)
    const cheapHandle = handler['mock/session']({
      amount: '1',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/chat'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Build a voucher credential echoing the original challenge — mid-stream
    // the server may re-price (dynamic pricing), so the route's amount differs
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { action: 'voucher', cumulativeAmount: '500', signature: '0xabc' },
    })

    // Present it at the same route but with a higher price — voucher must
    // still match the original priced scope.
    const expensiveHandle = handler['mock/session']({
      amount: '1000000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const result = await expensiveHandle(
      new Request('https://example.com/chat', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const body = (await result.challenge.json()) as { detail?: string }
    expect(body.detail).toContain('does not match')
  })

  test('rejects charge credential with injected action: topUp (cross-route bypass attempt)', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    // Get a challenge from the "cheap" route
    const cheapHandle = handler.charge({
      amount: '1',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Malicious client injects action: 'topUp' into a regular charge credential
    // to try to bypass the cross-route amount check
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { action: 'topUp', signature: '0x123', type: 'transaction' },
    })

    // Present it at the "expensive" route — should still be rejected
    const expensiveHandle = handler.charge({
      amount: '1000000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Injecting action: 'topUp' on a charge credential must not bypass
    // the cross-route amount check. The credential should be rejected
    // with "does not match" just like a normal charge credential would be.
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('does not match')
  })

  test('returns 402 when credential challenge is expired', async () => {
    const pastExpires = new Date(Date.now() - 60_000).toISOString()

    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: pastExpires,
      recipient: accounts[0].address,
    })

    // Get a fresh challenge (which has the expired timestamp baked in)
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      detail: '[detail]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "[detail]",
        "instance": "[instance]",
        "status": 402,
        "title": "Payment Expired",
        "type": "https://paymentauth.org/problems/payment-expired",
      }
    `)
    expect((body as { detail: string }).detail).toContain('Payment expired at')
  })
  test('returns 402 when credential challenge has no expires (fail-closed)', async () => {
    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })

    // Get a valid challenge from the server to capture the exact request shape
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const serverChallenge = Challenge.fromResponse(firstResult.challenge)

    // Re-create the same challenge WITHOUT expires, with a valid HMAC
    const { expires: _, ...rest } = serverChallenge
    const challengeNoExpires = Challenge.from({
      secretKey,
      realm: rest.realm,
      method: rest.method,
      intent: rest.intent,
      request: rest.request,
      ...(rest.opaque && { meta: rest.opaque }),
    })

    const credential = Credential.from({
      challenge: challengeNoExpires,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { title: string; detail: string }
    expect(body.title).toBe('Invalid Challenge')
    expect(body.detail).toContain('missing required expires')
  })
  test('returns 402 when credential challenge has malformed expires', async () => {
    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })

    // Get a valid challenge from the server to capture the exact request shape
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const serverChallenge = Challenge.fromResponse(firstResult.challenge)

    // Re-create the challenge with a valid HMAC but inject a malformed expires
    // by patching the challenge object after construction (bypasses zod at build time).
    const challengeMalformed = {
      ...serverChallenge,
      expires: 'not-a-timestamp',
    }

    const credential = Credential.from({
      challenge: challengeMalformed as any,
      payload: { signature: '0x123', type: 'transaction' },
    })

    // Credential.serialize does not re-validate, so the malformed expires
    // reaches the server. Deserialization rejects it via zod schema.
    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { title: string; detail: string }
    expect(body.title).toBe('Malformed Credential')
  })

  test('returns 402 when payload schema validation fails', async () => {
    const handle = Mppx.create({ methods: [method], realm, secretKey }).charge({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { invalidField: 'bad' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect({
      ...body,
      challengeId: '[challengeId]',
      detail: '[detail]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "[detail]",
        "instance": "[instance]",
        "status": 402,
        "title": "Invalid Payload",
        "type": "https://paymentauth.org/problems/invalid-payload",
      }
    `)
    expect(body.detail).toBe('Credential payload is invalid.')
    expect(body.detail).not.toContain('invalidField')
  })

  test('returns sanitized verification error for unexpected verifier failures', async () => {
    const leakingMethod = Method.toServer(
      Method.from({
        name: 'mock',
        intent: 'charge',
        schema: {
          credential: {
            payload: z.object({ token: z.string() }),
          },
          request: z.object({
            amount: z.string(),
            currency: z.string(),
            recipient: z.string(),
          }),
        },
      }),
      {
        async verify() {
          throw new Error('request to https://mainnet.infura.io/v3/secret-key failed')
        },
      },
    )

    const handle = Mppx.create({ methods: [leakingMethod], realm, secretKey })['mock/charge']({
      amount: '1000',
      currency: asset,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: accounts[0].address,
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toBe('Payment verification failed.')
    expect(body.detail).not.toContain('infura')
    expect(body.detail).not.toContain('secret-key')
  })
})

describe('request handler (node)', () => {
  test('returns 402 when no Authorization header', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    const body = (await response.json()) as object
    expect({
      ...body,
      challengeId: '[challengeId]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "Payment is required.",
        "instance": "[instance]",
        "status": 402,
        "title": "Payment Required",
        "type": "https://paymentauth.org/problems/payment-required",
      }
    `)

    server.close()
  })

  test('returns 200 with Payment-Receipt header on success', async () => {
    const handler = Mppx.create({ methods: [method], realm, secretKey })
    const expires = new Date(Date.now() + 60_000).toISOString()

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: asset,
          expires,
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const firstResponse = await fetch(server.url)
    expect(firstResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(firstResponse)

    const credential = Credential.from({
      challenge,
      payload: { signature: '0x123', type: 'transaction' },
    })

    const response = await fetch(server.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })

    expect(response.status).toBe(402)

    const body = (await response.json()) as { detail: string }
    expect({
      ...body,
      challengeId: '[challengeId]',
      detail: '[detail]',
      instance: '[instance]',
    }).toMatchInlineSnapshot(`
      {
        "challengeId": "[challengeId]",
        "detail": "[detail]",
        "instance": "[instance]",
        "status": 402,
        "title": "Verification Failed",
        "type": "https://paymentauth.org/problems/verification-failed",
      }
    `)
    expect(body.detail).toContain('Payment verification failed')

    server.close()
  })
})

describe('receipt handling', () => {
  test('returns 200 when verify returns a success receipt', async () => {
    const mockCharge = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: {
          payload: z.object({ token: z.string() }),
        },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
      },
    })

    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return {
          method: 'mock',
          reference: 'tx-success-456',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mppx.create({
      methods: [mockMethod],
      realm,
      secretKey,
    })

    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)

    const credential = Credential.from({
      challenge,
      payload: { token: 'valid-token' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })
})

describe('compose', () => {
  const mockChargeA = Method.from({
    name: 'alpha',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  const mockChargeB = Method.from({
    name: 'beta',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  function mockReceipt(name: string) {
    return {
      method: name,
      reference: `tx-${name}`,
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  const alphaMethod = Method.toServer(mockChargeA, {
    async verify() {
      return mockReceipt('alpha')
    },
  })

  const betaMethod = Method.toServer(mockChargeB, {
    async verify() {
      return mockReceipt('beta')
    },
  })

  const challengeOpts = {
    amount: '1000',
    currency: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    expires: new Date(Date.now() + 60_000).toISOString(),
    recipient: '0x0000000000000000000000000000000000000002',
  }

  test('returns 402 with multiple WWW-Authenticate headers when no credential', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const result = await mppx.compose(
      [alphaMethod, challengeOpts],
      [betaMethod, challengeOpts],
    )(new Request('https://example.com/resource'))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const wwwAuth = result.challenge.headers.get('WWW-Authenticate')!
    expect(wwwAuth).toContain('method="alpha"')
    expect(wwwAuth).toContain('method="beta"')
  })

  test('dispatches to matching handler when credential matches alpha', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose([alphaMethod, challengeOpts], [betaMethod, challengeOpts])

    // Get challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Parse the alpha challenge from the merged response
    const challenges = Challenge.fromResponseList(firstResult.challenge)
    const alphaChallenge = challenges[0]!

    const credential = Credential.from({
      challenge: alphaChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('dispatches to matching handler when credential matches beta', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose([alphaMethod, challengeOpts], [betaMethod, challengeOpts])

    // Get challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Parse the beta challenge from the merged response
    const challenges = Challenge.fromResponseList(firstResult.challenge)
    const betaChallenge = challenges[1]!

    const credential = Credential.from({
      challenge: betaChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('returns 402 when credential method does not match any handler', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.compose([alphaMethod, challengeOpts])

    const wrongChallenge = Challenge.from({
      id: 'wrong-id',
      intent: 'charge',
      method: 'unknown',
      realm,
      request: { amount: '1000', currency: '0x01', recipient: '0x02' },
    })
    const credential = Credential.from({
      challenge: wrongChallenge,
      payload: { token: 'test' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
  })

  test('cross-route protection works through compose()', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    // Get a challenge from a cheap route
    const cheapHandle = mppx.compose([alphaMethod, { ...challengeOpts, amount: '1' }])
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { token: 'valid' },
    })

    // Present it at an expensive route
    const expensiveHandle = mppx.compose([alphaMethod, { ...challengeOpts, amount: '1000000' }])
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('does not match')
  })

  test('withReceipt works through compose()', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.compose([alphaMethod, challengeOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt(Response.json({ data: 'ok' }))
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('throws when called with no entries', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(() => mppx.compose()).toThrow('compose() requires at least one entry')
  })

  test('throws when method is not in the methods array', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(() => mppx.compose([betaMethod, challengeOpts] as never)).toThrow(
      'No handler for "beta/charge"',
    )
  })

  test('accepts string keys instead of method references', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose(['alpha/charge', challengeOpts], ['beta/charge', challengeOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)
    expect(challenges[0]!.method).toBe('alpha')
    expect(challenges[1]!.method).toBe('beta')

    // Dispatch with a credential for alpha
    const credential = Credential.from({
      challenge: challenges[0]!,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })

  test('throws when string key does not match any registered method', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(() => mppx.compose(['unknown/charge' as never, challengeOpts])).toThrow(
      'No handler for "unknown/charge"',
    )
  })

  test('mixes string keys and method references', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose(['alpha/charge', challengeOpts], [betaMethod, challengeOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)
  })

  test('accepts handler function refs (mppx.alpha.charge syntax)', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose(
      [mppx.alpha.charge, challengeOpts],
      [mppx.beta.charge, challengeOpts],
    )

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)
    expect(challenges[0]!.method).toBe('alpha')
    expect(challenges[1]!.method).toBe('beta')

    // Dispatch with a credential for alpha
    const credential = Credential.from({
      challenge: challenges[0]!,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })

  test('mixes handler function refs with method references and string keys', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.compose([mppx.alpha.charge, challengeOpts], ['beta/charge', challengeOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)
  })

  test('dispatches correctly with same name/intent but different currencies', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const currencyA = '0x0000000000000000000000000000000000000001'
    const currencyB = '0x0000000000000000000000000000000000000099'

    const handle = mppx.compose(
      [alphaMethod, { ...challengeOpts, currency: currencyA }],
      [alphaMethod, { ...challengeOpts, currency: currencyB }],
    )

    // Get merged 402 with both challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)

    // Present credential for the SECOND currency — should dispatch correctly
    const secondChallenge = challenges[1]!
    expect((secondChallenge.request as Record<string, unknown>).currency).toBe(currencyB)

    const credential = Credential.from({
      challenge: secondChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('dispatches correctly with same name/intent but different recipients', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const recipientA = '0x0000000000000000000000000000000000000002'
    const recipientB = '0x0000000000000000000000000000000000000088'

    const handle = mppx.compose(
      [alphaMethod, { ...challengeOpts, recipient: recipientA }],
      [alphaMethod, { ...challengeOpts, recipient: recipientB }],
    )

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)

    // Present credential for the SECOND recipient
    const secondChallenge = challenges[1]!
    const credential = Credential.from({
      challenge: secondChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  describe('html', () => {
    const htmlOptionsA = {
      config: { providerA: true },
      content: '<script src="/alpha-bundle.js"></script>',
      formatAmount: (request: Record<string, unknown>) => `$${request.amount}`,
      text: undefined,
      theme: undefined,
    }

    const htmlOptionsB = {
      config: { providerB: true },
      content: '<script src="/beta-bundle.js"></script>',
      formatAmount: (request: Record<string, unknown>) => `$${request.amount}`,
      text: undefined,
      theme: undefined,
    }

    const alphaWithHtml = Method.toServer(mockChargeA, {
      html: htmlOptionsA,
      async verify() {
        return mockReceipt('alpha')
      },
    })

    const betaWithHtml = Method.toServer(mockChargeB, {
      html: htmlOptionsB,
      async verify() {
        return mockReceipt('beta')
      },
    })

    test('returns html with tabs when multiple methods have html', async () => {
      const mppx = Mppx.create({
        methods: [alphaWithHtml, betaWithHtml],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaWithHtml, challengeOpts], [betaWithHtml, challengeOpts])

      const result = await handle(
        new Request('https://example.com/resource', {
          headers: { Accept: 'text/html' },
        }),
      )

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const body = await result.challenge.text()
      expect(result.challenge.headers.get('Content-Type')).toBe('text/html; charset=utf-8')

      // Tab a11y markup
      expect(body).toContain('role="tablist"')
      expect(body).toContain('role="tab"')
      expect(body).toContain('role="tabpanel"')
      expect(body).toContain('aria-selected="true"')
      expect(body).toContain('aria-controls="mppx-panel-0"')
      expect(body).toContain('aria-controls="mppx-panel-1"')

      // Tab labels from method names (capitalized via CSS)
      expect(body).toContain('alpha')
      expect(body).toContain('beta')

      // Both method bundles included
      expect(body).toContain('/alpha-bundle.js')
      expect(body).toContain('/beta-bundle.js')

      // Data map with both entries
      const dataMatch = body.match(
        /<script[^>]*id="__MPPX_DATA__"[^>]*type="application\/json"[^>]*>\s*([\s\S]*?)\s*<\/script>/s,
      )
      expect(dataMatch).not.toBeNull()
      const dataMap = JSON.parse(dataMatch![1]!.replace(/\\u003c/g, '<'))
      const dataValues = Object.values(dataMap) as { label: string; config: unknown }[]
      expect(dataValues).toHaveLength(2)
      expect(dataValues[0]!.label).toBe('alpha')
      expect(dataValues[0]!.config).toEqual({ providerA: true })
      expect(dataValues[1]!.label).toBe('beta')
      expect(dataValues[1]!.config).toEqual({ providerB: true })
    })

    test('returns html without tabs when single method has html', async () => {
      const mppx = Mppx.create({
        methods: [alphaWithHtml, betaMethod],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaWithHtml, challengeOpts], [betaMethod, challengeOpts])

      const result = await handle(
        new Request('https://example.com/resource', {
          headers: { Accept: 'text/html' },
        }),
      )

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const body = await result.challenge.text()
      expect(result.challenge.headers.get('Content-Type')).toBe('text/html; charset=utf-8')

      // No tabs when only one method has html
      expect(body).not.toContain('role="tablist"')
      expect(body).not.toContain('role="tab"')

      // Single panel present
      expect(body).toContain('mppx-panel-0')
      expect(body).toContain('/alpha-bundle.js')

      // Data map with single entry
      const dataMatch = body.match(
        /<script[^>]*id="__MPPX_DATA__"[^>]*type="application\/json"[^>]*>\s*([\s\S]*?)\s*<\/script>/s,
      )
      const dataMap = JSON.parse(dataMatch![1]!.replace(/\\u003c/g, '<'))
      const dataValues = Object.values(dataMap) as { label: string }[]
      expect(dataValues).toHaveLength(1)
      expect(dataValues[0]!.label).toBe('alpha')
    })

    test('falls back to json when Accept does not include text/html', async () => {
      const mppx = Mppx.create({
        methods: [alphaWithHtml, betaWithHtml],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaWithHtml, challengeOpts], [betaWithHtml, challengeOpts])

      const result = await handle(new Request('https://example.com/resource'))

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const contentType = result.challenge.headers.get('Content-Type')
      expect(contentType).not.toContain('text/html')
    })

    test('serves service worker when __mppx_worker param is set', async () => {
      const mppx = Mppx.create({
        methods: [alphaWithHtml, betaWithHtml],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaWithHtml, challengeOpts], [betaWithHtml, challengeOpts])

      const result = await handle(new Request('https://example.com/resource?__mppx_worker'))

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      expect(result.challenge.status).toBe(200)
      expect(result.challenge.headers.get('Content-Type')).toBe('application/javascript')
    })

    test('returns json when no methods have html configured', async () => {
      const mppx = Mppx.create({
        methods: [alphaMethod, betaMethod],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaMethod, challengeOpts], [betaMethod, challengeOpts])

      const result = await handle(
        new Request('https://example.com/resource', {
          headers: { Accept: 'text/html' },
        }),
      )

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const contentType = result.challenge.headers.get('Content-Type')
      expect(contentType).not.toContain('text/html')
    })

    test('both WWW-Authenticate headers present even with html', async () => {
      const mppx = Mppx.create({
        methods: [alphaWithHtml, betaWithHtml],
        realm,
        secretKey,
      })

      const handle = mppx.compose([alphaWithHtml, challengeOpts], [betaWithHtml, challengeOpts])

      const result = await handle(
        new Request('https://example.com/resource', {
          headers: { Accept: 'text/html' },
        }),
      )

      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const wwwAuth = result.challenge.headers.get('WWW-Authenticate')!
      expect(wwwAuth).toContain('method="alpha"')
      expect(wwwAuth).toContain('method="beta"')
    })
  })
})

describe('compose: pre-dispatch narrowing edge cases', () => {
  const mockCharge = Method.from({
    name: 'alpha',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  function mockReceipt() {
    return {
      method: 'alpha',
      reference: 'tx-alpha',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  const alphaMethod = Method.toServer(mockCharge, {
    async verify() {
      return mockReceipt()
    },
  })

  const challengeOpts = {
    amount: '1000',
    currency: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    expires: new Date(Date.now() + 60_000).toISOString(),
    recipient: '0x0000000000000000000000000000000000000002',
  }

  test('dispatches correctly when handlers differ only in amount', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.compose(
      [alphaMethod, { ...challengeOpts, amount: '100' }],
      [alphaMethod, { ...challengeOpts, amount: '999' }],
    )

    // Get 402 with both challenges
    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Present credential for second challenge (amount=999)
    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)

    const secondChallenge = challenges[1]!
    const credential = Credential.from({
      challenge: secondChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Amount is now included in narrowing, so the second handler is correctly selected.
    expect(result.status).toBe(200)
  })

  test('first handler succeeds when handlers differ only in amount and credential matches first', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.compose(
      [alphaMethod, { ...challengeOpts, amount: '100' }],
      [alphaMethod, { ...challengeOpts, amount: '999' }],
    )

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    // Present credential for the FIRST challenge — narrowing picks first too
    const challenges = Challenge.fromResponseList(firstResult.challenge)
    const firstChallenge = challenges[0]!
    const credential = Credential.from({
      challenge: firstChallenge,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })

  test('dispatches when credential method/intent does not match — falls back to first handler with 402', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const handle = mppx.compose([alphaMethod, challengeOpts])

    // Forge a credential with a non-existent method
    const wrongChallenge = Challenge.from({
      id: 'forged',
      intent: 'charge',
      method: 'nonexistent',
      realm,
      request: { amount: '1' },
    })
    const credential = Credential.from({
      challenge: wrongChallenge,
      payload: { token: 'test' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Falls back to handlers[0] which rejects via HMAC
    expect(result.status).toBe(402)
  })

  test('handles malformed Authorization header in compose() gracefully', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    const handle = mppx.compose([alphaMethod, challengeOpts])

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: 'Payment invalid-base64-garbage' },
      }),
    )

    // Credential parse fails silently, falls back to handlers[0]
    expect(result.status).toBe(402)
  })

  test('single handler in compose() returns 402 and then 200', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    const handle = mppx.compose([alphaMethod, challengeOpts])

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })
})

describe('nested accessors', () => {
  const mockChargeA = Method.from({
    name: 'alpha',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  const mockChargeB = Method.from({
    name: 'beta',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  function mockReceipt(name: string) {
    return {
      method: name,
      reference: `tx-${name}`,
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  const alphaMethod = Method.toServer(mockChargeA, {
    async verify() {
      return mockReceipt('alpha')
    },
  })

  const betaMethod = Method.toServer(mockChargeB, {
    async verify() {
      return mockReceipt('beta')
    },
  })

  const challengeOpts = {
    amount: '1000',
    currency: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    expires: new Date(Date.now() + 60_000).toISOString(),
    recipient: '0x0000000000000000000000000000000000000002',
  }

  test('mppx.alpha.charge returns a working handler (402 then 200)', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.alpha.charge(challengeOpts)

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    expect(challenge.method).toBe('alpha')
    expect(challenge.intent).toBe('charge')

    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })

  test('mppx.beta.charge returns a working handler', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = mppx.beta.charge(challengeOpts)

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    expect(challenge.method).toBe('beta')

    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })

  test('nested accessor is the same handler as the slash key', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })
    expect(mppx.alpha.charge).toBe(mppx['alpha/charge'])
  })

  test('nested accessors work with Mppx.compose() static function', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const handle = Mppx.compose(mppx.alpha.charge(challengeOpts), mppx.beta.charge(challengeOpts))

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    expect(challenges).toHaveLength(2)
    expect(challenges[0]!.method).toBe('alpha')
    expect(challenges[1]!.method).toBe('beta')

    // Dispatch with beta credential
    const credential = Credential.from({
      challenge: challenges[1]!,
      payload: { token: 'valid' },
    })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })
})

describe('cross-route credential replay via scope binding flaw', () => {
  // Method whose schema transform moves `amount`, `currency`, and `recipient`
  // into `methodDetails`, removing them from the top-level request. This mirrors
  // real-world methods (e.g. Tempo) that restructure fields via z.transform.
  const transformingMethod = Method.from({
    name: 'mock',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.pipe(
        z.object({
          amount: z.string(),
          currency: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
        z.transform(({ amount, currency, decimals, recipient }) => ({
          methodDetails: { amount: String(Number(amount) * 10 ** decimals), currency, recipient },
        })),
      ),
    },
  })

  function mockReceipt() {
    return {
      method: 'mock',
      reference: 'tx-ref',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  const serverMethod = Method.toServer(transformingMethod, {
    async verify() {
      return mockReceipt()
    },
  })

  test('rejects cheap credential replayed at expensive route when schema transform moves scope fields', async () => {
    const handler = Mppx.create({ methods: [serverMethod], realm, secretKey })

    // Get a challenge from the "cheap" route ($0.01)
    const cheapHandle = handler.charge({
      amount: '0.01',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const cheapResult = await cheapHandle(new Request('https://example.com/cheap'))
    expect(cheapResult.status).toBe(402)
    if (cheapResult.status !== 402) throw new Error()

    const cheapChallenge = Challenge.fromResponse(cheapResult.challenge)

    // Build a credential from the cheap challenge
    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { token: 'valid' },
    })

    // Present the cheap credential at the "expensive" route ($100)
    const expensiveHandle = handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const result = await expensiveHandle(
      new Request('https://example.com/expensive', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Should be 402 (credential was for $0.01, not $100)
    expect(result.status).toBe(402)
  })

  test('rejects credential with mismatched method field', async () => {
    const otherMethod = Method.from({
      name: 'other',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
      },
    })

    const otherServerMethod = Method.toServer(otherMethod, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [serverMethod, otherServerMethod], realm, secretKey })

    // Get challenge from mock/charge
    const mockHandle = handler['mock/charge']({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const mockResult = await mockHandle(new Request('https://example.com/mock'))
    expect(mockResult.status).toBe(402)
    if (mockResult.status !== 402) throw new Error()

    const mockChallenge = Challenge.fromResponse(mockResult.challenge)
    const credential = Credential.from({
      challenge: mockChallenge,
      payload: { token: 'valid' },
    })

    // Present mock/charge credential at other/charge route
    const otherHandle = handler['other/charge']({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const result = await otherHandle(
      new Request('https://example.com/other', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Should reject (credential was for method "mock", not "other")
    expect(result.status).toBe(402)
  })

  test('rejects credential with mismatched intent field', async () => {
    const sessionMethod = Method.from({
      name: 'mock',
      intent: 'session',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
      },
    })

    const sessionServerMethod = Method.toServer(sessionMethod, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [serverMethod, sessionServerMethod], realm, secretKey })

    // Get challenge from mock/charge
    const chargeHandle = handler['mock/charge']({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const chargeResult = await chargeHandle(new Request('https://example.com/charge'))
    expect(chargeResult.status).toBe(402)
    if (chargeResult.status !== 402) throw new Error()

    const chargeChallenge = Challenge.fromResponse(chargeResult.challenge)
    const credential = Credential.from({
      challenge: chargeChallenge,
      payload: { token: 'valid' },
    })

    // Present charge credential at session route
    const sessionHandle = handler['mock/session']({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const result = await sessionHandle(
      new Request('https://example.com/session', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // Should reject (credential was for intent "charge", not "session")
    expect(result.status).toBe(402)
  })

  test('compose: rejects cheap credential replayed at expensive route when schema transform moves scope fields', async () => {
    const handler = Mppx.create({ methods: [serverMethod], realm, secretKey })

    const cheapHandle = handler.charge({
      amount: '0.01',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const expensiveHandle = handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const composed = Mppx.compose(cheapHandle, expensiveHandle)

    // Get challenge (pick the cheap one)
    const firstResult = await composed(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    const cheapChallenge = challenges[0]!

    const credential = Credential.from({
      challenge: cheapChallenge,
      payload: { token: 'valid' },
    })

    // The composed handler should NOT route the cheap credential to the expensive handler
    const result = await composed(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    // If scope binding works, the credential should route to the cheap handler only.
    // It should NOT match the expensive handler's canonical request.
    // The result should be 200 (matched to cheap), not routed to expensive.
    expect(result.status).toBe(200)
  })

  test('rejects no-splits credential replayed at splits route', async () => {
    // Method whose schema transform moves splits into methodDetails.
    const splitsMethod = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.pipe(
          z.object({
            amount: z.string(),
            currency: z.string(),
            decimals: z.number(),
            recipient: z.string(),
            splits: z.optional(z.array(z.object({ amount: z.string(), recipient: z.string() }))),
          }),
          z.transform(({ amount, currency, decimals, recipient, splits }) => ({
            methodDetails: {
              amount: String(Number(amount) * 10 ** decimals),
              currency,
              recipient,
              ...(splits && { splits }),
            },
          })),
        ),
      },
    })

    const splitsServerMethod = Method.toServer(splitsMethod, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [splitsServerMethod], realm, secretKey })

    // Get a challenge from a route with no splits
    const noSplitsHandle = handler.charge({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const noSplitsResult = await noSplitsHandle(new Request('https://example.com/no-splits'))
    expect(noSplitsResult.status).toBe(402)
    if (noSplitsResult.status !== 402) throw new Error()

    const noSplitsChallenge = Challenge.fromResponse(noSplitsResult.challenge)
    const credential = Credential.from({
      challenge: noSplitsChallenge,
      payload: { token: 'valid' },
    })

    // Present at a route that requires splits
    const splitsHandle = handler.charge({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
      splits: [{ amount: '0.2', recipient: '0x0000000000000000000000000000000000000003' }],
    })
    const result = await splitsHandle(
      new Request('https://example.com/with-splits', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(402)
  })

  test('compose dispatch includes methodDetails memo/splits binding', async () => {
    const splitsMethod = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.pipe(
          z.object({
            amount: z.string(),
            currency: z.string(),
            decimals: z.number(),
            recipient: z.string(),
            splits: z.optional(z.array(z.object({ amount: z.string(), recipient: z.string() }))),
          }),
          z.transform(({ amount, currency, decimals, recipient, splits }) => ({
            methodDetails: {
              amount: String(Number(amount) * 10 ** decimals),
              currency,
              recipient,
              ...(splits && { splits }),
            },
          })),
        ),
      },
    })

    const splitsServerMethod = Method.toServer(splitsMethod, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [splitsServerMethod], realm, secretKey })

    const noSplitsHandle = handler.charge({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })
    const splitsHandle = handler.charge({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
      splits: [{ amount: '0.2', recipient: '0x0000000000000000000000000000000000000003' }],
    })

    const composed = Mppx.compose(noSplitsHandle, splitsHandle)
    const firstResult = await composed(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenges = Challenge.fromResponseList(firstResult.challenge)
    const noSplitsChallenge = challenges[0]!
    const credential = Credential.from({
      challenge: noSplitsChallenge,
      payload: { token: 'valid' },
    })

    const result = await composed(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(result.status).toBe(200)
  })
})

describe('withReceipt', () => {
  const mockCharge = Method.from({
    name: 'mock',
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })

  function mockReceipt() {
    return {
      method: 'mock',
      reference: 'tx-ref',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  }

  test('attaches Payment-Receipt header to response', async () => {
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })
    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt(Response.json({ data: 'ok' }))
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
    const body = await response.json()
    expect(body).toEqual({ data: 'ok' })
  })

  test('throws when called without response arg and no management response', async () => {
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })
    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    expect(() => result.withReceipt()).toThrow('withReceipt() requires a response argument')
  })

  test('returns management response when respond hook returns Response', async () => {
    const mockMethodWithRespond = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
      respond() {
        return new Response(null, { status: 204 })
      },
    })

    const handler = Mppx.create({ methods: [mockMethodWithRespond], realm, secretKey })
    const handle = handler.charge({
      amount: '1000',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      expires: new Date(Date.now() + 60_000).toISOString(),
      recipient: '0x0000000000000000000000000000000000000002',
    })

    const firstResult = await handle(new Request('https://example.com/resource'))
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()

    const response = result.withReceipt()
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('toNodeListener sets Payment-Receipt header on 200', async () => {
    const mockMethod = Method.toServer(mockCharge, {
      async verify() {
        return mockReceipt()
      },
    })

    const handler = Mppx.create({ methods: [mockMethod], realm, secretKey })

    const server = await Http.createServer(async (req, res) => {
      const result = await Mppx.toNodeListener(
        handler.charge({
          amount: '1000',
          currency: '0x0000000000000000000000000000000000000001',
          decimals: 6,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: '0x0000000000000000000000000000000000000002',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const firstResponse = await fetch(server.url)
    expect(firstResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(firstResponse)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const response = await fetch(server.url, {
      headers: { Authorization: Credential.serialize(credential) },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    server.close()
  })
})

describe('realm auto-detection', () => {
  beforeEach(() => {
    // Clear all env vars that Env.get('realm') probes so realm falls through to request detection
    for (const name of [
      'MPP_REALM',
      'FLY_APP_NAME',
      'HEROKU_APP_NAME',
      'RAILWAY_PUBLIC_DOMAIN',
      'RENDER_EXTERNAL_HOSTNAME',
      'VERCEL_URL',
      'WEBSITE_HOSTNAME',
    ])
      vi.stubEnv(name, '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const mockMethod = Method.toServer(
    Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
      },
    }),
    {
      async verify() {
        return {
          method: 'mock',
          reference: 'ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    },
  )

  test.each([
    { url: 'https://mpp.dev/resource', expected: 'mpp.dev' },
    { url: 'https://api.example.com/v1/resource', expected: 'api.example.com' },
    { url: 'https://localhost:8787/resource', expected: 'localhost' },
    { url: 'https://MPP.DEV/resource', expected: 'mpp.dev' },
    { url: 'http://staging.mpp.dev:3000/api', expected: 'staging.mpp.dev' },
  ])('derives realm "$expected" from $url', async ({ url, expected }) => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })

    const result = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(new Request(url))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.realm).toBe(expected)
  })

  test('credential verifies across different casing of same host', async () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })

    const chargeOpts = {
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    }

    // Get challenge with uppercase host
    const result = await handler.charge(chargeOpts)(new Request('https://MPP.DEV/resource'))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    // Verify with lowercase host — should match since both normalize
    const verifyResult = await handler.charge(chargeOpts)(
      new Request('https://mpp.dev/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(verifyResult.status).toBe(200)
  })

  test('explicit realm takes precedence over request url', async () => {
    const handler = Mppx.create({ methods: [mockMethod], realm: 'explicit.example.com', secretKey })

    const request = new Request('https://other.example.com/resource')
    const result = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(request)

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.realm).toBe('explicit.example.com')
  })

  test('challenge and verification use same auto-detected realm', async () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })

    const url = 'https://mpp.dev/resource'

    // Get challenge
    const result = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(new Request(url))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    // Replay with credential from same host — should verify
    const verifyResult = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(new Request(url, { headers: { Authorization: Credential.serialize(credential) } }))

    expect(verifyResult.status).toBe(200)
  })

  test('credential from one host rejected at different host', async () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })

    // Get challenge from host A
    const result = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(new Request('https://host-a.example.com/resource'))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    // Present at host B — realm mismatch should reject
    const verifyResult = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(
      new Request('https://host-b.example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(verifyResult.status).toBe(402)
  })

  test('realm undefined on handler when not explicitly set', () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })
    expect(handler.realm).toBeUndefined()
  })

  test('falls back to default realm when input has no url', async () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })
    const handle = handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })

    // Simulate a non-HTTP input with no .url — should warn and use fallback
    const result = await handle({} as any)
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.realm).toBe('MPP Payment')
  })

  test('cross-host rejection reports realm mismatch', async () => {
    const handler = Mppx.create({ methods: [mockMethod], secretKey })

    const result = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(new Request('https://host-a.example.com/resource'))

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const verifyResult = await handler.charge({
      amount: '100',
      currency: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    })(
      new Request('https://host-b.example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(verifyResult.status).toBe(402)
    if (verifyResult.status !== 402) throw new Error()
    const body = (await verifyResult.challenge.json()) as { detail: string }
    expect(body.detail).toContain('realm')
  })
})
