import { createParser as createReferenceParser } from 'eventsource-parser'
import * as fc from 'fast-check'
import { Challenge, Credential, Mcp, Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import { mcp } from './Mcp.js'

const challenge = Challenge.fromMethod(Methods.charge, {
  realm: 'api.example.com',
  secretKey: 'test-secret-key',
  expires: '2025-01-01T00:00:00.000Z',
  request: {
    amount: '0.001',
    currency: '0x20c0000000000000000000000000000000000001',
    decimals: 6,
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  },
})

const paymentRequired = {
  jsonrpc: '2.0',
  id: 1,
  error: {
    code: Mcp.paymentRequiredCode,
    message: 'Payment Required',
    data: { challenges: [challenge] },
  },
}

const request = (overrides: Partial<RequestInit> = {}) =>
  ({
    headers: { accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
    ...overrides,
  }) satisfies RequestInit

const jsonResponse = (body: unknown, contentType = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': contentType },
  })

const sseResponse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } })

const sseEvent = (data: unknown, event = 'message') =>
  `${event ? `event: ${event}\n` : ''}data: ${
    typeof data === 'string' ? data : JSON.stringify(data)
  }\n\n`

async function getChallengeIds(response: Response, requestInit = request()) {
  return (await mcp().getChallenges(response, requestInit)).map((entry) => entry.id)
}

