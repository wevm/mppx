import { createClient, custom, numberToHex, padHex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Zone from './zone.js'

describe('Zone', () => {
  test('idFromChainId', () => {
    expect(Zone.idFromChainId(421_700_003)).toBe(3)
    expect(Zone.idFromChainId(1_424_310_003)).toBe(3)
    expect(Zone.idFromChainId(1337 * 2 ** 32 + 1)).toBe(1)
    expect(() => Zone.idFromChainId(42_431)).toThrow('Cannot derive a Zone ID')
  })

  test('parentChainIdFromChainId', () => {
    expect(Zone.parentChainIdFromChainId(421_700_003)).toBe(4_217)
    expect(Zone.parentChainIdFromChainId(1_424_310_003)).toBe(42_431)
    expect(Zone.parentChainIdFromChainId(1337 * 2 ** 32 + 1)).toBe(1337)
    expect(Zone.parentChainIdFromChainId(42_431)).toBeUndefined()
  })

  test('isId', () => {
    expect(Zone.isId(3)).toBe(true)
    expect(Zone.isId(421_699_999)).toBe(true)
    // viem would read this as Zone 5's chain ID and return Zone 5's portal.
    expect(Zone.isId(421_700_005)).toBe(false)
    expect(Zone.isId(0)).toBe(false)
  })

  test('portalAddress', () => {
    expect(Zone.portalAddress(3)).toBe('0x5ad0000000000000000000000000000000000003')
  })

  describe('senderTagCandidates', () => {
    const sender = '0x0000000000000000000000000000000000000001'
    const transactionHash = `0x${'ab'.repeat(32)}` as const
    /** A Zone client whose outbox reports `before` at block 9 and `after` at block 10. */
    function clientWith(before: bigint, after: bigint) {
      return createClient({
        transport: custom({
          async request({ method, params }) {
            if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
            const [, block] = params as [unknown, string]
            return padHex(numberToHex(BigInt(block) === 9n ? before : after), { size: 32 })
          },
        }),
      })
    }

    test('derives one tag per nonce the block added', async () => {
      const tags = await Zone.senderTagCandidates(clientWith(4n, 6n), {
        blockNumber: 10n,
        sender,
        transactionHash,
      })
      expect(tags).toEqual([
        Zone.senderTag({ fallbackNonce: 5n, sender, transactionHash }),
        Zone.senderTag({ fallbackNonce: 6n, sender, transactionHash }),
      ])
    })

    test('rejects a block that added no withdrawal', async () => {
      await expect(
        Zone.senderTagCandidates(clientWith(4n, 4n), { blockNumber: 10n, sender, transactionHash }),
      ).rejects.toThrow('did not request a withdrawal')
    })

    test('rejects a nonce range no block could hold', async () => {
      await expect(
        Zone.senderTagCandidates(clientWith(0n, 2n ** 63n), {
          blockNumber: 10n,
          sender,
          transactionHash,
        }),
      ).rejects.toThrow('more than 64')
    })
  })
})
