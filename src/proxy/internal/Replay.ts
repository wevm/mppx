import { Base64, Bytes, Hash } from 'ox'

import * as Credential from '../../Credential.js'
import type * as Store from '../../Store.js'

/** Options for replaying paid proxy deliveries. */
export type Options = {
  /**
   * Upstream attempts per credential, including the first, before a retry gets `502`.
   * A retry after a failed delivery (an upstream error, a 5xx or a body that broke
   * off) sends the paid request upstream again without charging, so a
   * non-idempotent upstream may run the operation twice; set `1` to only ever
   * replay a recorded response. @default 3
   */
  maxAttempts?: number | undefined
  /** Largest response body, in bytes, kept for replay. Larger or streamed bodies are delivered but not kept. @default 1_048_576 */
  maxBodySize?: number | undefined
  /** Largest request body, in bytes, a paid request may carry; larger ones get `413`. @default 1_048_576 */
  maxRequestBodySize?: number | undefined
  /** `Retry-After` seconds returned while a delivery is still in flight. @default 5 */
  retryAfter?: number | undefined
  /** Atomic store shared by every proxy instance that may receive a retry. */
  store: Store.AtomicStore
  /**
   * How long to wait for the upstream to start responding, and how long its outcome is kept after it is
   * recorded, in milliseconds. Expired records are removed when they are next
   * looked up, as with mppx's replay markers; give the backing store its own
   * key expiry to reclaim records nobody retries. @default 900_000
   */
  ttl?: number | undefined
  /** Keeps background work alive after the response returns, such as Cloudflare's `ctx.waitUntil`. */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined
}

/** Replay options with defaults applied. */
export type Resolved = {
  maxAttempts: number
  maxBodySize: number
  maxRequestBodySize: number
  retryAfter: number
  store: Store.AtomicStore
  ttl: number
  waitUntil: ((promise: Promise<unknown>) => void) | undefined
}

/** A delivery record, keyed by credential and request. */
export type Record =
  | {
      attempts: number
      expires: number
      receipt: string | null
      requestHeaders: [string, string][]
      status: 'pending'
    }
  | {
      attempts: number
      expires: number
      receipt: string | null
      requestHeaders: [string, string][]
      status: 'failed'
    }
  | { expires: number; status: 'delivered' }
  | {
      body: string
      expires: number
      headers: [string, string][]
      responseStatus: number
      status: 'complete'
      statusText: string
    }

const keyPrefix = 'mppx:proxy:replay:'

/** Applies defaults to replay options. */
export function resolve(options: Options): Resolved {
  const ttl = options.ttl ?? 900_000
  // AbortSignal.timeout needs a positive integer that fits a 32-bit timer.
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 2_147_483_647)
    throw new RangeError(
      'replay.ttl must be a positive integer number of milliseconds up to 2147483647.',
    )
  return {
    maxAttempts: options.maxAttempts ?? 3,
    maxBodySize: options.maxBodySize ?? 1_048_576,
    maxRequestBodySize: options.maxRequestBodySize ?? 1_048_576,
    retryAfter: options.retryAfter ?? 5,
    store: options.store,
    ttl,
    waitUntil: options.waitUntil,
  }
}

/** Returns the request's Payment credential header value, if it carries one. */
export function credentialOf(
  request: Request,
  headerNames: readonly string[] = ['authorization'],
): string | undefined {
  // Only the headers the route's payment handler verifies can name a replay.
  for (const name of headerNames) {
    const header = request.headers.get(name)
    const payment = header ? Credential.extractPaymentScheme(header) : null
    if (payment) return payment
  }
  return undefined
}

/** Reads a request body, or returns null when it is larger than maxRequestBodySize. */
export async function readBody(request: Request, maxRequestBodySize: number) {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxRequestBodySize) return null
  if (!request.body) return new Uint8Array()
  return keep(request.body, maxRequestBodySize)
}

