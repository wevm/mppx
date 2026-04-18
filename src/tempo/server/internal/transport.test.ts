import { Challenge, Credential } from 'mppx'
import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import { chainId, escrowContract as escrowContractDefaults } from '../../internal/defaults.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import { deserializeSessionReceipt } from '../../session/Receipt.js'
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

function makeManagementRequest(action: 'close' | 'topUp' = 'close'): Request {
  const credential = Credential.from({
    challenge: makeChallenge(),
    payload:
      action === 'close'
        ? {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '10000000',
            signature: '0xdeadbeef',
          }
        : {
            action: 'topUp' as const,
            channelId,
            type: 'transaction' as const,
            transaction: '0xdeadbeef',
            additionalDeposit: '1000000',
          },
  })
  const header = Credential.serialize(credential)
  return new Request('https://test.example.com/session', {
    method: 'POST',
    headers: { Authorization: header },
  })
}

type ReceiptOverrides = Partial<{
  acceptedCumulative: string
  spent: string
  units: number
}>

function makeReceipt(overrides: ReceiptOverrides = {}) {
  return {
    method: 'tempo',
    intent: 'session' as const,
    status: 'success' as const,
    timestamp: new Date().toISOString(),
    reference: channelId,
    challengeId,
    channelId,
    acceptedCumulative: '10000000',
    spent: '0',
    units: 0,
    ...overrides,
  }
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

    const credential = makeCredential()

    async function* gen() {
      yield 'test'
    }

    const response = transport.respondReceipt({
      credential,
      input: new Request('https://test.example.com/session'),
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
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
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
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
      credential: makeCredential(),
      input: request,
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
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: upstream,
      challengeId,
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

    const response = transport.respondReceipt({
      credential: makeCredential(),
      input: new Request('https://test.example.com/session'),
      receipt,
      response: plainResponse,
      challengeId,
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
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
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
        credential,
        input: new Request('https://test.example.com/session'),
        receipt: makeReceipt(),
        response: gen(),
        challengeId,
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
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: plainResponse,
      challengeId,
    })

    const body = await response.text()
    const receipt = deserializeSessionReceipt(response.headers.get('Payment-Receipt')!)

    const channel = await store.getChannel(channelId)
    expect(channel!.spent).toBe(1000000n)
    expect(channel!.units).toBe(1)
    expect(receipt.spent).toBe('1000000')
    expect(receipt.units).toBe(1)

    expect(JSON.parse(body)).toEqual({ content: 'hello' })
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()
  })

  test('respondReceipt with 204 content response still deducts from channel', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const contentResponse = new Response(null, { status: 204 })
    const response = transport.respondReceipt({
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: contentResponse,
      challengeId,
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    const receipt = deserializeSessionReceipt(response.headers.get('Payment-Receipt')!)

    await Promise.resolve()

    const channel = await store.getChannel(channelId)
    expect(channel!.spent).toBe(1000000n)
    expect(channel!.units).toBe(1)
    expect(receipt.spent).toBe('1000000')
    expect(receipt.units).toBe(1)
  })

  test('respondReceipt with management response keeps null body and does not deduct', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeManagementRequest()

    const managementResponse = new Response(null, { status: 204 })
    const response = transport.respondReceipt({
      credential: Credential.fromRequest(makeManagementRequest())!,
      input: request,
      receipt: makeReceipt(),
      response: managementResponse,
      challengeId,
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Payment-Receipt')).toBeTruthy()

    const channel = await store.getChannel(channelId)
    expect(channel!.spent).toBe(0n)
    expect(channel!.units).toBe(0)
  })

  test('respondReceipt rejects replayed plain responses with no remaining balance', async () => {
    const store = memoryStore()
    await seedChannel(store, 10000000n)
    const transport = sse({ store })
    const request = makeAuthorizedRequest()

    const response = transport.respondReceipt({
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt({ acceptedCumulative: '1000000', spent: '1000000', units: 1 }),
      response: new Response('ok'),
      challengeId,
    })

    expect(response.status).toBe(402)
    expect(response.headers.get('Payment-Receipt')).toBeNull()
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
      credential: makeCredential(),
      input: request,
      receipt: makeReceipt(),
      response: gen(),
      challengeId,
    })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(transport.name).toBe('sse')
  })
})
