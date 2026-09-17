import { zeroAddress } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import * as Expires from '../../Expires.js'
import { charge } from './Charge.js'

describe('custom charge memos', () => {
  test.each(['validate', 'broadcast'] as const)('%s rejects before RPC', async (operation) => {
    for (const type of ['hash', 'transaction'] as const) {
      for (const nested of [false, true]) {
        const getClient = vi.fn(() => {
          throw new Error('must reject before resolving an RPC client')
        })
        const method = charge({ getClient })
        const memo = `0x${'ab'.repeat(32)}`
        const request = {
          amount: '1000',
          currency: zeroAddress,
          recipient: zeroAddress,
          ...(nested ? { methodDetails: { chainId: 4217, memo } } : { memo }),
        }
        const credential = {
          challenge: {
            expires: Expires.minutes(5),
            id: 'challenge-123',
            intent: 'charge',
            method: 'tempo',
            realm: 'api.example.com',
            request,
          },
          payload:
            type === 'hash' ? { hash: `0x${'12'.repeat(32)}`, type } : { signature: '0x76', type },
        } as const
        await expect(method[operation]!({ credential, request: request as never })).rejects.toThrow(
          'Explicit memos are not supported',
        )
        expect(getClient).not.toHaveBeenCalled()
      }
    }
  })
})
