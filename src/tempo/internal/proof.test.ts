import { describe, expect, test } from 'vp/test'

import * as Proof from './proof.js'

const parseProofSourceCases = [
  {
    expected: {
      address: '0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
      chainId: 42431,
    },
    name: 'parses a valid did:pkh:eip155 source',
    source: 'did:pkh:eip155:42431:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
  },
  {
    expected: null,
    name: 'rejects non-numeric chain ids',
    source: 'did:pkh:eip155:not-a-number:0x1234',
  },
  {
    expected: null,
    name: 'rejects leading-zero chain ids',
    source: 'did:pkh:eip155:01:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
  },
  {
    expected: null,
    name: 'rejects unsafe integer chain ids',
    source: 'did:pkh:eip155:9007199254740992:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
  },
  {
    expected: null,
    name: 'rejects invalid addresses',
    source: 'did:pkh:eip155:42431:not-an-address',
  },
  {
    expected: null,
    name: 'rejects extra path segments',
    source: 'did:pkh:eip155:42431:0xAbCdEf1234567890AbCdEf1234567890AbCdEf12:extra',
  },
  {
    expected: null,
    name: 'rejects unsupported namespaces',
    source: 'did:pkh:solana:42431:0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141',
  },
] as const

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

  for (const { expected, name, source } of parseProofSourceCases) {
    test(`parseProofSource ${name}`, () => {
      expect(Proof.parseProofSource(source)).toEqual(expected)
    })
  }
})