describe('mcp HTTP protocol', () => {
  test('extracts payment challenges from JSON-RPC error JSON', async () => {
    expect(await getChallengeIds(jsonResponse(paymentRequired))).toEqual([challenge.id])
  })

  test('extracts retry challenges from payment verification errors', async () => {
    const response = jsonResponse({
      ...paymentRequired,
      error: { ...paymentRequired.error, code: Mcp.paymentVerificationFailedCode },
    })

    expect(await getChallengeIds(response)).toEqual([challenge.id])
  })

  test('extracts all valid payment challenges', async () => {
    const alternate = { ...challenge, id: 'alternate' }
    const response = jsonResponse({
      ...paymentRequired,
      error: {
        ...paymentRequired.error,
        data: { challenges: [challenge, alternate] },
      },
    })

    expect(await getChallengeIds(response)).toEqual([challenge.id, alternate.id])
  })

  test('parses JSON content types case-insensitively', async () => {
    const response = jsonResponse(paymentRequired, 'Application/JSON; charset=utf-8')

    expect(await getChallengeIds(response)).toEqual([challenge.id])
  })

  test.each([
    { body: '[', name: 'invalid JSON' },
    { body: [paymentRequired], name: 'JSON-RPC batch' },
    {
      body: { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
      name: 'notification',
    },
    { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, name: 'request' },
    { body: { ...paymentRequired, jsonrpc: '2.1' }, name: 'wrong JSON-RPC version' },
    { body: { ...paymentRequired, id: null }, name: 'null id' },
    { body: { ...paymentRequired, id: 2 }, name: 'different id' },
    { body: { ...paymentRequired, result: {} }, name: 'result and error together' },
    { body: { jsonrpc: '2.0', id: 1, result: {} }, name: 'successful result' },
    {
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      },
      name: 'non-payment error',
    },
    {
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: `${Mcp.paymentRequiredCode}`, message: 'Payment Required' },
      },
      name: 'string error code',
    },
    {
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: Mcp.paymentRequiredCode, message: 402 },
      },
      name: 'non-string error message',
    },
  ])('ignores $name message shapes', async ({ body }) => {
    expect(await getChallengeIds(jsonResponse(body))).toEqual([])
  })

  test.each([
    { challenges: undefined, name: 'missing challenges' },
    { challenges: [], name: 'empty challenges' },
    { challenges: challenge, name: 'non-array challenges' },
    { challenges: [{ ...challenge, realm: undefined }], name: 'invalid challenge' },
    {
      challenges: [challenge, { ...challenge, realm: undefined }],
      name: 'partially invalid challenges',
    },
  ])('ignores $name', async ({ challenges }) => {
    const response = jsonResponse({
      ...paymentRequired,
      error: {
        ...paymentRequired.error,
        data: challenges === undefined ? undefined : { challenges },
      },
    })

    expect(await getChallengeIds(response)).toEqual([])
  })

  test('matches string request and response ids without coercion', async () => {
    const stringRequest = request({
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: {} }),
    })
    const response = jsonResponse({ ...paymentRequired, id: '1' })

    expect(await getChallengeIds(response, stringRequest)).toEqual([challenge.id])
    expect(await getChallengeIds(jsonResponse(paymentRequired), stringRequest)).toEqual([])
  })

  test.each([
    {
      body: '{',
      headers: { accept: 'application/json, text/event-stream' },
      name: 'malformed request JSON',
    },
    {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      headers: { accept: 'application/json, text/event-stream' },
      name: 'request without id',
    },
    {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, params: {} }),
      headers: { accept: 'application/json, text/event-stream' },
      name: 'request without method',
    },
    {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
      headers: { accept: 'application/json' },
      name: 'request without Streamable HTTP accept',
    },
  ])('does not inspect responses for $name', async ({ body, headers }) => {
    expect(
      await getChallengeIds(jsonResponse(paymentRequired), request({ body, headers })),
    ).toEqual([])
  })

  test('accepts the mcp-method header as MCP request provenance', async () => {
    const requestInit = request({
      headers: { 'mcp-method': 'tools/call' },
    })

    expect(await getChallengeIds(jsonResponse(paymentRequired), requestInit)).toEqual([
      challenge.id,
    ])
  })

  test('does not inspect native HTTP 402 responses', async () => {
    expect(await getChallengeIds(jsonResponse(paymentRequired), request({}))).toEqual([
      challenge.id,
    ])
    expect(
      await getChallengeIds(
        new Response(JSON.stringify(paymentRequired), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).toEqual([])
  })

  test.each([
    { body: sseEvent(paymentRequired), name: 'message event' },
    { body: sseEvent(paymentRequired, ''), name: 'event without explicit type' },
    { body: `: keepalive\n\n${sseEvent(paymentRequired)}`, name: 'message after SSE comment' },
  ])('extracts payment challenges from SSE $name', async ({ body }) => {
    expect(await getChallengeIds(sseResponse(body))).toEqual([challenge.id])
  })

  test.each([
    { body: sseEvent('{'), name: 'invalid JSON' },
    { body: sseEvent({ jsonrpc: '2.0', method: 'notifications/progress' }), name: 'notification' },
    { body: sseEvent(paymentRequired, 'progress'), name: 'non-message event' },
    {
      body:
        sseEvent({ jsonrpc: '2.0', method: 'notifications/progress' }) + sseEvent(paymentRequired),
      name: 'payment challenge after first data event',
    },
  ])('ignores SSE $name', async ({ body }) => {
    expect(await getChallengeIds(sseResponse(body))).toEqual([])
  })
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const liveChallenge = (description?: string) =>
  Challenge.fromMethod(Methods.charge, {
    realm: 'api.example.com',
    secretKey: 'test-secret-key',
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...(description ? { description } : {}),
    request: {
      amount: '0.001',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    },
  })

const unicodeDescription = 'Prämie € 支払い 😀 ok\u2026'
const unicodeChallenge = liveChallenge(unicodeDescription)
const unicodePaymentRequired = {
  ...paymentRequired,
  error: {
    ...paymentRequired.error,
    message: 'Zahlung erforderlich — 支払い 💸',
    data: { challenges: [unicodeChallenge] },
  },
}

/** An SSE response whose body arrives as exactly these chunks. */
const streamResponse = (chunks: readonly Uint8Array[], contentType = 'text/event-stream') =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { headers: { 'content-type': contentType } },
  )

/** Cuts `bytes` at `offsets`, keeping empty chunks. */
function cut(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const sorted = [0, ...[...offsets].sort((a, b) => a - b), bytes.length]
  return sorted.slice(1).map((end, index) => bytes.subarray(sorted[index], end))
}

/** One chunk per byte. */
const bytewise = (bytes: Uint8Array) =>
  Array.from(bytes, (_, index) => bytes.subarray(index, index + 1))

/** Deterministic chunk sizes from 1 to 64 bytes. */
function randomChunks(bytes: Uint8Array, seed: number): Uint8Array[] {
  let state = seed
  const offsets: number[] = []
  for (let offset = 0; offset < bytes.length;) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    offset += 1 + (state % 64)
    if (offset < bytes.length) offsets.push(offset)
  }
  return cut(bytes, offsets)
}

