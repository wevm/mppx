import { describe, expect, test } from 'vp/test'

import * as tempo from './index.js'

describe('tempo.Proof', () => {
  test('proofSource constructs a did:pkh:eip155 source', () => {
    expect(
      tempo.Proof.proofSource({
        address: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
        chainId: 42431,
      }),
    ).toBe('did:pkh:eip155:42431:0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')
  })

  test('parseProofSource parses a valid did:pkh:eip155 source', () => {
    expect(
      tempo.Proof.parseProofSource(
        'did:pkh:eip155:42431:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
      ),
    ).toEqual({
      address: '0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
      chainId: 42431,
    })
  })

  test('parsePkhSource parses a valid did:pkh:eip155 source', () => {
    expect(
      tempo.Proof.parsePkhSource('did:pkh:eip155:42431:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141'),
    ).toEqual({
      address: '0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
      chainId: 42431,
    })
  })

  test('parseProofSource rejects invalid source values', () => {
    expect(
      tempo.Proof.parseProofSource('did:pkh:eip155:01:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141'),
    ).toBe(null)
  })
})
