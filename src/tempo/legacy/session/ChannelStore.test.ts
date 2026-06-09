import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import { chainId, escrowContract as escrowContractDefaults } from '../../internal/defaults.js'
import * as ChannelStore from './ChannelStore.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

function legacyChannel(
  overrides: Partial<ChannelStore.LegacyState> = {},
): ChannelStore.LegacyState {
  return {
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    chainId: 42431,
    escrowContract: escrowContractDefaults[chainId.testnet] as Address,
    deposit: 10_000_000n,
    settledOnChain: 0n,
    highestVoucherAmount: 10_000_000n,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    closeRequestedAt: 0n,
    finalized: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('legacy ChannelStore', () => {
  test('keeps existing contract-backed channels compatible when backend fields are absent', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await store.updateChannel(channelId, () => legacyChannel())

    const loaded = await store.getChannel(channelId)
    expect(loaded).not.toBeNull()
    expect(ChannelStore.isContractState(loaded!)).toBe(true)
    expect(loaded!.backend).toBeUndefined()
    expect('operator' in loaded!).toBe(false)
    expect('salt' in loaded!).toBe(false)
    expect('expiringNonceHash' in loaded!).toBe(false)
    expect('descriptor' in loaded!).toBe(false)
  })

  test('supports explicit contract-backed channel state', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await store.updateChannel(channelId, () => legacyChannel({ backend: 'contract' }))

    const loaded = await store.getChannel(channelId)
    expect(loaded).not.toBeNull()
    expect(ChannelStore.isContractState(loaded!)).toBe(true)
    expect(loaded!.backend).toBe('contract')
  })
})
