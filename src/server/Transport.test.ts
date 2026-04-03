import { Challenge, Credential, Mcp, Receipt } from 'mppx'
import { Transport } from 'mppx/server'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vp/test'

import { BadRequestError, ChannelClosedError } from '../Errors.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const challenge = Challenge.fromMethod(Methods.charge, {
  realm,
  secretKey,
  expires: '2025-01-01T00:00:00.000Z',
  request: {
    amount: '1000',
    currency: '0x20c0000000000000000000000000000000000001',
    decimals: 6,
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  },
})

const credential = Credential.from({
  challenge,
  payload: { signature: '0xabc123', type: 'transaction' },
})

const receipt = Receipt.from({
  method: 'tempo',
  status: 'success',
  timestamp: '2025-01-01T00:00:00.000Z',
  reference: '0xtxhash',
})

describe('http', () => {
  describe('getCredential', () => {
    test('returns credential from Authorization header', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      })

      expect(transport.getCredential(request)).toMatchInlineSnapshot(`
        {
          "challenge": {
            "expires": "2025-01-01T00:00:00.000Z",
            "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000000000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
            },
          },
          "payload": {
            "signature": "0xabc123",
            "type": "transaction",
          },
        }
      `)
    })

    test('returns null when no Authorization header', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')

      expect(transport.getCredential(request)).toBeNull()
    })

    test('returns null when no Payment scheme present', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Authorization: 'Bearer invalid' },
      })

      expect(transport.getCredential(request)).toBeNull()
    })
  })

  describe('respondChallenge', () => {
    test('default', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')

      const response = await transport.respondChallenge({ challenge, input: request })

      expect({
        status: response.status,
        headers: Object.fromEntries(response.headers),
      }).toMatchInlineSnapshot(`
        {
          "headers": {
            "cache-control": "no-store",
            "www-authenticate": "Payment id="QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAwMDAwIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJyZWNpcGllbnQiOiIweDc0MmQzNUNjNjYzNEMwNTMyOTI1YTNiODQ0QmM5ZTc1OTVmOGZFMDAifQ", expires="2025-01-01T00:00:00.000Z"",
          },
          "status": 402,
        }
      `)
    })
  })

  describe('respondChallenge html', () => {
    const htmlOptions = {
      config: { foo: 'bar' },
      content: '<script src="/pay.js"></script>',
      formatAmount: () => '$10.00',
      text: undefined,
      theme: undefined,
    } satisfies Parameters<Transport.Http['respondChallenge']>[0]['html']

    test('returns html when Accept includes text/html', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: htmlOptions,
      })

      expect(response.status).toBe(402)
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('WWW-Authenticate')).toContain('Payment')
      expect(response.headers.get('Cache-Control')).toBe('no-store')

      const body = await response.text()
      expect(body).toContain('<!doctype html>')
      expect(body).toContain('<title>Payment Required</title>')
      expect(body).toContain('$10.00')
      expect(body).toContain('Payment Required')
      expect(body).toContain('<script src="/pay.js"></script>')
      expect(body).toContain('__MPPX_DATA__')
    })

    test('returns service worker script when __mppx_worker param is set', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com?__mppx_worker')

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: htmlOptions,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/javascript')
      expect(response.headers.get('Cache-Control')).toBe('no-store')

      const body = await response.text()
      expect(body).toContain('addEventListener')
    })

    test('does not return html when Accept does not include text/html', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'application/json' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: htmlOptions,
      })

      expect(response.status).toBe(402)
      expect(response.headers.get('Content-Type')).toBeNull()
      expect(await response.text()).toBe('')
    })

    test('renders description when challenge has one', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const challengeWithDescription = {
        ...challenge,
        description: 'Access to premium content',
      }

      const response = await transport.respondChallenge({
        challenge: challengeWithDescription,
        input: request,
        html: htmlOptions,
      })

      const body = await response.text()
      expect(body).toContain('Access to premium content')
      expect(body).toContain('mppx-summary-description')
    })

    test('renders expires when challenge has one', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: htmlOptions,
      })

      const body = await response.text()
      expect(body).toContain('Expires at')
      expect(body).toContain('2025-01-01T00:00:00.000Z')
      expect(body).toContain('mppx-summary-expires')
    })

    test('does not render description when challenge lacks one', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const challengeNoDescription = { ...challenge }
      delete (challengeNoDescription as any).description

      const response = await transport.respondChallenge({
        challenge: challengeNoDescription,
        input: request,
        html: htmlOptions,
      })

      const body = await response.text()
      expect(body).not.toMatch(/<p class="mppx-summary-description"/)
    })

    test('applies custom text', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: {
          ...htmlOptions,
          text: { title: 'Pay Up', paymentRequired: 'Gotta Pay' },
        },
      })

      const body = await response.text()
      expect(body).toContain('<title>Pay Up</title>')
      expect(body).toContain('Gotta Pay')
    })

    test('applies custom theme logo', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: {
          ...htmlOptions,
          theme: { logo: 'https://example.com/logo.png' },
        },
      })

      const body = await response.text()
      expect(body).toContain('https://example.com/logo.png')
      expect(body).toContain('mppx-logo')
    })

    test('embeds config and challenge in data script', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: htmlOptions,
      })

      const body = await response.text()
      // Extract the JSON data from the script tag
      const dataMatch = body.match(
        /<script[^>]*id="__MPPX_DATA__"[^>]*type="application\/json"[^>]*>\s*([\s\S]*?)\s*<\/script>/s,
      )
      expect(dataMatch).not.toBeNull()

      const dataMap = JSON.parse(dataMatch?.[1]?.replace(/\\u003c/g, '<') ?? '')
      expect(typeof dataMap).toBe('object')
      expect(Object.keys(dataMap)).toHaveLength(1)
      const data = dataMap[challenge.id]
      expect(data.config).toEqual({ foo: 'bar' })
      expect(data.challenge.id).toBe(challenge.id)
      expect(data.challenge.method).toBe('tempo')
      expect(data.text.paymentRequired).toBe('Payment Required')
    })

    test('sanitizes html in formatted amount', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Accept: 'text/html' },
      })

      const response = await transport.respondChallenge({
        challenge,
        input: request,
        html: {
          ...htmlOptions,
          formatAmount: () => '<script>alert("xss")</script>',
        },
      })

      const body = await response.text()
      expect(body).not.toContain('<script>alert("xss")</script>')
      expect(body).toContain('&lt;script&gt;')
    })
  })

  describe('respondChallenge with error status codes', () => {
    test('BadRequestError returns 400', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')
      const error = new BadRequestError({ reason: 'invalid parameters' })

      const response = await transport.respondChallenge({ challenge, input: request, error })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.type).toBe('https://paymentauth.org/problems/bad-request')
      expect(body.status).toBe(400)
    })

    test('ChannelClosedError returns 410', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')
      const error = new ChannelClosedError({ reason: 'channel finalized' })

      const response = await transport.respondChallenge({ challenge, input: request, error })

      expect(response.status).toBe(410)
      const body = await response.json()
      expect(body.type).toBe('https://paymentauth.org/problems/session/channel-finalized')
      expect(body.status).toBe(410)
    })
  })

  describe('respondReceipt', () => {
    test('default', () => {
      const transport = Transport.http()
      const originalResponse = new Response('OK', { status: 200 })

      const response = transport.respondReceipt({
        credential,
        input: new Request('https://example.com'),
        receipt,
        response: originalResponse,
        challengeId: challenge.id,
      })

      expect({
        status: response.status,
        headers: Object.fromEntries(response.headers),
      }).toMatchInlineSnapshot(`
        {
          "headers": {
            "content-type": "text/plain;charset=UTF-8",
            "payment-receipt": "eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4dHhoYXNoIiwic3RhdHVzIjoic3VjY2VzcyIsInRpbWVzdGFtcCI6IjIwMjUtMDEtMDFUMDA6MDA6MDAuMDAwWiJ9",
          },
          "status": 200,
        }
      `)
    })
  })
})

