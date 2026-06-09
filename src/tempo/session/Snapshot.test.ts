import { Base64 } from 'ox'
import { describe, expect, test } from 'vp/test'

import { deserializeSnapshot, serializeSnapshot, type SessionSnapshot } from './Snapshot.js'

const descriptor = {
  authorizedSigner: '0x0000000000000000000000000000000000000001',
  expiringNonceHash: `0x${'11'.repeat(32)}`,
  operator: '0x0000000000000000000000000000000000000000',
  payee: '0x0000000000000000000000000000000000000002',
  payer: '0x0000000000000000000000000000000000000003',
  salt: `0x${'22'.repeat(32)}`,
  token: '0x20c0000000000000000000000000000000000001',
} as const

const snapshot = {
  acceptedCumulative: '100',
  chainId: 4217,
  channelId: `0x${'aa'.repeat(32)}`,
  deposit: '1000',
  descriptor,
  escrow: '0x4d50500000000000000000000000000000000000',
  requiredCumulative: '100',
  settled: '0',
  spent: '50',
  units: 5,
} satisfies SessionSnapshot

describe('SessionSnapshot', () => {
  test('round-trips a valid snapshot header', () => {
    expect(deserializeSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot)
  })

  test('rejects malformed channel descriptors', () => {
    const value = serializeSnapshot(snapshot)
    const encoded = JSON.parse(Base64.toString(value)) as SessionSnapshot
    encoded.descriptor = { ...descriptor, payee: 'not-an-address' as never }

    expect(() => deserializeSnapshot(Base64.fromString(JSON.stringify(encoded)))).toThrow()
  })
})
