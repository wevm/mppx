import { createParser } from 'eventsource-parser'

import * as Challenge from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Mcp from '../../../Mcp.js'
import type { Protocol } from './Protocol.js'
import { paymentRequiredStatus } from './Shared.js'

/** Returns the JSON-RPC request id — only requests can receive a `-32042` response. */
function jsonRpcRequestId(body: unknown): number | string | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const message = JSON.parse(body)
    const id = message?.id
    if (message?.jsonrpc !== '2.0' || typeof message?.method !== 'string') return undefined
    return typeof id === 'string' || typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}

const responseCache = new WeakMap<Response, Promise<Mcp.Response | undefined>>()

function mcpHttpRequestId(request?: RequestInit): number | string | undefined {
  const id = jsonRpcRequestId(request?.body)
  if (id === undefined) return undefined
  const headers = new Headers(request?.headers)
  if (headers.has('mcp-method')) return id
  const accept = headers.get('accept')?.toLowerCase() ?? ''
  return accept.includes('application/json') && accept.includes('text/event-stream')
    ? id
    : undefined
}

function parseMessage(value: unknown): Mcp.Response | undefined {
  if (!value || typeof value !== 'object') return undefined
  const message = value as {
    error?: { code?: unknown; message?: unknown }
    id?: unknown
    jsonrpc?: unknown
    result?: unknown
  }
  const id = message.id
  if (message.jsonrpc !== '2.0') return undefined
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return undefined
  const hasError = 'error' in message
  const hasResult = 'result' in message
  if (hasError === hasResult) return undefined
  if (hasError)
    return Number.isInteger(message.error?.code) && typeof message.error?.message === 'string'
      ? (value as Mcp.Response)
      : undefined
  return id !== undefined && typeof message.result === 'object'
    ? (value as Mcp.Response)
    : undefined
}

function paymentRequiredChallenges(
  message: Mcp.Response | undefined,
  id: number | string,
): Challenge.Challenge[] {
  if (
    !message ||
    message.id !== id ||
    !('error' in message) ||
    message.error?.code !== Mcp.paymentRequiredCode
  )
    return []
  const challenges = message.error?.data?.challenges
  if (!Array.isArray(challenges) || challenges.length === 0) return []
  const parsed: Challenge.Challenge[] = []
  for (const challenge of challenges) {
    const result = Challenge.Schema.safeParse(challenge)
    if (!result.success) return []
    parsed.push(result.data as Challenge.Challenge)
  }
  return parsed
}

async function parseSseJsonRpcResponse(response: Response): Promise<Mcp.Response | undefined> {
  const reader = response.clone().body?.getReader()
  if (!reader) return undefined

  const decoder = new TextDecoder()
  let dataEventSeen = false
  let message: Mcp.Response | undefined
  const parser = createParser({
    onEvent(event) {
      if (dataEventSeen || !event.data) return
      dataEventSeen = true
      if (event.event && event.event !== 'message') return
      try {
        message = parseMessage(JSON.parse(event.data))
      } catch {}
    },
  })

  try {
    for (;;) {
      if (dataEventSeen) return message
      const { done, value } = await reader.read()
      if (done) {
        parser.feed(decoder.decode())
        parser.reset({ consume: true })
        return message
      }
      parser.feed(decoder.decode(value, { stream: true }))
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}

/** Reads a cloned HTTP body into the first JSON-RPC response message, if any. */
function parseJsonRpcResponse(response: Response): Promise<Mcp.Response | undefined> {
  const cached = responseCache.get(response)
  if (cached) return cached
  const promise = (async (): Promise<Mcp.Response | undefined> => {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json'))
      return response
        .clone()
        .json()
        .then(parseMessage)
        .catch(() => undefined)
    if (contentType.includes('text/event-stream')) return parseSseJsonRpcResponse(response)
    return undefined
  })()
  responseCache.set(response, promise)
  return promise
}

/**
 * MCP-over-HTTP — remote MCP rides Streamable HTTP, so its challenge is a JSON-RPC `-32042` error
 * in a normal 200 body (often `text/event-stream`), and the credential rides back in `_meta`.
 */
export function mcp(): Protocol {
  return {
    getChallenges(response, request) {
      // The 402 schemes own status 402; MCP challenges arrive in a normal 200 body.
      const id = mcpHttpRequestId(request)
      if (response.status === paymentRequiredStatus || id === undefined) return []
      return parseJsonRpcResponse(response).then((message) =>
        paymentRequiredChallenges(message, id),
      )
    },
    setCredential(request, credential) {
      const message = JSON.parse(request.body as string) as Mcp.Request
      const parsed = Credential.deserialize(credential)
      return {
        ...request,
        body: JSON.stringify({
          ...message,
          params: {
            ...message.params,
            ['_meta']: { ...message.params?.['_meta'], [Mcp.credentialMetaKey]: parsed },
          },
        }),
      }
    },
  }
}
