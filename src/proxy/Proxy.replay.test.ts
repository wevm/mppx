import { describe, expect, test, vi } from 'vp/test'

import * as Mppx from '../server/Mppx.js'
import * as Store from '../Store.js'
import * as Proxy from './Proxy.js'
import * as Service from './Service.js'

function createPaidHandler(onPayment: () => void): Service.IntentHandler {
  return async () => {
    onPayment()
    return {
      status: 200,
      withReceipt<response>(response?: response): response {
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

function createProxy(parameters: {
  fetch: typeof globalThis.fetch
  onPayment: () => void
  replay?: Partial<Proxy.ReplayOptions>
}) {
  const store = parameters.replay?.store ?? Store.memory()
  return Proxy.create({
    fetch: parameters.fetch,
    replay: { ...parameters.replay, store },
    services: [
      Service.from('api', {
        baseUrl: 'https://upstream.example',
        routes: { 'POST /generate': createPaidHandler(parameters.onPayment) },
      }),
    ],
  })
}

function paidRequest(init?: { body?: string; credential?: string; signal?: AbortSignal }) {
  return new Request('https://proxy.example/api/generate', {
    body: init?.body ?? '{"prompt":"a cat"}',
    headers: { Authorization: `Payment ${init?.credential ?? 'credential-1'}` },
    method: 'POST',
    signal: init?.signal ?? null,
  })
}

function deferred<value>() {
  let resolve!: (value: value) => void
  const promise = new Promise<value>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('replay', () => {
  test('returns the stored response to a retry without charging again', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ video: 'v1' })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    const first = await proxy.fetch(paidRequest())
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ video: 'v1' })
    await new Promise((r) => setTimeout(r, 0))

    const retry = await proxy.fetch(paidRequest())
    expect(retry.status).toBe(200)
    expect(retry.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await retry.json()).toEqual({ video: 'v1' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  test('does not hand the stored response to a different request body', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    await (await proxy.fetch(paidRequest())).text()
    await new Promise((r) => setTimeout(r, 0))
    await (await proxy.fetch(paidRequest({ body: '{"prompt":"a dog"}' }))).text()

    expect(onPayment).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('finishes the upstream request after the client disconnects', async () => {
    const onPayment = vi.fn()
    const upstream = deferred<Response>()
    let upstreamSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return upstream.promise
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })
    const client = new AbortController()

    const first = proxy.fetch(paidRequest({ signal: client.signal }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    client.abort()
    expect(upstreamSignal?.aborted).toBe(false)

    const pending = await proxy.fetch(paidRequest())
    expect(pending.status).toBe(202)
    expect(pending.headers.get('Retry-After')).toBe('5')

    upstream.resolve(Response.json({ video: 'done' }))
    await first
    await vi.waitFor(async () => {
      const retry = await proxy.fetch(paidRequest())
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ video: 'done' })
    })
    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('retries a failed delivery without charging, up to maxAttempts', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => {
      throw new Error('connection reset')
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment, replay: { maxAttempts: 2 } })

    const first = await proxy.fetch(paidRequest())
    expect(first.status).toBe(502)
    expect(first.headers.get('Payment-Receipt')).toBe('test-receipt')

    const second = await proxy.fetch(paidRequest())
    expect(second.status).toBe(502)
    expect(second.headers.get('Payment-Receipt')).toBe('test-receipt')

    const third = await proxy.fetch(paidRequest())
    expect(third.status).toBe(502)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  test('a retry after a failed delivery can succeed and is then stored', async () => {
    const onPayment = vi.fn()
    let calls = 0
    const fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('unavailable', { status: 503 })
      return Response.json({ video: 'v2' })
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    expect((await proxy.fetch(paidRequest())).status).toBe(503)
    const second = await proxy.fetch(paidRequest())
    expect(second.status).toBe(200)
    expect(second.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await second.json()).toEqual({ video: 'v2' })
    await new Promise((r) => setTimeout(r, 0))

    const third = await proxy.fetch(paidRequest())
    expect(await third.json()).toEqual({ video: 'v2' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  test('delivers but does not store streamed responses', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response('data: hi\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    ) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    expect(await (await proxy.fetch(paidRequest())).text()).toBe('data: hi\n\n')
    const retry = await proxy.fetch(paidRequest())
    expect(retry.status).toBe(410)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  test('delivers but does not store bodies over maxBodySize', async () => {
    const onPayment = vi.fn()
    const pending: Promise<unknown>[] = []
    const fetch = vi.fn(async () => new Response('x'.repeat(100))) as typeof globalThis.fetch
    const proxy = createProxy({
      fetch,
      onPayment,
      replay: { maxBodySize: 10, waitUntil: (promise) => pending.push(promise) },
    })

    expect(await (await proxy.fetch(paidRequest())).text()).toBe('x'.repeat(100))
    await Promise.all(pending)
    expect((await proxy.fetch(paidRequest())).status).toBe(410)
  })

  test('forgets a delivery once its ttl passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const onPayment = vi.fn()
      const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
      const proxy = createProxy({ fetch, onPayment, replay: { ttl: 1_000 } })

      await (await proxy.fetch(paidRequest())).text()
      await new Promise((r) => setTimeout(r, 0))
      vi.setSystemTime(Date.now() + 2_000)
      await (await proxy.fetch(paidRequest())).text()

      expect(onPayment).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('leaves requests without a Payment credential alone', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const store = Store.memory()
    const proxy = createProxy({ fetch, onPayment, replay: { store } })

    const response = await proxy.fetch(
      new Request('https://proxy.example/api/generate', { body: '{}', method: 'POST' }),
    )
    expect(response.status).toBe(200)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })
})