/** Derives the replay key from the credential and the exact request (origin, path, query, method, body) it paid for. */
export function key(parameters: {
  body: Uint8Array
  credential: string
  method: string
  target: string
}): string {
  const bodyHash = Hash.sha256(parameters.body, { as: 'Hex' })
  const input = JSON.stringify([
    parameters.credential,
    parameters.method.toUpperCase(),
    parameters.target,
    bodyHash,
  ])
  return keyPrefix + Hash.sha256(Bytes.fromString(input), { as: 'Hex' }).slice(2)
}

/** Rebuilds a request around an already-read body, optionally with another abort signal. */
export function withBody(
  request: Request,
  body: Uint8Array,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Request {
  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new globalThis.Request(request.url, {
    // An empty body stays absent, as on the original request: payment
    // transports tell management requests apart by a missing body.
    body: hasBody && body.byteLength > 0 ? (body as BodyInit) : null,
    headers: headers ?? request.headers,
    method: request.method,
    redirect: request.redirect,
    signal: signal ?? request.signal,
  })
}

/** What a request with a known credential should do. */
export type Lookup =
  | { type: 'none' }
  | { response: Response; type: 'respond' }
  | { attempts: number; receipt: string | null; requestHeaders: [string, string][]; type: 'retry' }

/** Looks up a delivery and, for a failed one, claims the next upstream attempt. */
export async function lookup(replay: Resolved, replayKey: string): Promise<Lookup> {
  const now = Date.now()
  // Read first: only a failed delivery needs an atomic claim, so unknown
  // credentials never cause a store write.
  const seen = (await replay.store.get(replayKey)) as Record | null
  if (!seen) return { type: 'none' }
  if (seen.expires > now && seen.status !== 'failed')
    return { response: respond(replay, seen), type: 'respond' }
  const result = await replay.store.update(
    replayKey,
    (current): Store.Change<unknown, Lookup | Record> => {
      const record = current as Record | null
      if (!record) return { op: 'noop', result: { type: 'none' } }
      if (record.expires <= now) return { op: 'delete', result: { type: 'none' } }
      if (record.status !== 'failed' || record.attempts >= replay.maxAttempts)
        return { op: 'noop', result: record }
      const attempts = record.attempts + 1
      return {
        op: 'set',
        value: { ...record, attempts, status: 'pending' } satisfies Record,
        result: {
          attempts,
          receipt: record.receipt,
          requestHeaders: record.requestHeaders,
          type: 'retry',
        },
      }
    },
  )
  if ('type' in result) return result
  return { response: respond(replay, result), type: 'respond' }
}

/** Builds the response for a recorded delivery that is not retried. */
function respond(replay: Resolved, record: Record): Response {
  if (record.status === 'complete') return fromRecord(record)
  if (record.status === 'delivered')
    return Response.json(
      { error: 'The paid response was delivered and is not stored for replay.' },
      { status: 410 },
    )
  if (record.status === 'pending')
    return new Response(null, {
      headers: { 'Retry-After': String(replay.retryAfter) },
      status: 202,
    })
  return withReceiptHeader(
    Response.json({ error: 'The paid upstream request failed.' }, { status: 502 }),
    record.receipt,
  )
}

/** Runs a paid upstream delivery detached from the client and records its outcome. */
export async function deliver(parameters: {
  applyReceipt: (response: Response) => Response | Promise<Response>
  attempts: number
  replay: Resolved
  replayKey: string
  /** The upstream headers of the paid request; a retried delivery reuses them. */
  requestHeaders: [string, string][]
  run: (signal: AbortSignal) => Promise<Response>
}): Promise<Response> {
  const { applyReceipt, attempts, replay, replayKey, requestHeaders } = parameters
  // Outcomes are kept for ttl from when they are recorded, not from the start.
  const expires = () => Date.now() + replay.ttl
  await record(replay, replayKey, {
    attempts,
    expires: expires(),
    receipt: null,
    requestHeaders,
    status: 'pending',
  } satisfies Record)

  let response: Response
  try {
    // ttl bounds the wait for the upstream to respond, not how long its body
    // streams: a paid stream keeps going once it has started.
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('Replay ttl elapsed.', 'TimeoutError')),
      replay.ttl,
    )
    let upstream: Response
    try {
      upstream = await parameters.run(controller.signal)
    } finally {
      clearTimeout(timer)
    }
    response = await applyReceipt(upstream)
  } catch {
    const failed = await applyReceipt(
      Response.json({ error: 'The paid upstream request failed.' }, { status: 502 }),
    )
    await recordFailure(
      replay,
      replayKey,
      attempts,
      requestHeaders,
      expires(),
      failed.headers.get('Payment-Receipt'),
    )
    return failed
  }

  const receipt = response.headers.get('Payment-Receipt')
  if (response.status >= 500) {
    await recordFailure(replay, replayKey, attempts, requestHeaders, expires(), receipt)
    return response
  }

  if (!response.body) {
    await record(replay, replayKey, toRecord(response, new Uint8Array(), expires()))
    return response
  }

  if (/^text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
    await record(replay, replayKey, { expires: expires(), status: 'delivered' } satisfies Record)
    return response
  }

  // Keep a copy while the client reads the other branch, so a client that
  // disconnects mid-body can still collect the response on retry.
  const [client, kept] = response.body.tee()
  const stored = keep(kept, replay.maxBodySize)
    .then(
      (body) =>
        replay.store.put(
          replayKey,
          body
            ? toRecord(response, body, expires())
            : ({ expires: expires(), status: 'delivered' } satisfies Record),
        ),
      // The upstream body broke off: let the payer retry the delivery.
      () => recordFailure(replay, replayKey, attempts, requestHeaders, expires(), receipt),
    )
    // A failed background write leaves the record pending until it expires.
    .catch(() => {})
  replay.waitUntil?.(stored)
  return new Response(client, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

/** Reads a body branch up to maxBodySize, or returns null when it is larger. */
async function keep(stream: ReadableStream<Uint8Array>, maxBodySize: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBodySize) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Writes a replay record without letting a store failure break the paid
 * delivery: the payer still gets the upstream response, only replay is lost.
 */
async function record(replay: Resolved, replayKey: string, value: Record): Promise<void> {
  try {
    await replay.store.put(replayKey, value)
  } catch {}
}

async function recordFailure(
  replay: Resolved,
  replayKey: string,
  attempts: number,
  requestHeaders: [string, string][],
  expires: number,
  receipt: string | null,
) {
  await record(replay, replayKey, {
    attempts,
    expires,
    receipt,
    requestHeaders,
    status: 'failed',
  } satisfies Record)
}

/** Adds a stored receipt to a response built for a retried delivery. */
export function withReceiptHeader(response: Response, receipt: string | null): Response {
  if (!receipt) return response
  const headers = new Headers(response.headers)
  headers.set('Payment-Receipt', receipt)
  headers.set('Cache-Control', withPrivateCacheControl(headers.get('Cache-Control')))
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function withPrivateCacheControl(value: string | null): string {
  if (!value) return 'private'
  const directives = value.split(',').map((directive) => directive.trim().toLowerCase())
  if (directives.includes('private')) return value
  return `${value}, private`
}

function toRecord(response: Response, body: Uint8Array, expires: number): Record {
  return {
    body: Base64.fromBytes(body),
    expires,
    headers: [...response.headers.entries()],
    responseStatus: response.status,
    status: 'complete',
    statusText: response.statusText,
  }
}

function fromRecord(record: Extract<Record, { status: 'complete' }>): Response {
  const nullBody = [101, 204, 205, 304].includes(record.responseStatus)
  return new Response(nullBody ? null : (Base64.toBytes(record.body) as BodyInit), {
    headers: record.headers,
    status: record.responseStatus,
    statusText: record.statusText,
  })
}
