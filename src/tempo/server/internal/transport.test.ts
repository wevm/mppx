import { Challenge, Credential } from 'mppx'
import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import { chainId, escrowContract as escrowContractDefaults } from '../../internal/defaults.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import { sse } from './transport.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'challenge-1'

function memoryStore() {
  return ChannelStore.fromStore(Store.memory())
}

function seedChannel(
  storage: ChannelStore.ChannelStore,
  balance: bigint,
): Promise<ChannelStore.State | null> {
  return storage.updateChannel(channelId, () => ({
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    chainId: 42431,
    escrowContract: escrowContractDefaults[chainId.testnet] as Address,
    deposit: balance,
    settledOnChain: 0n,
    highestVoucherAmount: balance,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    closeRequestedAt: 0n,
    finalized: false,
    createdAt: new Date().toISOString(),
  }))
}

function makeChallenge() {
  return Challenge.from({
    id: challengeId,
    realm: 'test.example.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
    },
  })
}

function makeCredential() {
  const challenge = makeChallenge()
  return Credential.from({
    challenge,
    payload: {
      action: 'voucher',
      channelId,
      cumulativeAmount: '1000000',
      signature: '0xdeadbeef',
    },
  })
}

function makeAuthorizedRequest(): Request {
  const credential = makeCredential()
  const header = Credential.serialize(credential)
  return new Request('https://test.example.com/session', {
    headers: { Authorization: header },
  })
}

function makeReceipt() {
  return {
    method: 'tempo',
    status: 'success' as const,
    timestamp: new Date().toISOString(),
    reference: channelId,
  }
}

function makeRespondContext(
  input: Request,
  options: {
    credential?: Credential.Credential
    receipt?: ReturnType<typeof makeReceipt>
  } = {},
) {
  const credential = options.credential ?? makeCredential()
  const receipt = options.receipt ?? makeReceipt()
  return {
    coreBinding: {
      amount: String(credential.challenge.request.amount),
      currency: String(credential.challenge.request.currency),
      recipient: String(credential.challenge.request.recipient),
    },
    envelope: {
      capturedRequest: {
        headers: new Headers(input.headers),
        method: input.method,
        url: new URL(input.url),
      },
      challenge: credential.challenge,
      credential,
    },
    methodBinding: {},
    receipt,
    request: credential.challenge.request,
  } as const
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

describe('sse transport', () => {
  test('getCredential returns null when no Authorization header', () => {
    const store = memoryStore()
    const transport = sse({ store })
    const request = new Request('https://test.example.com/session')
    expect(transport.getCredential(request)).toBeNull()
  })

  test('getCredential returns credential from Authorization header', () => {
    const store = memoryStore()
    const transport = sse({ store })
    const request = makeAuthorizedRequest()
    const credential = transport.getCredential(request)
    expect(credential).not.toBeNull()
    expect(credential!.challenge.id).toBe(challengeId)
    expect((credential!.payload as any).channelId).toBe(channelId)
  })

  test('respondReceipt derives SSE context from the verified credential', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })

    const request = new Request('https://test.example.com/session')

    async function* gen() {
      yield 'test'
    }

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: gen(),
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondChallenge delegates to base http transport', async () => {
    const store = memoryStore()
    const transport = sse({ store })
    const challenge = makeChallenge()

    const response = await transport.respondChallenge({
      challenge,
      input: new Request('https://test.example.com/session'),
    })
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')
  })

  test('respondReceipt with AsyncIterable produces SSE response', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    async function* gen() {
      yield 'hello'
      yield 'world'
    }

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: gen(),
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const body = await readResponseText(response)
    const receiptRaw = body.split('event: payment-receipt\ndata: ')[1]?.split('\n\n')[0]
    const terminalReceipt = JSON.parse(receiptRaw!)

    expect(response.headers.get('Payment-Receipt')).toBeNull()
    expect(body).toContain('event: message\ndata: hello\n\n')
    expect(body).toContain('event: message\ndata: world\n\n')
    expect(body).toContain('event: payment-receipt\n')
    expect(terminalReceipt.challengeId).toBe(challengeId)
    expect(terminalReceipt.channelId).toBe(channelId)
    expect(terminalReceipt.units).toBe(2)
    expect(terminalReceipt.spent).toBe('2000000')
  })

  test('respondReceipt with AsyncGeneratorFunction passes stream controller', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: async function* (stream) {
        await stream.charge()
        yield 'hello'
      },
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondReceipt with upstream SSE Response auto-detects and iterates', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const encoder = new TextEncoder()
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: message\ndata: chunk1\n\n'))
          controller.enqueue(encoder.encode('event: message\ndata: chunk2\n\n'))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    )

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: upstream,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const body = await readResponseText(response)
    expect(response.headers.get('Payment-Receipt')).toBeNull()
    expect(body).toContain('event: message\ndata: chunk1\n\n')
    expect(body).toContain('event: message\ndata: chunk2\n\n')
    expect(body).toContain('event: payment-receipt\n')
  })

  test('respondReceipt with plain Response delegates to base http transport', () => {
    const store = memoryStore()
    const transport = sse({ store })
    const receipt = makeReceipt()

    const plainResponse = new Response('ok', {
      headers: { 'Content-Type': 'application/json' },
    })
    const input = new Request('https://test.example.com/session')

    const response = transport.respondReceipt({
      context: makeRespondContext(input, { receipt }),
      input,
      response: plainResponse,
    })
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('respondReceipt no longer depends on prior getCredential side effects', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    async function* gen() {
      yield 'first'
    }

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: gen(),
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondReceipt throws when no SSE context available', () => {
    const store = memoryStore()
    const transport = sse({ store })

    async function* gen() {
      yield 'hello'
    }

    const credential = Credential.from({
      challenge: makeChallenge(),
      payload: { signature: '0xabc123', type: 'transaction' },
    })

    expect(() =>
      transport.respondReceipt({
        context: makeRespondContext(new Request('https://test.example.com/session'), {
          credential,
        }),
        input: new Request('https://test.example.com/session'),
        response: gen(),
      }),
    ).toThrow('No SSE context available')
  })

  test('respondReceipt with non-SSE upstream Response still deducts from channel', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const plainResponse = new Response(JSON.stringify({ content: 'hello' }), {
      headers: { 'Content-Type': 'application/json' },
    })

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: plainResponse,
    })

    const body = await response.text()

    const channel = await store.getChannel(channelId)
    expect(channel!.spent).toBe(1000000n)
    expect(channel!.units).toBe(1)

    expect(JSON.parse(body)).toEqual({ content: 'hello' })
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('respondReceipt with 204 management response keeps null body and receipt', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const managementResponse = new Response(null, { status: 204 })
    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: managementResponse,
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    const channel = await store.getChannel(channelId)
    expect(channel!.spent).toBe(0n)
    expect(channel!.units).toBe(0)
  })

  test('poll: true strips waitForUpdate from store', async () => {
    const store = memoryStore()
    ;(store as any).waitForUpdate = async () => {}
    await seedChannel(store, 10000000n)

    const transport = sse({ store, poll: true })
    const request = makeAuthorizedRequest()

    async function* gen() {
      yield 'test'
    }

    const response = transport.respondReceipt({
      context: makeRespondContext(request),
      input: request,
      response: gen(),
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(transport.name).toBe('sse')
  })
})
