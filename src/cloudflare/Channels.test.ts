import { describe, expect, test } from 'vp/test'

import * as Store from '../Store.js'
import type { State } from '../tempo/session/server/ChannelStore.js'
import { channels } from './Channels.js'

const payer = '0x00000000000000000000000000000000000000aa'
const payee = '0x00000000000000000000000000000000000000ee'
const token = '0x20c0000000000000000000000000000000000000'

function channel(channelId: string, overrides: Partial<State> = {}): State {
  return {
    authorizedSigner: payer,
    backend: 'precompile',
    chainId: 42431,
    channelId,
    closeRequestedAt: 0n,
    createdAt: new Date(0).toISOString(),
    deposit: 10_000n,
    descriptor: {} as never,
    escrowContract: '0x4d50500000000000000000000000000000000000',
    expiringNonceHash: '0x00',
    finalized: false,
    highestVoucher: { channelId, cumulativeAmount: 1n, signature: '0x01' },
    highestVoucherAmount: 1n,
    operator: '0x0000000000000000000000000000000000000000',
    payee,
    payer,
    salt: '0x00',
    settledOnChain: 0n,
    spent: 1n,
    token,
    units: 1,
    ...overrides,
  } as State
}

/** Durable Objects in memory, reached over `fetch`, that can hold back one lookup entry swap. */
function namespace() {
  const objects = new Map<string, Store.DurableObjectStore>()
  let hold:
    | {
        held: () => void
        match: (body: Store.DurableObjectStore.Request) => boolean
        released: Promise<void>
      }
    | undefined
  return {
    /** Holds back the next request that `match` picks (a lookup entry swap) until `release` is called. */
    hold(
      match: (body: Store.DurableObjectStore.Request) => boolean = (body) =>
        body.op === 'swap' && body.key.startsWith('mppx:session-lookup:'),
    ) {
      let release!: () => void
      let held!: () => void
      const reached = new Promise<void>((resolve) => {
        held = resolve
      })
      hold = { held, match, released: new Promise((resolve) => (release = resolve)) }
      return { reached, release }
    },
    idFromName: (name: string) => name,
    get(id: string) {
      let object = objects.get(id)
      if (!object) {
        const map = new Map<string, unknown>()
        object = new Store.DurableObjectStore({
          storage: {
            get: async (key: string) => map.get(key),
            async put(key: string, value: unknown) {
              map.set(key, value)
            },
            delete: async (key: string) => map.delete(key),
          },
        })
        objects.set(id, object)
      }
      const target = object
      return {
        async fetch(input: string, init: RequestInit) {
          const body = JSON.parse(init.body as string) as Store.DurableObjectStore.Request
          if (hold?.match(body)) {
            const { held, released } = hold
            hold = undefined
            held()
            await released
          }
          return target.fetch(new Request(input, init))
        },
      }
    },
  }
}

/** The lookup entry key of the test payer's channels. */
const lookupKey = `mppx:session-lookup:v3:${[payer, payee, token, '0x4d50500000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'].join(':')}:42431`

function resolve(lookup: ReturnType<typeof channels>, operator?: `0x${string}`) {
  return lookup.resolveChannelId({
    credential: null,
    paymentRequest: {
      amount: '1',
      currency: token,
      decimals: 6,
      recipient: payee,
      unitType: 'request',
      ...(operator ? { operator } : {}),
    },
    source: `did:pkh:eip155:42431:${payer}`,
    store: undefined as never,
  })
}

