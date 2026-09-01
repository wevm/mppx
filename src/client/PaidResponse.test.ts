import { Challenge, Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { describe, expect, test, vi } from 'vp/test'

import * as Fetch from './internal/Fetch.js'
import * as MethodResponse from './internal/MethodResponse.js'
import * as PaidResponse from './PaidResponse.js'

const paidReceipt = Receipt.from({
  method: 'tempo',
  reference: '0x1234',
  status: 'success',
  timestamp: '2025-01-21T12:00:00.000Z',
})

const foreignReceipt = Receipt.from({
  method: 'stripe',
  reference: 'pi_foreign',
  status: 'success',
  timestamp: '2024-01-01T00:00:00.000Z',
})

const currentChallenge = Challenge.from({
  id: 'current',
  intent: 'test',
  method: 'test',
  realm: 'test',
  request: { amount: '1' },
})

const foreignChallenge = Challenge.from({
  id: 'foreign',
  intent: 'charge',
  method: 'stripe',
  realm: 'attacker.example',
  request: { amount: '9' },
})

const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

function make402() {
  const request = btoa(JSON.stringify({ amount: '1' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return new Response(null, {
    status: 402,
    headers: {
      'WWW-Authenticate': `Payment id="abc", realm="test", method="test", intent="test", request="${request}"`,
    },
  })
}

function makePaid(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Payment-Receipt': Receipt.serialize(paidReceipt),
    },
  })
}

describe('PaidResponse.view', () => {
  test('default: reads receipt without consuming the body', async () => {
    const response = makePaid('{"id":"1"}')
    const viewed = PaidResponse.view(response)
    expect(viewed.receipt).toEqual(paidReceipt)
    expect(await response.json()).toEqual({ id: '1' })
  })

  test('behavior: missing or malformed receipt is undefined', () => {
    expect(PaidResponse.receiptOf(new Response('{}'))).toBeUndefined()
    expect(
      PaidResponse.receiptOf(
        new Response('{}', { headers: { 'Payment-Receipt': 'not-valid-base64url!!!' } }),
      ),
    ).toBeUndefined()
  })
})

describe('PaidResponse.validate', () => {
  test('default: returns the original response when the caller accepts it', async () => {
    const response = makePaid('{"id":"1"}')
    const validated = await PaidResponse.validate(response, async ({ response, receipt }) => {
      expect(receipt).toEqual(paidReceipt)
      expect(await response.json()).toEqual({ id: '1' })
    })
    expect(validated).toBe(response)
    expect(await validated.json()).toEqual({ id: '1' })
  })

  test('error: keeps receipt and response when application output is invalid', async () => {
    const response = makePaid('{"id":1}')
    const error = await PaidResponse.validate(response, async ({ response }) => {
      const body = (await response.json()) as { id: unknown }
      if (typeof body.id !== 'string') throw new Error('id must be a string')
    }).catch((value) => value)

    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(PaidResponse.isInvalidError(error)).toBe(true)
    expect(error).toMatchObject({
      credential: undefined,
      message: 'Paid application response failed caller validation: id must be a string',
      name: 'PaidResponseInvalidError',
      receipt: paidReceipt,
    })
    expect(error.response).toBe(response)
    expect(Receipt.fromResponse(error.response)).toEqual(paidReceipt)
    expect(await error.response.json()).toEqual({ id: 1 })
  })

  test('error: binds a foreign InvalidError to the current response and payment context', async () => {
    const response = makePaid('{"id":"1"}')
    const foreignResponse = new Response('{"id":"foreign"}', {
      headers: { 'Payment-Receipt': Receipt.serialize(foreignReceipt) },
    })
    const foreignError = new PaidResponse.InvalidError({
      challenge: foreignChallenge,
      credential: 'foreign-credential',
      message: 'foreign output',
      receipt: foreignReceipt,
      response: foreignResponse,
    })

    const error = await PaidResponse.validate(
      response,
      () => {
        throw foreignError
      },
      { challenge: currentChallenge, credential: 'credential' },
    ).catch((value) => value)

    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(error).not.toBe(foreignError)
    expect(error.cause).toBe(foreignError)
    expect(error.challenge).toBe(currentChallenge)
    expect(error.credential).toBe('credential')
    expect(error.receipt).toEqual(paidReceipt)
    expect(error.response).toBe(response)
    expect(error.message).toBe('Paid application response failed caller validation: foreign output')
    expect(Receipt.fromResponse(error.response)).toEqual(paidReceipt)
    expect(await error.response.json()).toEqual({ id: '1' })
    expect(foreignError.response).toBe(foreignResponse)
    expect(foreignError.receipt).toEqual(foreignReceipt)
  })

  test('error: fails closed when the response body cannot be cloned', async () => {
    const response = makePaid('{"id":"1"}')
    await response.arrayBuffer()
    let cloneThrows = false
    try {
      response.clone()
    } catch {
      cloneThrows = true
    }
    if (!cloneThrows) {
      vi.spyOn(response, 'clone').mockImplementation(() => {
        throw new TypeError('Response body is disturbed or locked')
      })
    }

    const validator = vi.fn()
    const error = await PaidResponse.validate(response, validator, {
      challenge: currentChallenge,
      credential: 'credential',
    }).catch((value) => value)

    expect(validator).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(error.challenge).toBe(currentChallenge)
    expect(error.credential).toBe('credential')
    expect(error.message).toBe(
      'Paid application response could not be cloned for caller validation.',
    )
    expect(error.receipt).toEqual(paidReceipt)
    expect(error.response).toBe(response)
    expect(error.response.bodyUsed).toBe(true)
  })
})

describe('Fetch.from: validateResponse', () => {
  test('behavior: absent hook preserves invalid application output', async () => {
    let calls = 0
    const fetch = Fetch.from({
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":1}')
      },
      methods: [noopMethod],
    })

    const response = await fetch('https://example.com/paid')
    expect(calls).toBe(2)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 1 })
    expect(Receipt.fromResponse(response)).toEqual(paidReceipt)
  })

  test('behavior: accepts ordinary paid JSON without retrying', async () => {
    let calls = 0
    const seen: unknown[] = []
    const fetch = Fetch.from({
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":"1"}')
      },
      methods: [noopMethod],
      validateResponse: async ({ response, receipt, credential }) => {
        seen.push(credential, receipt, await response.json())
      },
    })

    const response = await fetch('https://example.com/paid')
    expect(calls).toBe(2)
    expect(seen).toEqual(['credential', paidReceipt, { id: '1' }])
    expect(await response.json()).toEqual({ id: '1' })
  })

  test('error: invalid output does not retry or duplicate payment', async () => {
    let calls = 0
    const events: string[] = []
    const eventDispatcher = Fetch.createEventDispatcher<[typeof noopMethod]>()
    eventDispatcher.on('payment.failed', () => {
      events.push('payment.failed')
    })
    eventDispatcher.on('payment.response', () => {
      events.push('payment.response')
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":1}')
      },
      methods: [noopMethod],
      validateResponse: async ({ response }) => {
        const body = (await response.json()) as { id: unknown }
        if (typeof body.id !== 'string') throw new Error('id must be a string')
      },
    })

    const error = await fetch('https://example.com/paid').catch((value) => value)
    expect(calls).toBe(2)
    expect(events).toEqual(['payment.response'])
    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(error.credential).toBe('credential')
    expect(error.receipt).toEqual(paidReceipt)
    expect(error.challenge?.id).toBe('abc')
    expect(Receipt.fromResponse(error.response)).toEqual(paidReceipt)
    expect(await error.response.json()).toEqual({ id: 1 })
  })

  test('behavior: validates protocol recovery responses, not the raw paid body', async () => {
    const method = { ...noopMethod }
    MethodResponse.register(method, async ({ response }) => {
      await response.text()
      return new Response('{"id":"recovered"}', {
        headers: response.headers,
        status: response.status,
      })
    })

    let calls = 0
    const seen: unknown[] = []
    const fetch = Fetch.from({
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":"raw"}')
      },
      methods: [method],
      validateResponse: async ({ response }) => {
        seen.push(await response.json())
      },
    })

    const response = await fetch('https://example.com/paid')
    expect(calls).toBe(2)
    expect(seen).toEqual([{ id: 'recovered' }])
    expect(await response.json()).toEqual({ id: 'recovered' })
    expect(Receipt.fromResponse(response)).toEqual(paidReceipt)
  })

  test('error: recovery dropping headers keeps the raw paid receipt', async () => {
    const method = { ...noopMethod }
    MethodResponse.register(method, async ({ response }) => {
      await response.text()
      return new Response('{"id":"recovered"}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    })

    let calls = 0
    const seen: { body: unknown; header: string | null; receipt: unknown }[] = []
    const fetch = Fetch.from({
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":"raw"}')
      },
      methods: [method],
      validateResponse: async ({ response, receipt }) => {
        seen.push({
          body: await response.json(),
          header: response.headers.get('Payment-Receipt'),
          receipt,
        })
        throw new Error('reject recovered body')
      },
    })

    const error = await fetch('https://example.com/paid').catch((value) => value)
    expect(calls).toBe(2)
    expect(seen).toEqual([{ body: { id: 'recovered' }, header: null, receipt: paidReceipt }])
    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(error.challenge?.id).toBe('abc')
    expect(error.credential).toBe('credential')
    expect(error.receipt).toEqual(paidReceipt)
    expect(error.response.headers.get('Payment-Receipt')).toBeNull()
    expect(await error.response.json()).toEqual({ id: 'recovered' })
  })

  test('behavior: validates non-ok paid responses without recovery wrapping', async () => {
    const method = { ...noopMethod }
    const handle = vi.fn(async ({ response }: MethodResponse.HandlerParameters) => response)
    MethodResponse.register(method, handle)

    let calls = 0
    const fetch = Fetch.from({
      fetch: async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"error":"rate limited"}', 429)
      },
      methods: [method],
      validateResponse: async ({ response, receipt }) => {
        expect(response.status).toBe(429)
        expect(receipt).toEqual(paidReceipt)
      },
    })

    const response = await fetch('https://example.com/paid')
    expect(calls).toBe(2)
    expect(handle).not.toHaveBeenCalled()
    expect(response.status).toBe(429)
    expect(Receipt.fromResponse(response)).toEqual(paidReceipt)
  })

  test('behavior: does not validate unpaid responses', async () => {
    const validateResponse = vi.fn()
    const fetch = Fetch.from({
      fetch: async () => new Response('free'),
      methods: [noopMethod],
      validateResponse,
    })

    expect(await (await fetch('https://example.com/free')).text()).toBe('free')
    expect(validateResponse).not.toHaveBeenCalled()
  })
})

describe('Mppx.create: validateResponse', () => {
  test('behavior: rejects invalid paid output through the public client', async () => {
    let calls = 0
    const mppx = Mppx.create({
      fetch: (async (_input, init) => {
        calls++
        if (!new Headers(init?.headers).has('Authorization')) return make402()
        return makePaid('{"id":1}')
      }) as typeof globalThis.fetch,
      methods: [noopMethod],
      polyfill: false,
      validateResponse: async ({ response }) => {
        const body = (await response.json()) as { id: unknown }
        if (typeof body.id !== 'string') throw new Error('id must be a string')
      },
    })

    const error = await mppx.fetch('https://example.com/paid').catch((value) => value)
    expect(calls).toBe(2)
    expect(error).toBeInstanceOf(PaidResponse.InvalidError)
    expect(error.receipt).toEqual(paidReceipt)
  })
})
