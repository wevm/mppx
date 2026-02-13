import { NodeListener, Request } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'

let server: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => server?.close())

describe('sendResponse', () => {
  test('writes status and headers', async () => {
    server = await Http.createServer(async (_, res) => {
      const response = new Response(null, {
        status: 204,
        headers: { 'X-Custom': 'hello' },
      })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(204)
    expect(response.headers.get('X-Custom')).toBe('hello')
  })

  test('streams text body', async () => {
    server = await Http.createServer(async (_, res) => {
      const response = new Response('hello world', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
  })

  test('streams json body', async () => {
    server = await Http.createServer(async (_, res) => {
      const response = Response.json({ fortune: 'You will be rich' })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fortune: 'You will be rich' })
  })

  test('streams chunked body', async () => {
    server = await Http.createServer(async (_, res) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'))
          controller.enqueue(new TextEncoder().encode('chunk2'))
          controller.close()
        },
      })
      const response = new Response(stream, { status: 200 })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('chunk1chunk2')
  })

  test('handles null body', async () => {
    server = await Http.createServer(async (_, res) => {
      const response = new Response(null, { status: 204 })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  test('preserves multiple Set-Cookie headers', async () => {
    server = await Http.createServer(async (_req, res) => {
      const headers = new Headers()
      headers.append('Set-Cookie', 'a=1')
      headers.append('Set-Cookie', 'b=2')
      const response = new Response('ok', { headers })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url)
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  test('skips body for HEAD requests', async () => {
    let bodyWritten = false
    server = await Http.createServer(async (_req, res) => {
      const original = res.write.bind(res)
      res.write = (...args: any[]) => {
        bodyWritten = true
        // @ts-expect-error
        return original(...(args as any))
      }
      const response = new Response('should not be sent', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
      await NodeListener.sendResponse(res, response)
    })

    const response = await fetch(server.url, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain')
    expect(bodyWritten).toBe(false)
  })
})

describe('toNodeListener', () => {
  test('converts fetch handler to node listener', async () => {
    const handler = Request.toNodeListener(async (request) => {
      const url = new URL(request.url)
      return Response.json({ path: url.pathname })
    })

    server = await Http.createServer(handler)

    const response = await fetch(`${server.url}/hello`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ path: '/hello' })
  })

  test('forwards request method', async () => {
    const handler = Request.toNodeListener(async (request) => {
      return Response.json({ method: request.method })
    })

    server = await Http.createServer(handler)

    const response = await fetch(server.url, { method: 'POST' })
    expect(await response.json()).toEqual({ method: 'POST' })
  })

  test('forwards request headers', async () => {
    const handler = Request.toNodeListener(async (request) => {
      return Response.json({ auth: request.headers.get('X-Api-Key') })
    })

    server = await Http.createServer(handler)

    const response = await fetch(server.url, {
      headers: { 'X-Api-Key': 'secret123' },
    })
    expect(await response.json()).toEqual({ auth: 'secret123' })
  })

  test('forwards request body', async () => {
    const handler = Request.toNodeListener(async (request) => {
      const body = await request.json()
      return Response.json({ echo: body })
    })

    server = await Http.createServer(handler)

    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(await response.json()).toEqual({ echo: { hello: 'world' } })
  })

  test('streams response body', async () => {
    const handler = Request.toNodeListener(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('a'))
          controller.enqueue(new TextEncoder().encode('b'))
          controller.enqueue(new TextEncoder().encode('c'))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/plain' },
      })
    })

    server = await Http.createServer(handler)

    const response = await fetch(server.url)
    expect(await response.text()).toBe('abc')
  })
})
