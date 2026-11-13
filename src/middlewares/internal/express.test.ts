import * as http from 'node:http'
import { Readable } from 'node:stream'

import express from 'express'
import { afterEach, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import { wrapResponse } from './express.js'

const servers: Http.TestServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})
async function serve(
  handler: (res: express.Response) => void,
  wrap: (response: Response) => Response | Promise<Response> = (r) => r,
  onError = vi.fn(),
) {
  const app = express()
  app.use((_req, res) => {
    wrapResponse(res, wrap, onError)
    handler(res)
  })
  const server = await Http.createServer(app)
  servers.push(server)
  return server
}

test.each(['send', 'end', 'write', 'pipe'] as const)(
  'gates %s output before payment',
  async (mode) => {
    const wrap = vi.fn(async () => new Response('payment required', { status: 402 }))
    const server = await serve((res) => {
      if (mode === 'send') res.send('protected')
      if (mode === 'end') res.end('protected')
      if (mode === 'write') {
        res.write('protected')
        res.end()
      }
      if (mode === 'pipe') Readable.from(['protected']).pipe(res)
    }, wrap)
    const response = await fetch(server.url)
    expect(response.status).toBe(402)
    expect(await response.text()).toBe('payment required')
    expect(wrap).toHaveBeenCalledOnce()
  },
)

test('preserves repeated raw headers and undefined status-message overload', async () => {
  const wrap = vi.fn((response: Response) => response)
  const server = await serve((res) => {
    res.writeHead(200, undefined, [
      'Set-Cookie',
      'a=1',
      'set-cookie',
      'b=2',
      'Content-Type',
      'text/event-stream',
    ])
    res.end('data: paid\n\n')
  }, wrap)
  const response = await fetch(server.url)
  expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  expect(wrap.mock.calls[0]?.[0].headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toBe('data: paid\n\n')
})

test.each([true, false])(
  'withholds hints and only sends accepted trailers: %s',
  async (accepted) => {
    const server = await serve(
      (res) => {
        res.writeEarlyHints({ link: '</protected>; rel=preload' })
        res.setHeader('Trailer', 'X-Protected')
        res.addTrailers({ 'X-Protected': 'secret' })
        res.end('paid')
      },
      (response) => (accepted ? response : new Response('denied', { status: 402 })),
    )
    const information = vi.fn()
    const result = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(server.url, (response) => {
          response.resume()
          response.on('end', () => resolve(response))
        })
        .on('information', information)
        .on('error', reject)
    })
    expect(information).not.toHaveBeenCalled()
    expect(result.trailers['x-protected']).toBe(accepted ? 'secret' : undefined)
  },
)

test('preserves downstream final-header hooks', async () => {
  const server = await serve((res) => {
    const previous = res.writeHead
    res.writeHead = function (this: express.Response, ...args: Parameters<typeof res.writeHead>) {
      this.setHeader('Content-Security-Policy', "default-src 'none'")
      return previous.apply(this, args)
    } as typeof res.writeHead
    res.end('paid')
  })
  const response = await fetch(server.url)
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(await response.text()).toBe('paid')
})

test('end callback runs after emission and cannot mutate delivered bytes', async () => {
  let headersSent = false
  const callback = vi.fn()
  const server = await serve(
    (res) => {
      const buffer = Buffer.from('protected')
      res.end(buffer, () => {
        headersSent = res.headersSent
        buffer.fill('x')
        callback()
      })
    },
    async (response) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response
    },
  )
  const response = await fetch(server.url)
  expect(await response.text()).toBe('protected')
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
  expect(headersSent).toBe(true)
})

test('failed accounting never restores raw handler output and reports its error', async () => {
  const error = new Error('accounting failed')
  const onError = vi.fn()
  const later = vi.fn()
  const server = await serve(
    (res) => {
      res.write('protected')
      setTimeout(() => {
        res.write('later', later)
        res.end()
      }, 10)
    },
    async () => {
      throw error
    },
    onError,
  )
  await expect(fetch(server.url)).rejects.toThrow()
  await vi.waitFor(() => expect(later).toHaveBeenCalled())
  expect(later.mock.calls[0]?.[0]).toBe(error)
  expect(onError).toHaveBeenCalledWith(error)
})

test('reports post-header stream failures', async () => {
  const error = new Error('metering failed')
  const onError = vi.fn()
  const server = await serve(
    (res) => res.end('paid'),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'))
            setTimeout(() => controller.error(error), 20)
          },
        }),
      ),
    onError,
  )
  const response = await fetch(server.url)
  await response.text().catch(() => {})
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error))
})

