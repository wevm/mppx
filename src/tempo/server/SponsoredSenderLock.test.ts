import type { Client } from 'viem'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vp/test'

import * as Store from '../../Store.js'
import {
  acquire,
  clear,
  prepare,
  reconcile,
  recoverSponsoredSenderLock,
  type SponsoredSenderLockRecord,
  type SponsorshipEvent,
} from './SponsoredSenderLock.js'

const now = 1_800_000_000_000
const chainId = 4217
const sender = `0x${'1'.repeat(40)}` as const
const inputHash = `0x${'2'.repeat(64)}` as const
const transactionHash = `0x${'3'.repeat(64)}` as const
const key = `mppx:charge:sponsor:${chainId}:${sender}` as const

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => vi.useRealTimers())

describe('sponsored sender lock', () => {
  test('owner-fences concurrent acquisition and stale cleanup', async () => {
    const store = Store.memory()
    const first = await acquire(parameters(store))
    const second = await acquire(parameters(store))

    expect(first.status).toBe('acquired')
    expect(second).toMatchObject({ ageMs: 0, status: 'contended' })
    if (first.status !== 'acquired' || second.status !== 'contended') return
    if (typeof second.lock === 'number') return

    expect(
      await clear({
        ...target(store),
        lock: { ...second.lock, owner: 'stale-owner' },
        reason: 'manual',
      }),
    ).toBe(false)
    expect(await store.get(key)).toEqual(first.lock)
  })

  test('recovers an abandoned preparing lock after its bounded lease', async () => {
    const store = Store.memory()
    const first = await acquire(parameters(store, { leaseTimeoutMs: 1_000 }))
    expect(first.status).toBe('acquired')

    vi.setSystemTime(now + 1_000)
    const recovered = await acquire(parameters(store, { leaseTimeoutMs: 1_000 }))

    expect(recovered.status).toBe('acquired')
    if (first.status === 'acquired' && recovered.status === 'acquired')
      expect(recovered.lock.owner).not.toBe(first.lock.owner)
  })

  test('reconciles confirmed success and revert after restart', async () => {
    for (const status of ['0x1', '0x0'] as const) {
      const store = Store.memory()
      await putPrepared(store)
      const result = await recoverSponsoredSenderLock({
        ...target(store),
        client: rpcClient({ receiptStatus: status }),
      })

      expect(result).toEqual({
        reason: status === '0x1' ? 'success' : 'reverted',
        status: 'cleared',
      })
      expect(await store.get(key)).toBeNull()
      expect(await store.get(`mppx:charge:${inputHash}`)).toBe(now)
      expect(await store.get(`mppx:charge:${transactionHash}`)).toBe(now)
    }
  })

  test('clears a positively visible mempool transaction', async () => {
    const store = Store.memory()
    await putPrepared(store)

    await expect(
      reconcile({ ...target(store), client: rpcClient({ pending: true }) }),
    ).resolves.toEqual({ reason: 'pending', status: 'cleared' })
    expect(await store.get(key)).toBeNull()
  })

  test('does not misclassify an RPC miss as a drop or replacement', async () => {
    const store = Store.memory()
    await putPrepared(store)

    await expect(reconcile({ ...target(store), client: rpcClient({}) })).resolves.toMatchObject({
      status: 'unknown',
      transactionHash,
    })
    expect(await store.get(key)).not.toBeNull()
  })

  test('clears a dropped or unknown transaction only after nonce expiry', async () => {
    const store = Store.memory()
    await putPrepared(store, now + 1_000)
    vi.setSystemTime(now + 1_000)

    await expect(
      recoverSponsoredSenderLock({ ...target(store), client: rpcClient({}) }),
    ).resolves.toEqual({ reason: 'expired', status: 'cleared' })
    await expect(
      recoverSponsoredSenderLock({ ...target(store), client: rpcClient({}) }),
    ).resolves.toEqual({ status: 'absent' })
  })

  test('migrates stale timestamp-only locks and emits lifecycle events', async () => {
    const store = Store.memory()
    const events: SponsorshipEvent[] = []
    await store.put(key, now - 60_000)

    await expect(
      recoverSponsoredSenderLock({
        ...target(store),
        client: rpcClient({}),
        onEvent(event) {
          events.push(event)
        },
      }),
    ).resolves.toEqual({ reason: 'legacy-expired', status: 'cleared' })
    expect(events).toContainEqual(
      expect.objectContaining({ reason: 'legacy-expired', type: 'cleared' }),
    )
  })
})

function parameters(store: Store.AtomicStore<any>, overrides: { leaseTimeoutMs?: number } = {}) {
  return {
    ...target(store),
    inputHash,
    nonce: '1',
    nonceKey: 'expiring',
    validBefore: now + 30_000,
    ...overrides,
  }
}

function target(store: Store.AtomicStore<any>) {
  return { chainId, sender, store }
}

async function putPrepared(store: Store.AtomicStore<any>, validBefore = now + 30_000) {
  const result = await acquire({ ...parameters(store), validBefore })
  if (result.status !== 'acquired') throw new Error('failed to acquire test lock')
  const prepared = await prepare({
    ...target(store),
    lock: result.lock,
    transactionHash,
  })
  if (!prepared) throw new Error('failed to prepare test lock')
  return prepared satisfies SponsoredSenderLockRecord
}

function rpcClient(options: { pending?: boolean; receiptStatus?: '0x0' | '0x1' }): Client {
  return {
    async request({ method }: { method: string }) {
      if (method === 'eth_getTransactionReceipt')
        return options.receiptStatus ? rawReceipt(options.receiptStatus) : null
      if (method === 'eth_getTransactionByHash') return options.pending ? rawTransaction() : null
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  } as unknown as Client
}

function rawReceipt(status: '0x0' | '0x1') {
  return {
    blockHash: `0x${'4'.repeat(64)}`,
    blockNumber: '0x1',
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    from: sender,
    gasUsed: '0x5208',
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    status,
    to: `0x${'5'.repeat(40)}`,
    transactionHash,
    transactionIndex: '0x0',
    type: '0x0',
  }
}

function rawTransaction() {
  return {
    blockHash: null,
    blockNumber: null,
    from: sender,
    gas: '0x5208',
    gasPrice: '0x1',
    hash: transactionHash,
    input: '0x',
    nonce: '0x1',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'2'.repeat(64)}`,
    to: `0x${'5'.repeat(40)}`,
    transactionIndex: null,
    type: '0x0',
    v: '0x1b',
    value: '0x0',
  }
}
