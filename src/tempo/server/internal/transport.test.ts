import { Challenge, Credential } from 'mppx'
import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import * as Store from '../../../Store.js'
import * as ChannelStore from '../../stream/ChannelStore.js'
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
    escrowContract: '0x542831e3E4Ace07559b7C8787395f4Fb99F70787' as Address,
    deposit: balance,
    settledOnChain: 0n,
    highestVoucherAmount: balance,
    highestVoucher: null,
    spent: 0n,
    units: 0,
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

  test('getCredential captures SSE context in contextMap', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })

    const request = makeAuthorizedRequest()
    transport.getCredential(request)

    async function* gen() {
      yield 'test'
    }

    const response = transport.respondReceipt({
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondChallenge delegates to base http transport', () => {
    const store = memoryStore()
    const transport = sse({ store })
    const challenge = makeChallenge()

    const response = transport.respondChallenge({
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

    transport.getCredential(makeAuthorizedRequest())

    async function* gen() {
      yield 'hello'
      yield 'world'
    }

    const response = transport.respondReceipt({
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondReceipt with AsyncGeneratorFunction passes stream controller', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })

    transport.getCredential(makeAuthorizedRequest())

    const response = transport.respondReceipt({
      receipt: makeReceipt(),
      response: async function* (stream) {
        await stream.charge()
        yield 'hello'
      },
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondReceipt with upstream SSE Response auto-detects and iterates', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })

    transport.getCredential(makeAuthorizedRequest())

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
      receipt: makeReceipt(),
      response: upstream,
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  test('respondReceipt with plain Response delegates to base http transport', () => {
    const store = memoryStore()
    const transport = sse({ store })
    const receipt = makeReceipt()

    const plainResponse = new Response('ok', {
      headers: { 'Content-Type': 'application/json' },
    })

    const response = transport.respondReceipt({
      receipt,
      response: plainResponse,
      challengeId,
    })
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('respondReceipt cleans up contextMap after use', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })

    transport.getCredential(makeAuthorizedRequest())

    async function* gen() {
      yield 'first'
    }

    transport.respondReceipt({
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
    })

    async function* gen2() {
      yield 'second'
    }

    expect(() =>
      transport.respondReceipt({
        receipt: makeReceipt(),
        response: gen2(),
        challengeId,
      }),
    ).toThrow('No SSE context available')
  })

  test('respondReceipt throws when no SSE context available', () => {
    const store = memoryStore()
    const transport = sse({ store })

    async function* gen() {
      yield 'hello'
    }

    expect(() =>
      transport.respondReceipt({
        receipt: makeReceipt(),
        response: gen(),
        challengeId,
      }),
    ).toThrow('No SSE context available')
  })

  test('poll: true strips waitForUpdate from store', async () => {
    const store = memoryStore()
    ;(store as any).waitForUpdate = async () => {}
    await seedChannel(store, 10000000n)

    const transport = sse({ store, poll: true })

    transport.getCredential(makeAuthorizedRequest())

    async function* gen() {
      yield 'test'
    }

    const response = transport.respondReceipt({
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(transport.name).toBe('sse')
  })
})
