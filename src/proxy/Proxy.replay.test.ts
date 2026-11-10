import { describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

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
    replay: { authority: 'test', ...parameters.replay, store },
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
    const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', maxAttempts: 2 } })

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
      replay: { authority: 'test', maxBodySize: 10, waitUntil: (promise) => pending.push(promise) },
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
      const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', ttl: 1_000 } })

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
    const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', store } })

    const response = await proxy.fetch(
      new Request('https://proxy.example/api/generate', { body: '{}', method: 'POST' }),
    )
    expect(response.status).toBe(200)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })
})

describe('replay review fixes', () => {
  test('rejects paid request bodies over maxRequestBodySize with 413 before payment', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({
      fetch,
      onPayment,
      replay: { authority: 'test', maxRequestBodySize: 8 },
    })

    const response = await proxy.fetch(paidRequest({ body: 'x'.repeat(64) }))
    expect(response.status).toBe(413)
    expect(onPayment).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('keys on the Payment scheme alone when Authorization carries several', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })
    const request = (bearer: string) =>
      new Request('https://proxy.example/api/generate', {
        body: '{}',
        headers: { Authorization: `Bearer ${bearer}, Payment credential-1` },
        method: 'POST',
      })

    await (await proxy.fetch(request('a'))).text()
    await new Promise((r) => setTimeout(r, 0))
    const retry = await proxy.fetch(request('b'))

    expect(retry.status).toBe(200)
    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('lets the payer retry when the upstream body breaks off', async () => {
    const onPayment = vi.fn()
    const pending: Promise<unknown>[] = []
    let calls = 0
    const fetch = vi.fn(async () => {
      calls++
      if (calls === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'))
              controller.error(new Error('reset'))
            },
          }),
        )
      return Response.json({ ok: true })
    }) as typeof globalThis.fetch
    const proxy = createProxy({
      fetch,
      onPayment,
      replay: { authority: 'test', waitUntil: (p) => pending.push(p) },
    })

    await (await proxy.fetch(paidRequest())).text().catch(() => {})
    await Promise.all(pending)
    const retry = await proxy.fetch(paidRequest())

    expect(retry.status).toBe(200)
    expect(retry.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('keeps upstream Cache-Control directives on a retried delivery', async () => {
    const onPayment = vi.fn()
    let calls = 0
    const fetch = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('reset')
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    await proxy.fetch(paidRequest())
    const retry = await proxy.fetch(paidRequest())

    expect(retry.headers.get('Cache-Control')).toBe('no-store, private')
  })

  test('does not leave an unhandled rejection when the background store write fails', async () => {
    const onPayment = vi.fn()
    const memory = Store.memory()
    let puts = 0
    const store = Store.from({
      ...memory,
      async put(key: string, value: unknown) {
        puts++
        if (puts > 1) throw new Error('store down')
        return memory.put(key, value)
      },
    }) as Store.AtomicStore
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const fetch = vi.fn(async () => new Response('ok')) as typeof globalThis.fetch
      const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', store } })

      expect(await (await proxy.fetch(paidRequest())).text()).toBe('ok')
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('keeps a slow delivery for ttl after it completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const onPayment = vi.fn()
      const fetch = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 900)
        return Response.json({ ok: true })
      }) as typeof globalThis.fetch
      const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', ttl: 1_000 } })

      await (await proxy.fetch(paidRequest())).text()
      await new Promise((r) => setTimeout(r, 0))
      vi.setSystemTime(Date.now() + 500)
      const retry = await proxy.fetch(paidRequest())

      expect(retry.status).toBe(200)
      expect(onPayment).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('replay key scope', () => {
  test.each([true])(
    'isolates failed deliveries between Node authorities (explicit=%s)',
    async (explicit) => {
      const store = Store.memory()
      const paidB = vi.fn()
      const upstreamA = vi.fn(
        async () => new Response('failed', { status: 502 }),
      ) as typeof globalThis.fetch
      const upstreamB = vi.fn(async () => new Response('paid B')) as typeof globalThis.fetch
      const a = createProxy({
        fetch: upstreamA,
        onPayment: vi.fn(),
        replay: { authority: 'test', store, ...(explicit ? { authority: 'a' } : {}) },
      })
      const b = createProxy({
        fetch: upstreamB,
        onPayment: paidB,
        replay: { authority: 'test', store, ...(explicit ? { authority: 'b' } : {}) },
      })
      const serverA = await Http.createServer(a.listener)
      const serverB = await Http.createServer(b.listener)
      const init = {
        method: 'POST',
        headers: { Host: 'a.example', Authorization: 'Payment credential-1' },
        body: '{}',
      }
      try {
        expect((await fetch(serverA.url + '/api/generate', init)).status).toBe(502)
        expect((await fetch(serverB.url + '/api/generate', init)).status).toBe(200)
        expect(paidB).toHaveBeenCalledOnce()
      } finally {
        serverA.close()
        serverB.close()
      }
    },
  )

  test('shares failed deliveries only between explicitly configured replicas', async () => {
    const store = Store.memory()
    const paid = vi.fn()
    const a = createProxy({
      fetch: vi.fn(async () => new Response('failed', { status: 502 })) as typeof globalThis.fetch,
      onPayment: paid,
      replay: { store, authority: 'replicas' },
    })
    const b = createProxy({
      fetch: vi.fn(async () => new Response('retried')) as typeof globalThis.fetch,
      onPayment: paid,
      replay: { store, authority: 'replicas' },
    })
    expect((await a.fetch(paidRequest())).status).toBe(502)
    expect(await (await b.fetch(paidRequest())).text()).toBe('retried')
    expect(paid).toHaveBeenCalledOnce()
  })

  test('does not replay a delivery on a proxy at another origin sharing the store', async () => {
    const store = Store.memory()
    const onPaymentA = vi.fn()
    const onPaymentB = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxyA = createProxy({
      fetch,
      onPayment: onPaymentA,
      replay: { authority: 'test', store },
    })
    const proxyB = createProxy({
      fetch,
      onPayment: onPaymentB,
      replay: { authority: 'test', store },
    })
    const request = (origin: string) =>
      new Request(origin + '/api/generate', {
        body: '{}',
        headers: { Authorization: 'Payment credential-1' },
        method: 'POST',
      })

    await (await proxyA.fetch(request('https://a.example'))).text()
    await new Promise((r) => setTimeout(r, 0))
    await (await proxyB.fetch(request('https://b.example'))).text()

    expect(onPaymentB).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('replay review fixes (cyclops)', () => {
  test('replays a stored 205 response', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => new Response(null, { status: 205 })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    expect((await proxy.fetch(paidRequest())).status).toBe(205)
    const retry = await proxy.fetch(paidRequest())
    expect(retry.status).toBe(205)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  test('does not write to the store for an unknown credential', async () => {
    const onPayment = vi.fn()
    const memory = Store.memory()
    const update = vi.fn(memory.update)
    const store = { ...memory, update } as Store.AtomicStore
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', store } })

    await (await proxy.fetch(paidRequest())).text()
    expect(update).not.toHaveBeenCalled()
  })

  test('skips replay on routes with identity verifiers', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const handler = Object.assign(createPaidHandler(onPayment), {
      _internal: { _canonicalRequest: {}, _identity: true, intent: 'charge', name: 'tempo' },
    }) as Service.IntentHandler
    const proxy = Proxy.create({
      fetch,
      replay: { authority: 'test', store: Store.memory() },
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          routes: { 'POST /generate': handler },
        }),
      ],
    })

    await (await proxy.fetch(paidRequest())).text()
    await new Promise((r) => setTimeout(r, 0))
    await (await proxy.fetch(paidRequest())).text()
    expect(onPayment).toHaveBeenCalledTimes(2)
  })
})

describe('replay retry headers', () => {
  test('a retried delivery sends the paid request headers, not the retry headers', async () => {
    const onPayment = vi.fn()
    const seen: (string | null)[] = []
    let calls = 0
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-tier'))
      calls++
      if (calls === 1) throw new Error('reset')
      return Response.json({ ok: true })
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })
    const request = (tier: string) =>
      new Request('https://proxy.example/api/generate', {
        body: '{}',
        headers: { Authorization: 'Payment credential-1', 'X-Tier': tier },
        method: 'POST',
      })

    expect((await proxy.fetch(request('basic'))).status).toBe(502)
    expect((await proxy.fetch(request('premium'))).status).toBe(200)

    expect(seen).toEqual(['basic', 'basic'])
    expect(onPayment).toHaveBeenCalledTimes(1)
  })
})

describe('replay review fixes (cyclops, round 3)', () => {
  test('rejects a ttl the timer cannot hold', () => {
    expect(() =>
      Proxy.create({
        replay: { authority: 'test', store: Store.memory(), ttl: Number.POSITIVE_INFINITY },
        services: [],
      }),
    ).toThrow(RangeError)
    expect(() =>
      Proxy.create({
        replay: { authority: 'test', store: Store.memory(), ttl: 2 ** 31 },
        services: [],
      }),
    ).toThrow(RangeError)
  })

  test('ignores Payment-Authorization when the route verifies Authorization', async () => {
    const onPayment = vi.fn()
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })
    const request = (credential: string) =>
      new Request('https://proxy.example/api/generate', {
        body: '{}',
        headers: {
          Authorization: 'Payment ' + credential,
          'Payment-Authorization': 'Payment label',
        },
        method: 'POST',
      })

    await (await proxy.fetch(request('credential-1'))).text()
    await new Promise((r) => setTimeout(r, 0))
    await (await proxy.fetch(request('credential-2'))).text()
    expect(onPayment).toHaveBeenCalledTimes(2)
  })

  test('awaits a withReceipt that returns a promise', async () => {
    const onPayment = vi.fn()
    const handler: Service.IntentHandler = async () => {
      onPayment()
      return {
        status: 200,
        withReceipt: ((response?: Response) => {
          if (!response) throw new Mppx.MissingReceiptResponseError()
          const headers = new Headers(response.headers)
          headers.set('Payment-Receipt', 'async-receipt')
          return Promise.resolve(new Response(response.body, { headers, status: response.status }))
        }) as never,
      }
    }
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = Proxy.create({
      fetch,
      replay: { authority: 'test', store: Store.memory() },
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          routes: { 'POST /generate': handler },
        }),
      ],
    })

    const response = await proxy.fetch(paidRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBe('async-receipt')
  })

  test('keeps a bodyless POST bodyless', async () => {
    const onPayment = vi.fn()
    let upstreamBody: unknown = 'unset'
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      upstreamBody = init?.body ?? null
      return Response.json({ ok: true })
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment })

    await proxy.fetch(
      new Request('https://proxy.example/api/generate', {
        headers: { Authorization: 'Payment credential-1' },
        method: 'POST',
      }),
    )
    expect(upstreamBody).toBeNull()
  })
})

