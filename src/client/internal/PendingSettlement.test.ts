import { describe, expect, test } from 'vp/test'

import * as Errors from '../../Errors.js'
import * as PendingSettlement from './PendingSettlement.js'

const pending = () => new Errors.ZoneSettlementPendingError({ challengeId: 'abc', zoneId: 3 })

describe('PendingSettlement.resume', () => {
  test('creates the credential again for the same challenge while it settles', async () => {
    let calls = 0
    const credential = await PendingSettlement.resume(
      async () => {
        calls++
        if (calls < 3) throw pending()
        return 'credential'
      },
      { attempts: 3 },
    )
    expect(credential).toBe('credential')
    expect(calls).toBe(3)
  })

  test('throws the settlement-pending error after the last attempt', async () => {
    let calls = 0
    const error = await PendingSettlement.resume(
      async () => {
        calls++
        throw pending()
      },
      { attempts: 2 },
    ).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Errors.ZoneSettlementPendingError)
    expect(calls).toBe(2)
  })

  test('does not retry other errors', async () => {
    let calls = 0
    await expect(
      PendingSettlement.resume(
        async () => {
          calls++
          throw new Error('declined')
        },
        { attempts: 3 },
      ),
    ).rejects.toThrow('declined')
    expect(calls).toBe(1)
  })

  test('stops when the request is aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(
      PendingSettlement.resume(
        async () => {
          calls++
          controller.abort()
          throw pending()
        },
        { attempts: 3, signal: controller.signal },
      ),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