describe('channels', () => {
  const a = `0x${'a'.repeat(64)}`
  const b = `0x${'b'.repeat(64)}`

  test('a delayed lookup write for a channel that has since closed keeps the newer open channel', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const { reached, release } = objects.hold()
    // Channel A opens, and its lookup entry write is held back.
    const opening = lookup.store.put(a, channel(a))
    await reached
    await lookup.store.put(a, channel(a, { closeRequestedAt: 1n }))
    await lookup.store.put(b, channel(b))
    expect(await resolve(lookup)).toBe(b)
    release()
    await opening
    expect(await resolve(lookup)).toBe(b)
  })

  test('a lookup add delayed past its channel closing leaves the channel out', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const { reached, release } = objects.hold(
      (body) => body.op === 'get' && body.key.startsWith('mppx:session-lookup:'),
    )
    // Channel A opens, and its lookup add is held back until A has closed.
    const opening = lookup.store.put(a, channel(a))
    await reached
    await Store.durableObject(objects).put(a, channel(a, { finalized: true }))
    release()
    await opening
    expect(await Store.durableObject(objects).get(lookupKey)).toBeNull()
  })

  test('a full entry drops channels that no longer resume before an open one', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const ids = Array.from({ length: 9 }, (_, i) => `0x${i.toString(16).repeat(64)}`)
    for (const id of ids.slice(0, 8)) await lookup.store.put(id, channel(id))
    // The most recent closes without its entry removed, as when that write was delayed or failed.
    await Store.durableObject(objects).put(ids[7]!, channel(ids[7]!, { finalized: true }))
    await lookup.store.put(ids[8]!, channel(ids[8]!))
    // The closed channel made room, so the oldest open one stays findable.
    for (const id of [ids[8]!, ...ids.slice(1, 7).reverse()]) {
      expect(await resolve(lookup)).toBe(id)
      await lookup.store.put(id, channel(id, { finalized: true }))
    }
    expect(await resolve(lookup)).toBe(ids[0])
  })

  test('replaces an entry whose channel no longer resumes', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    await lookup.store.put(a, channel(a))
    // A closes without its entry removed, as when that write failed.
    await Store.durableObject(objects).put(a, channel(a, { finalized: true }))
    expect(await resolve(lookup)).toBeUndefined()
    await lookup.store.put(b, channel(b))
    expect(await resolve(lookup)).toBe(b)
  })

  test("keeps a payer's other open channel findable when the most recent one closes", async () => {
    const objects = namespace()
    const lookup = channels(objects)
    await lookup.store.put(a, channel(a))
    await lookup.store.put(b, channel(b))
    expect(await resolve(lookup)).toBe(b)
    await lookup.store.put(b, channel(b, { closeRequestedAt: 1n }))
    expect(await resolve(lookup)).toBe(a)
    await lookup.store.put(a, channel(a, { finalized: true }))
    expect(await resolve(lookup)).toBeUndefined()
  })

  test("skips a channel opened with another operator than the challenge's", async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const operator = '0x00000000000000000000000000000000000000cc'
    await lookup.store.put(a, channel(a, { operator }))
    await lookup.store.put(b, channel(b))
    expect(await resolve(lookup, operator)).toBe(a)
    expect(await resolve(lookup, '0x0000000000000000000000000000000000000000')).toBe(b)
    expect(await resolve(lookup, '0x00000000000000000000000000000000000000dd')).toBeUndefined()
    // mppx verifies a challenge without an operator against the zero operator.
    expect(await resolve(lookup)).toBe(b)
    await lookup.store.put(b, channel(b, { finalized: true }))
    expect(await resolve(lookup)).toBeUndefined()
  })

  test('keeps a channel findable behind eight newer ones with another operator', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const operator = '0x00000000000000000000000000000000000000cc'
    await lookup.store.put(a, channel(a))
    const ids = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16).repeat(64)}`)
    for (const id of ids) await lookup.store.put(id, channel(id, { operator }))
    expect(await resolve(lookup)).toBe(a)
    expect(await resolve(lookup, operator)).toBe(ids[7])
  })

  test('keeps the most recent open channels of a payer', async () => {
    const objects = namespace()
    const lookup = channels(objects)
    const ids = Array.from({ length: 9 }, (_, i) => `0x${i.toString(16).repeat(64)}`)
    for (const id of ids) await lookup.store.put(id, channel(id))
    // The oldest falls out of the entry once it holds eight newer ones.
    for (const id of ids.slice(1).reverse()) {
      expect(await resolve(lookup)).toBe(id)
      await lookup.store.put(id, channel(id, { finalized: true }))
    }
    expect(await resolve(lookup)).toBeUndefined()
  })
})
