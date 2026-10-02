import { describe, expect, test, vi } from 'vp/test'

import * as Mppx from '../server/Mppx.js'
import * as Proxy from './Proxy.js'
import * as Service from './Service.js'

type CreatePaidProxyParameters = {
  fetch: typeof globalThis.fetch
  method?: 'GET' | 'POST' | undefined
  onCancel?: (() => void) | undefined
  onPayment?: (() => void) | undefined
  onProxyError?: Service.UpstreamErrorHandler | undefined
  onServiceError?: Service.UpstreamErrorHandler | undefined
  rewriteRequest?: Service.Service['rewriteRequest']
  rewriteResponse?: Service.Service['rewriteResponse']
}

function createPaidProxy(parameters: CreatePaidProxyParameters): Proxy.Proxy {
  const method = parameters.method ?? 'GET'
  const service = Service.from('api', {
    baseUrl: 'https://upstream.example',
    onUpstreamError: parameters.onServiceError,
    rewriteRequest: parameters.rewriteRequest,
    routes: {
      [`${method} /resource`]: createPaidHandler(parameters.onPayment, parameters.onCancel),
    },
  })
  service.rewriteResponse = parameters.rewriteResponse
  return Proxy.create({
    fetch: parameters.fetch,
    onUpstreamError: parameters.onProxyError,
    services: [service],
  })
}

function createPaidHandler(onPayment?: () => void, onCancel?: () => void): Service.IntentHandler {
  return async () => {
    onPayment?.()
    return {
      cancelReceipt: onCancel,
      status: 200,
      withReceipt<response>(response: response): response {
        if (!(response instanceof Response)) throw new Mppx.MissingReceiptResponseError()
        const headers = new Headers(response.headers)
        headers.set('Payment-Receipt', 'test-receipt')
        return new Response(response.body, {
          headers,
          status: response.status,
          statusText: response.statusText,
        }) as response
      },
    }
  }
}

function paidRequest(init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Payment test-credential')
  return new Request('https://proxy.example/api/resource', {
    ...init,
    headers,
  })
}