describe('replay store failures', () => {
  test('still delivers a paid request when the store cannot be written', async () => {
    const onPayment = vi.fn()
    const memory = Store.memory()
    const store = Store.from({
      ...memory,
      async put() {
        throw new Error('store down')
      },
    }) as Store.AtomicStore
    const fetch = vi.fn(async () => Response.json({ ok: true })) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', store } })

    const response = await proxy.fetch(paidRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('Payment-Receipt')).toBe('test-receipt')
    expect(await response.json()).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('replay ttl scope', () => {
  test('does not cut off a body that streams past ttl', async () => {
    const onPayment = vi.fn()
    let upstreamSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('a'))
            await new Promise((r) => setTimeout(r, 60))
            controller.enqueue(new TextEncoder().encode('b'))
            controller.close()
          },
        }),
      )
    }) as typeof globalThis.fetch
    const proxy = createProxy({ fetch, onPayment, replay: { authority: 'test', ttl: 20 } })

    const response = await proxy.fetch(paidRequest())
    expect(await response.text()).toBe('ab')
    expect(upstreamSignal?.aborted).toBe(false)
  })
})

test('rejects missing replay authority before accepting any payment', () => {
  expect(() => Proxy.create({ services: [], replay: { store: Store.memory() } })).toThrow(
    'replay.authority',
  )
})

test('shares replay across equivalent canonical route and base URL configuration', async () => {
  const store = Store.memory()
  const paid = vi.fn()
  const create = (baseUrl: string, basePath: string, route: string, fail: boolean) =>
    Proxy.create({
      basePath,
      replay: { authority: 'replicas', store },
      fetch: vi.fn(
        async () => new Response(fail ? 'failed' : 'retried', { status: fail ? 502 : 200 }),
      ) as typeof fetch,
      services: [Service.from('api', { baseUrl, routes: { [route]: createPaidHandler(paid) } })],
    })
  const a = create('https://UPSTREAM.example:443/base/', '/paid/', 'post  /generate', true)
  const b = create('https://upstream.example/base', '/paid', 'POST /generate', false)
  const request = () =>
    new Request('https://proxy.example/paid/api/generate', {
      method: 'POST',
      headers: { Authorization: 'Payment credential-1' },
      body: '{}',
    })
  expect((await a.fetch(request())).status).toBe(502)
  expect(await (await b.fetch(request())).text()).toBe('retried')
  expect(paid).toHaveBeenCalledOnce()
})
