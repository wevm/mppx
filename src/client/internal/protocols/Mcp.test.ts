import { Challenge, Mcp } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vp/test'

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
