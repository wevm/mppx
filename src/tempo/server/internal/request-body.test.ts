import { describe, expect, test } from 'vp/test'

import {
  captureRequestBodyProbe,
  hasCapturedRequestBody,
  isSessionContentRequest,
  shouldChargePlainResponse,
} from './request-body.js'

describe('request-body', () => {
  describe('hasCapturedRequestBody', () => {
    test('returns true when the captured request recorded a body stream', () => {
      expect(
        hasCapturedRequestBody({
          hasBody: true,
          headers: new Headers(),
        }),
      ).toBe(true)
    })

    test('returns true when content-length is non-zero', () => {
      expect(
        hasCapturedRequestBody({
          headers: new Headers({ 'content-length': '42' }),
        }),
      ).toBe(true)
    })

    test('returns true when transfer-encoding is present', () => {
      expect(
        hasCapturedRequestBody({
          headers: new Headers({ 'transfer-encoding': 'chunked' }),
        }),
      ).toBe(true)
    })

    test('returns false for bodyless requests without framing headers', () => {
      expect(
        hasCapturedRequestBody({
          hasBody: false,
          headers: new Headers(),
        }),
      ).toBe(false)
    })
  })

  describe('isSessionContentRequest', () => {
    test('treats GET requests as content requests', () => {
      expect(
        isSessionContentRequest({
          headers: new Headers(),
          method: 'GET',
        }),
      ).toBe(true)
    })

    test('treats POST requests with a body stream and no content-length as content requests', () => {
      expect(
        isSessionContentRequest({
          hasBody: true,
          headers: new Headers(),
          method: 'POST',
        }),
      ).toBe(true)
    })

    test('treats bodyless POST requests as management requests', () => {
      expect(
        isSessionContentRequest({
          hasBody: false,
          headers: new Headers(),
          method: 'POST',
        }),
      ).toBe(false)
    })
  })

  describe('shouldChargePlainResponse', () => {
    test('does not charge close or topUp actions', () => {
      const input = {
        hasBody: true,
        headers: new Headers(),
        method: 'POST',
      } as const

      expect(shouldChargePlainResponse(input, { action: 'close' })).toBe(false)
      expect(shouldChargePlainResponse(input, { action: 'topUp' })).toBe(false)
    })

    test('charges POST content requests detected via the body stream', () => {
      expect(
        shouldChargePlainResponse(
          {
            hasBody: true,
            headers: new Headers(),
            method: 'POST',
          },
          { action: 'voucher' },
        ),
      ).toBe(true)
    })

    test('does not charge bodyless POST management requests', () => {
      expect(
        shouldChargePlainResponse(
          {
            hasBody: false,
            headers: new Headers(),
            method: 'POST',
          },
          { action: 'voucher' },
        ),
      ).toBe(false)
    })
  })

  describe('captureRequestBodyProbe', () => {
    test('captures body presence from Request.body', () => {
      const request = new Request('https://example.com', {
        body: JSON.stringify({ prompt: 'hello' }),
        method: 'POST',
      })

      const probe = captureRequestBodyProbe(request)
      expect(request.headers.get('content-length')).toBeNull()
      expect(probe).toEqual({
        headers: request.headers,
        hasBody: true,
        method: 'POST',
      })
    })
  })
})
