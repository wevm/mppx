import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import * as AuthorizeStore from './Store.js'
import type { Authorization } from './Types.js'

const channelId = '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890'
const authorization = {
  amount: '1000',
  capturedAmount: '0',
  challengeId: 'challenge-1',
  channel: {
    chainId: 1,
    descriptor: {
      authorizedSigner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expiringNonceHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      operator: '0xcccccccccccccccccccccccccccccccccccccccc',
      payee: '0xdddddddddddddddddddddddddddddddddddddddd',
      payer: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      salt: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      token: '0x20c0000000000000000000000000000000000001',
    },
    escrow: '0x0000000000000000000000000000000000000101',
    id: channelId,
  },
  openTxHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  status: 'authorized',
} satisfies Authorization

describe('authorize store', () => {
  test('uses default key prefix', async () => {
    const raw = Store.memory()
    const store = AuthorizeStore.fromStore(raw)

    expect(store.keyPrefix).toBe(AuthorizeStore.defaultKeyPrefix)
    expect(await store.create(authorization)).toBe('created')
    expect(await raw.get(`${AuthorizeStore.defaultKeyPrefix}${channelId}`)).toEqual(authorization)
  })

  test('supports custom key prefix', async () => {
    const raw = Store.memory()
    const store = AuthorizeStore.fromStore(raw, { keyPrefix: 'tenant-a:authorize:' })

    expect(store.keyPrefix).toBe('tenant-a:authorize:')
    expect(await store.create(authorization)).toBe('created')
    expect(await AuthorizeStore.fromStore(raw).get(channelId)).toBeNull()
    expect(await store.get(channelId)).toEqual(authorization)
  })
})