test('preserves paid application error responses', async () => {
  const server = await serve((res) => {
    res.status(404)
    res.end('not found')
  })
  const response = await fetch(server.url)
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('not found')
})

test('supports callback-driven writes without reopening the gate', async () => {
  const wrap = vi.fn((response: Response) => response)
  const server = await serve((res) => {
    res.write('one', () => res.write('two', () => res.end('three')))
  }, wrap)
  const response = await fetch(server.url)
  expect(await response.text()).toBe('onetwothree')
  expect(wrap).toHaveBeenCalledOnce()
})

test('applies downstream content-type hooks before choosing payment transport', async () => {
  const wrap = vi.fn((response: Response) => response)
  const server = await serve((res) => {
    const previous = res.writeHead
    res.writeHead = function (this: express.Response, ...args: Parameters<typeof res.writeHead>) {
      this.setHeader('Content-Type', 'text/event-stream')
      return previous.apply(this, args)
    } as typeof res.writeHead
    res.end('data: paid\n\n')
  }, wrap)
  await (await fetch(server.url)).text()
  expect(wrap.mock.calls[0]?.[0].headers.get('content-type')).toBe('text/event-stream')
})

test('runs downstream body transformations once', async () => {
  const writes = vi.fn()
  const ends = vi.fn()
  const server = await serve((res) => {
    const write = res.write.bind(res)
    const end = res.end.bind(res)
    res.write = ((chunk: string) => {
      writes()
      return write(`[${chunk}]`)
    }) as typeof res.write
    res.end = ((chunk: string) => {
      ends()
      return end(`(${chunk})`)
    }) as typeof res.end
    res.write('one')
    res.end('two')
  })
  expect(await (await fetch(server.url)).text()).toBe('[one](two)')
  expect(writes).toHaveBeenCalledOnce()
  expect(ends).toHaveBeenCalledOnce()
})

test('acknowledges split SSE input before a complete event is available', async () => {
  const server = await serve(
    (res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: ', () => res.end('paid\n\n'))
    },
    (response) => {
      let pending = ''
      return new Response(
        response.body!.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              pending += new TextDecoder().decode(chunk)
              if (pending.endsWith('\n\n')) controller.enqueue(new TextEncoder().encode(pending))
            },
          }),
        ),
        { headers: response.headers },
      )
    },
  )
  const response = await fetch(server.url, { signal: AbortSignal.timeout(2000) })
  expect(await response.text()).toBe('data: paid\n\n')
})

test.each([true, false])('gates writeHeader alias: accepted=%s', async (accepted) => {
  const server = await serve(
    (res) => {
      const alias = res as express.Response & { writeHeader: typeof res.writeHead }
      alias.writeHeader(200, { 'X-Protected': 'secret' })
      res.end('paid')
    },
    (response) => (accepted ? response : new Response('denied', { status: 402 })),
  )
  const response = await fetch(server.url)
  expect(response.status).toBe(accepted ? 200 : 402)
  expect(response.headers.get('X-Protected')).toBe(accepted ? 'secret' : null)
  expect(await response.text()).toBe(accepted ? 'paid' : 'denied')
})

test('exposes started output to conventional error middleware', async () => {
  const app = express()
  const errorBody = vi.fn()
  app.use((_req, res, next) => {
    wrapResponse(res, (response) => response, next)
    res.write('partial')
    next(new Error('handler failed'))
  })
  app.use(
    (error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(error)
      errorBody()
      res.status(500).end('error body')
    },
  )
  app.use(
    (_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.destroy()
    },
  )
  const server = await Http.createServer(app)
  servers.push(server)
  await expect(fetch(server.url)).rejects.toThrow()
  expect(errorBody).not.toHaveBeenCalled()
})

test.each([true, false])('runs downstream header hooks once: explicit=%s', async (explicit) => {
  const hook = vi.fn()
  const server = await serve((res) => {
    const previous = res.writeHead
    res.writeHead = function (this: express.Response, ...args: Parameters<typeof res.writeHead>) {
      hook()
      return previous.apply(this, args)
    } as typeof res.writeHead
    if (explicit) res.writeHead(200)
    res.end('paid')
  })
  expect(await (await fetch(server.url)).text()).toBe('paid')
  expect(hook).toHaveBeenCalledOnce()
})

test('completes every queued write when the producer reuses one callback', async () => {
  const callback = vi.fn()
  const count = 1024
  const server = await serve(
    (res) => {
      for (let i = 0; i < count; i++) res.write('x', callback)
      res.end()
    },
    async (response) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response
    },
  )
  expect(await (await fetch(server.url)).text()).toBe('x'.repeat(count))
  await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(count))
  expect(callback.mock.calls.every(([error]) => error == null)).toBe(true)
})
