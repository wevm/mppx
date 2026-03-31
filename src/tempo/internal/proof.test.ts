import { describe, expect, test } from 'vp/test'

import * as Proof from './proof.js'

describe('Proof', () => {
  test('types has Proof with challengeId field', () => {
    expect(Proof.types).toEqual({
      Proof: [{ name: 'challengeId', type: 'string' }],
    })
  })

  test('domain returns EIP-712 domain with name, version, chainId', () => {
    const d = Proof.domain(42431)
    expect(d).toEqual({ name: 'MPP', version: '1', chainId: 42431 })
  })

  test('domain uses provided chainId', () => {
    expect(Proof.domain(1).chainId).toBe(1)
    expect(Proof.domain(99999).chainId).toBe(99999)
  })

  test('message wraps challengeId', () => {
    expect(Proof.message('abc123')).toEqual({ challengeId: 'abc123' })
  })

  test('proofSource constructs did:pkh DID', () => {
    expect(Proof.proofSource({ address: '0x1234567890abcdef', chainId: 42431 })).toBe(
      'did:pkh:eip155:42431:0x1234567890abcdef',
    )
  })

  test('proofSource preserves address casing', () => {
    const address = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12'
    expect(Proof.proofSource({ address, chainId: 1 })).toBe(`did:pkh:eip155:1:${address}`)
  })

  test('parseProofSource parses a valid did:pkh:eip155 source', () => {
    const address = '0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141'

    expect(Proof.parseProofSource(`did:pkh:eip155:42431:${address}`)).toEqual({
      address,
      chainId: 42431,
    })
  })

  test('parseProofSource rejects malformed sources', () => {
    expect(Proof.parseProofSource('did:pkh:eip155:not-a-number:0x1234')).toBeNull()
    expect(
      Proof.parseProofSource(
        'did:pkh:eip155:42431:0xAbCdEf1234567890AbCdEf1234567890AbCdEf12:extra',
      ),
    ).toBeNull()
  })
})