describe('mcp', () => {
  const mcpRequest: Mcp.JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'test-tool',
    },
  }

  describe('getCredential', () => {
    test('returns credential from _meta', () => {
      const transport = Transport.mcp()
      const request: Mcp.JsonRpcRequest = {
        ...mcpRequest,
        params: {
          ...mcpRequest.params,
          _meta: {
            [Mcp.credentialMetaKey]: credential,
          },
        },
      }

      expect(transport.getCredential(request)).toMatchInlineSnapshot(`
        {
          "challenge": {
            "expires": "2025-01-01T00:00:00.000Z",
            "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000000000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
            },
          },
          "payload": {
            "signature": "0xabc123",
            "type": "transaction",
          },
        }
      `)
    })

    test('returns null when no credential in _meta', () => {
      const transport = Transport.mcp()

      expect(transport.getCredential(mcpRequest)).toBeNull()
    })
  })

  describe('respondChallenge', () => {
    test('default', () => {
      const transport = Transport.mcp()

      expect(transport.respondChallenge({ challenge, input: mcpRequest })).toMatchInlineSnapshot(`
        {
          "error": {
            "code": -32042,
            "data": {
              "challenges": [
                {
                  "expires": "2025-01-01T00:00:00.000Z",
                  "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
                  "intent": "charge",
                  "method": "tempo",
                  "realm": "api.example.com",
                  "request": {
                    "amount": "1000000000",
                    "currency": "0x20c0000000000000000000000000000000000001",
                    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
                  },
                },
              ],
              "httpStatus": 402,
            },
            "message": "Payment Required",
          },
          "id": 1,
          "jsonrpc": "2.0",
        }
      `)
    })
  })

  describe('respondReceipt', () => {
    test('default', () => {
      const transport = Transport.mcp()
      const successResponse: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [] },
      }

      expect(
        transport.respondReceipt({
          credential,
          input: mcpRequest,
          receipt,
          response: successResponse,
          challengeId: challenge.id,
        }),
      ).toMatchInlineSnapshot(`
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "_meta": {
              "org.paymentauth/receipt": {
                "challengeId": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
                "method": "tempo",
                "reference": "0xtxhash",
                "status": "success",
                "timestamp": "2025-01-01T00:00:00.000Z",
              },
            },
            "content": [],
          },
        }
      `)
    })

    test('returns error response unchanged', () => {
      const transport = Transport.mcp()
      const errorResponse: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      }

      expect(
        transport.respondReceipt({
          credential,
          input: mcpRequest,
          receipt,
          response: errorResponse,
          challengeId: challenge.id,
        }),
      ).toBe(errorResponse)
    })
  })
})