describe('onUpstreamError', () => {
  test('cancels the receipt before returning a paid fallback 405', async () => {
    const onCancel = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, method: 'GET', onCancel })

    const response = await proxy.fetch(paidRequest({ method: 'POST' }))

    expect(response.status).toBe(405)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('cancels the receipt when upstream proxying fails', async () => {
    const onCancel = vi.fn()
    const fetch = vi.fn(async () => {
      throw new Error('upstream failed')
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onCancel })

    await expect(proxy.fetch(paidRequest())).rejects.toThrow('upstream failed')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  test('preserves the upstream error when receipt cancellation also fails', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('upstream failed')
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({
      fetch,
      onCancel: () => {
        throw new Error('cleanup failed')
      },
    })

    await expect(proxy.fetch(paidRequest())).rejects.toThrow('upstream failed')
  })

  test('retries upstream without verifying payment again', async () => {
    const onPayment = vi.fn()
    const onUpstreamError = vi.fn((context: Service.UpstreamErrorContext) => ({
      retry: context.attempt < 3,
    })) as Service.UpstreamErrorHandler
    let attempts = 0
    const fetch = vi.fn(async () => {
      attempts++
      if (attempts < 3) return new Response('unavailable', { status: 503 })
      return Response.json({ ok: true })
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onPayment, onServiceError: onUpstreamError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await response.json()).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(onUpstreamError).toHaveBeenCalledTimes(2)
    expect(onUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        error: undefined,
        response: expect.objectContaining({ status: 503 }),
        service: expect.objectContaining({ id: 'api' }),
        upstreamPath: '/resource',
        upstreamRequest: expect.objectContaining({ url: 'https://upstream.example/resource' }),
      }),
    )
  })

  test('uses the proxy handler when the service has no override', async () => {
    const upstreamError = new Error('connection reset')
    const onProxyError = vi.fn((context: Service.UpstreamErrorContext) => ({
      retry: context.attempt < 2,
    })) as Service.UpstreamErrorHandler
    let attempts = 0
    const fetch = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw upstreamError
      return new Response('recovered')
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onProxyError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('recovered')
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(onProxyError).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        error: upstreamError,
        response: undefined,
      }),
    )
  })

  test('prefers the service handler over the proxy default', async () => {
    const onProxyError = vi.fn(() => ({ retry: true as const }))
    const onServiceError = vi.fn(() => ({ retry: false as const }))
    const fetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onProxyError, onServiceError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(429)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onServiceError).toHaveBeenCalledTimes(1)
    expect(onProxyError).not.toHaveBeenCalled()
  })

  test('returns a handler fallback and attaches a receipt when it succeeds', async () => {
    const onServiceError = vi.fn(() => ({
      response: Response.json({ cached: true }),
      retry: false as const,
    }))
    const fetch = vi.fn(
      async () => new Response('unavailable', { status: 503 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onServiceError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await response.json()).toEqual({ cached: true })
  })

  test('attaches a receipt when an upstream error is returned', async () => {
    const fetch = vi.fn(
      async () => new Response('upstream failed', { status: 500 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(500)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await response.text()).toBe('upstream failed')
  })

  test('preserves streaming when error recovery is disabled', async () => {
    const clone = vi.spyOn(Request.prototype, 'clone')
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(await new Request(input, init).text()).toBe('streamed body')
      return new Response('ok')
    }) as typeof globalThis.fetch
    const proxy = Proxy.create({
      fetch,
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          routes: { 'POST /resource': true },
        }),
      ],
    })

    try {
      const response = await proxy.fetch(
        new Request('https://proxy.example/api/resource', {
          body: 'streamed body',
          method: 'POST',
        }),
      )

      expect(response.status).toBe(200)
      expect(clone).not.toHaveBeenCalled()
    } finally {
      clone.mockRestore()
    }
  })

  test('preserves a failed response body read by the handler', async () => {
    const onServiceError = vi.fn(async ({ response }: Service.UpstreamErrorContext) => {
      expect(await response?.text()).toBe('upstream failed')
      return { retry: false as const }
    })
    const fetch = vi.fn(
      async () => new Response('upstream failed', { status: 503 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onServiceError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('upstream failed')
  })

  test('preserves a recovery response derived from the failed body', async () => {
    const onServiceError = vi.fn(({ response }: Service.UpstreamErrorContext) => ({
      response: new Response(response?.body, { status: 200 }),
      retry: false as const,
    }))
    const fetch = vi.fn(
      async () => new Response('recovered body', { status: 503 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onServiceError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await response.text()).toBe('recovered body')
  })

  test('does not block a retry when the handler partially reads the failed body', async () => {
    const onServiceError = vi.fn(async ({ response }: Service.UpstreamErrorContext) => {
      await response?.body?.getReader().read()
      return { retry: true as const }
    })
    let attempts = 0
    const fetch = vi.fn(async () => {
      attempts++
      if (attempts > 1) return new Response('recovered')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial failure'))
          },
        }),
        { status: 503 },
      )
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onServiceError })

    const response = await proxy.fetch(paidRequest())

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('recovered')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('does not retry response rewrite failures', async () => {
    const rewriteError = new Error('invalid upstream response')
    const onServiceError = vi.fn(() => ({ retry: true as const }))
    const rewriteResponse = vi.fn(() => {
      throw rewriteError
    })
    const fetch = vi.fn(async () => new Response('created')) as typeof globalThis.fetch
    const proxy = createPaidProxy({
      fetch,
      method: 'POST',
      onServiceError,
      rewriteResponse,
    })

    await expect(
      proxy.fetch(paidRequest({ body: 'create resource', method: 'POST' })),
    ).rejects.toBe(rewriteError)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onServiceError).not.toHaveBeenCalled()
  })

  test('preserves a POST body across delayed retries', async () => {
    const bodies: string[] = []
    const rewriteRequest = vi.fn((request: Request) => request)
    const onServiceError = vi.fn(() => ({ delay: 1, retry: true as const }))
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      bodies.push(await request.text())
      if (bodies.length === 1) return new Response('rate limited', { status: 429 })
      return Response.json({ ok: true })
    }) as typeof globalThis.fetch
    const proxy = createPaidProxy({
      fetch,
      method: 'POST',
      onServiceError,
      rewriteRequest,
    })

    const response = await proxy.fetch(
      paidRequest({
        body: JSON.stringify({ prompt: 'hello' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    expect(bodies).toEqual(['{"prompt":"hello"}', '{"prompt":"hello"}'])
    expect(rewriteRequest).toHaveBeenCalledTimes(2)
    expect(onServiceError).toHaveBeenCalledTimes(1)
  })

  test('stops a delayed retry when the client aborts', async () => {
    const controller = new AbortController()
    let handlerCalled: (() => void) | undefined
    const called = new Promise<void>((resolve) => {
      handlerCalled = resolve
    })
    const onServiceError: Service.UpstreamErrorHandler = () => {
      handlerCalled?.()
      return { delay: 60_000, retry: true }
    }
    const fetch = vi.fn(
      async () => new Response('unavailable', { status: 503 }),
    ) as typeof globalThis.fetch
    const proxy = createPaidProxy({ fetch, onServiceError })
    const response = proxy.fetch(paidRequest({ signal: controller.signal }))
    const assertion = expect(response).rejects.toThrow('stop retrying')

    await called
    controller.abort(new Error('stop retrying'))

    await assertion
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('also recovers free upstream routes without adding a receipt', async () => {
    const onUpstreamError = vi.fn(() => ({ retry: true as const }))
    let attempts = 0
    const fetch = vi.fn(async () => {
      attempts++
      if (attempts === 1) return new Response('unavailable', { status: 503 })
      return new Response('public resource')
    }) as typeof globalThis.fetch
    const proxy = Proxy.create({
      fetch,
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          onUpstreamError,
          routes: { 'GET /resource': true },
        }),
      ],
    })

    const response = await proxy.fetch(new Request('https://proxy.example/api/resource'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('public resource')
    expect(response.headers.get('Payment-Receipt')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