const lines = (text: string, ending: string) => text.replaceAll('\n', ending)

/** A JSON-RPC message as an SSE event whose JSON spans several `data` lines. */
const multilineEvent = (data: unknown) =>
  `event: message\n${JSON.stringify(data, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`

async function challengesOf(chunks: readonly Uint8Array[], contentType?: string) {
  return mcp().getChallenges(streamResponse(chunks, contentType), request())
}

/**
 * The challenge ids the pre-PR implementation found in an SSE body: eventsource-parser 4.1.1
 * fed the way Mcp.ts fed it, its first data event's JSON then read as a JSON body.
 */
async function legacyChallengeIds(chunks: readonly Uint8Array[]): Promise<string[]> {
  const textDecoder = new TextDecoder()
  let seen = false
  let data: string | undefined
  const parser = createReferenceParser({
    onEvent(event) {
      if (seen || !event.data) return
      seen = true
      if (event.event && event.event !== 'message') return
      data = event.data
    },
  })
  for (const chunk of chunks) {
    if (seen) break
    parser.feed(textDecoder.decode(chunk, { stream: true }))
  }
  if (!seen) {
    parser.feed(textDecoder.decode())
    parser.reset({ consume: true })
  }
  return data === undefined ? [] : getChallengeIds(jsonResponse(data))
}

async function expectLegacyIds(chunks: readonly Uint8Array[], expected: string[]) {
  expect((await challengesOf(chunks)).map((entry) => entry.id)).toEqual(expected)
  expect(await legacyChallengeIds(chunks)).toEqual(expected)
}

describe('mcp SSE byte streams', () => {
  test('decodes multi-byte UTF-8 split at every byte offset', async () => {
    const body = encoder.encode(`: ü € 😀\n\n${sseEvent(unicodePaymentRequired)}`)
    expect(body.length).toBeGreaterThan(new TextDecoder().decode(body).length)
    for (let offset = 0; offset <= body.length; offset++) {
      const challenges = await challengesOf(cut(body, [offset]))
      expect(challenges.map((entry) => entry.description)).toEqual([unicodeDescription])
    }
  })

  test('decodes 2, 3 and 4 byte characters split into single bytes', async () => {
    const body = encoder.encode(sseEvent(unicodePaymentRequired))
    const expectDescription = async (chunks: Uint8Array[]) =>
      expect((await challengesOf(chunks)).map((entry) => entry.description)).toEqual([
        unicodeDescription,
      ])
    await expectDescription(bytewise(body))
    for (let offset = 0; offset < body.length; offset++) {
      if (body[offset]! < 0x80) continue
      await expectDescription(cut(body, [offset, offset + 1]))
    }
  })

  test.each([
    { ending: '\r\n', name: 'CRLF' },
    { ending: '\r', name: 'CR' },
    { ending: '\n', name: 'LF' },
  ])(
    'reads $name line endings and multi-line data split at every byte offset',
    async ({ ending }) => {
      const body = encoder.encode(
        lines(`: keep-alive\n\nevent: ping\ndata:\n\n${multilineEvent(paymentRequired)}`, ending),
      )
      await expectLegacyIds(bytewise(body), [challenge.id])
      for (let offset = 0; offset <= body.length; offset++)
        await expectLegacyIds(cut(body, [offset]), [challenge.id])
    },
  )

  test('does not end an event at a CR whose LF arrives in the next chunk', async () => {
    const body = encoder.encode(lines(multilineEvent(paymentRequired), '\r\n'))
    const offsets = [...body.keys()].filter((offset) => body[offset] === 0x0a)
    for (const offset of offsets) await expectLegacyIds(cut(body, [offset]), [challenge.id])
    await expectLegacyIds(cut(body, offsets), [challenge.id])
  })

  test('strips a UTF-8 byte order mark split across chunks', async () => {
    const body = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode(`data: ${JSON.stringify(paymentRequired)}\n\n`),
    ])
    for (const offsets of [[], [1], [2], [3], [1, 2], [1, 2, 3]])
      await expectLegacyIds(cut(body, offsets), [challenge.id])
  })

  test.each([
    { body: `data: ${JSON.stringify(paymentRequired)}`, name: 'no line break' },
    { body: `data: ${JSON.stringify(paymentRequired)}\n`, name: 'one LF' },
    { body: `data: ${JSON.stringify(paymentRequired)}\r\n`, name: 'one CRLF' },
    { body: `data: ${JSON.stringify(paymentRequired)}\r`, name: 'one CR' },
    {
      body: `: comment\n\nevent: message\ndata: ${JSON.stringify(paymentRequired)}`,
      name: 'events before it',
    },
  ])('ignores a final event the body never ends ($name)', async ({ body }) => {
    const bytes = encoder.encode(body)
    await expectLegacyIds([bytes], [])
    await expectLegacyIds(bytewise(bytes), [])
  })

  test.each([
    { body: `data: ${JSON.stringify(paymentRequired)}\n\r`, name: 'LF CR' },
    { body: `data: ${JSON.stringify(paymentRequired)}\r\r`, name: 'CR CR' },
    { body: `data: ${JSON.stringify(paymentRequired)}\r\n\r\n`, name: 'CRLF CRLF' },
  ])('dispatches a final event ended by $name', async ({ body }) => {
    const bytes = encoder.encode(body)
    await expectLegacyIds([bytes], [challenge.id])
    await expectLegacyIds(bytewise(bytes), [challenge.id])
  })

  test('ignores a body truncated inside a multi-byte character', async () => {
    const body = encoder.encode(`data: ${JSON.stringify(unicodePaymentRequired)}\n\n`)
    const truncated = body.subarray(0, body.indexOf(0xf0) + 2)
    await expectLegacyIds([truncated], [])
  })

  test('reads past invalid UTF-8 in a comment', async () => {
    const body = new Uint8Array([
      ...encoder.encode(': '),
      0xff,
      0xfe,
      0xc3,
      ...encoder.encode(`\n\n${sseEvent(paymentRequired)}`),
    ])
    await expectLegacyIds([body], [challenge.id])
    await expectLegacyIds(bytewise(body), [challenge.id])
  })

  test('reads NUL characters in data as data', async () => {
    const body = encoder.encode(`data: \0\n\n${sseEvent(paymentRequired)}`)
    await expectLegacyIds([body], [])
    const nulField = encoder.encode(`data\0: x\n${sseEvent(paymentRequired)}`)
    await expectLegacyIds([nulField], [challenge.id])
  })

  test.each([
    { contentType: 'text/event-stream; charset=utf-8', expected: [challenge.id] },
    { contentType: 'Text/Event-Stream', expected: [challenge.id] },
    { contentType: 'text/plain', expected: [] },
    { contentType: 'application/octet-stream', expected: [] },
  ])('reads SSE by content type ($contentType)', async ({ contentType, expected }) => {
    const challenges = await challengesOf([encoder.encode(sseEvent(paymentRequired))], contentType)
    expect(challenges.map((entry) => entry.id)).toEqual(expected)
  })

  test('matches the eventsource-parser implementation on random MCP streams', async () => {
    const payment = JSON.stringify(paymentRequired)
    const block = fc.constantFrom(
      `event: message\ndata: ${payment}\n\n`,
      `data: ${payment}\n\n`,
      `event:\ndata: ${payment}\n\n`,
      `event: other\ndata: ${payment}\n\n`,
      `event: Message\ndata: ${payment}\n\n`,
      multilineEvent(paymentRequired),
      sseEvent(unicodePaymentRequired),
      sseEvent({ ...paymentRequired, id: 2 }),
      sseEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }),
      sseEvent({ jsonrpc: '2.0', id: 1, result: {} }),
      ': keep-alive\n\n',
      'retry: 10\nid: 1\n\n',
      'event: ping\ndata:\n\n',
      'event: ping\n\n',
      'data\n\n',
      'data: {\n\n',
      'event: message\n',
      `data: ${payment.slice(0, 40)}\n\n`,
    )
    const body = fc
      .record({
        blocks: fc.array(block, { maxLength: 5 }),
        bom: fc.boolean(),
        ending: fc.constantFrom('\n', '\r\n', '\r'),
        truncate: fc.nat(),
      })
      .map(({ blocks, bom, ending, truncate }) => {
        const bytes = encoder.encode(lines(blocks.join(''), ending))
        const end = truncate % 4 === 0 ? bytes.length - (truncate % 7) : bytes.length
        return new Uint8Array([
          ...(bom ? [0xef, 0xbb, 0xbf] : []),
          ...bytes.subarray(0, Math.max(end, 0)),
        ])
      })
    const chunked = body.chain((bytes) =>
      fc
        .array(fc.integer({ min: 0, max: bytes.length }), { maxLength: 10 })
        .map((offsets) => cut(bytes, offsets)),
    )
    await fc.assert(
      fc.asyncProperty(chunked, async (chunks) => {
        expect((await challengesOf(chunks)).map((entry) => entry.id)).toEqual(
          await legacyChallengeIds(chunks),
        )
      }),
      { numRuns: 500 },
    )
  })
})

describe('mcp over a real HTTP server', () => {
  const live = liveChallenge()
  const unicodeLive = liveChallenge(unicodeDescription)
  const payment = {
    ...paymentRequired,
    error: { ...paymentRequired.error, data: { challenges: [live] } },
  }
  const unicodePayment = {
    ...unicodePaymentRequired,
    error: { ...unicodePaymentRequired.error, data: { challenges: [unicodeLive] } },
  }
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: {} }
  const resultMetadata = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: 'Payment Required' }],
      isError: true,
      _meta: { [Mcp.paymentRequiredMetaKey]: { httpStatus: 402, challenges: [live] } },
    },
  }
  const paid = (text: string) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] },
  })
  const bom = String.fromCharCode(0xfeff)

  const scenarios: { body: string; challengeId?: string; name: string }[] = [
    { name: 'a -32042 message event', body: sseEvent(payment), challengeId: live.id },
    {
      name: 'keep-alives, retry and id before the -32042 event',
      body: `: keep-alive\n\n:\n\nretry: 1000\nid: 7\n\n${sseEvent(payment)}`,
      challengeId: live.id,
    },
    {
      name: 'events after the -32042 event',
      body: `${sseEvent(payment)}${sseEvent(notification)}${sseEvent(paid('late'))}: bye\n\n`,
      challengeId: live.id,
    },
    {
      name: 'events without data before the -32042 event',
      body: `event: ping\n\nevent: other\ndata:\n\ndata\n\n${sseEvent(payment)}`,
      challengeId: live.id,
    },
    { name: 'a -32042 event without a type', body: sseEvent(payment, ''), challengeId: live.id },
    {
      name: 'a -32042 event with an empty type',
      body: `event:\ndata: ${JSON.stringify(payment)}\n\n`,
      challengeId: live.id,
    },
    {
      name: 'CRLF line endings and multi-line data',
      body: lines(`: hi\n\n${multilineEvent(payment)}`, '\r\n'),
      challengeId: live.id,
    },
    { name: 'CR line endings', body: lines(sseEvent(payment), '\r'), challengeId: live.id },
    {
      name: 'a byte order mark and Unicode',
      body: `${bom}data: ${JSON.stringify(unicodePayment)}\n\n`,
      challengeId: unicodeLive.id,
    },
    {
      name: 'payment-required result metadata',
      body: sseEvent(resultMetadata),
      challengeId: live.id,
    },
    { name: 'a non-message event first', body: `event: other\ndata: x\n\n${sseEvent(payment)}` },
    { name: 'a differently cased message type', body: sseEvent(payment, 'Message') },
    { name: 'a notification first', body: sseEvent(notification) + sseEvent(payment) },
    { name: 'invalid JSON first', body: `data: {\n\n${sseEvent(payment)}` },
    { name: 'a -32042 event for another request', body: sseEvent({ ...payment, id: 2 }) },
    { name: 'a -32042 event the body never ends', body: `data: ${JSON.stringify(payment)}\n` },
    {
      name: 'a -32042 message split across two events',
      body: `data: ${JSON.stringify(payment).slice(0, 50)}\n\ndata: ${JSON.stringify(payment).slice(50)}\n\n`,
    },
    { name: 'a successful result', body: sseEvent(paid('free')) },
  ]

  const deliveries: { name: string; chunks: (bytes: Uint8Array) => Uint8Array[] }[] = [
    { name: 'whole', chunks: (bytes) => [bytes] },
    { name: 'one byte at a time', chunks: bytewise },
    { name: 'random chunks (seed 1)', chunks: (bytes) => randomChunks(bytes, 1) },
    { name: 'random chunks (seed 2)', chunks: (bytes) => randomChunks(bytes, 2) },
  ]

  const cases = scenarios.flatMap((scenario) =>
    deliveries.map((delivery) => ({
      ...scenario,
      delivery,
      label: `${scenario.name}, ${delivery.name}`,
    })),
  )

  test.each(cases)('$label', async ({ body, challengeId, delivery }) => {
    const bytes = encoder.encode(body)
    const chunks = delivery.chunks(bytes)
    const messages: Mcp.Request[] = []
    const releases: (() => void)[] = []
    let holdTimedOut = false
    const server = await Http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const message = JSON.parse(raw) as Mcp.Request
      messages.push(message)
      res.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' })
      res.flushHeaders()
      if (message.params?._meta?.[Mcp.credentialMetaKey]) {
        for (const release of releases) release()
        res.end(sseEvent(paid('paid')))
        return
      }
      res.socket?.setNoDelay(true)
      for (const chunk of chunks) {
        if (res.destroyed) return
        res.write(chunk)
        await new Promise((resolve) => setImmediate(resolve))
      }
      // A live MCP stream stays open: the client must retry without waiting for it to end.
      // It ends after a second anyway, so a client that waits fails fast instead of hanging.
      if (challengeId)
        await new Promise<void>((resolve) => {
          releases.push(resolve)
          res.on('close', resolve)
          setTimeout(() => {
            holdTimedOut = true
            resolve()
          }, 1_000).unref()
        })
      res.end()
    })
    try {
      const createCredential = vi.fn(async ({ challenge }: { challenge: Challenge.Challenge }) =>
        Credential.serialize({
          challenge,
          payload: { signature: '0xsignature', type: 'transaction' },
        }),
      )
      const mppx = Mppx.create({
        methods: [Method.toClient(Methods.charge, { createCredential })],
        polyfill: false,
      })
      const response = await mppx.fetch(server.url, {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'premium' },
        }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        method: 'POST',
      })
      // `fetch` resolved while the first stream was still open; end it so a regression fails fast.
      for (const release of releases) release()
      const received = new Uint8Array(await response.arrayBuffer())

      expect(await legacyChallengeIds(chunks)).toEqual(challengeId ? [challengeId] : [])
      if (challengeId) {
        expect(createCredential).toHaveBeenCalledTimes(1)
        expect(holdTimedOut).toBe(false)
        expect(messages).toHaveLength(2)
        expect(messages[1]!.params?._meta?.[Mcp.credentialMetaKey]?.challenge.id).toBe(challengeId)
        expect(decoder.decode(received)).toBe(sseEvent(paid('paid')))
      } else {
        expect(createCredential).not.toHaveBeenCalled()
        expect(messages).toHaveLength(1)
        expect(received).toEqual(bytes)
      }
    } finally {
      server.close()
    }
  })
})
