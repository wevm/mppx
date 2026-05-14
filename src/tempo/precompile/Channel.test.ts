import { AbiParameters, Hash } from 'ox'
import { describe, expect, test } from 'vp/test'

import * as Channel from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'

const descriptor = {
  payer: '0x1111111111111111111111111111111111111111',
  payee: '0x2222222222222222222222222222222222222222',
  operator: '0x3333333333333333333333333333333333333333',
  token: '0x4444444444444444444444444444444444444444',
  salt: '0x0000000000000000000000000000000000000000000000000000000000000001',
  authorizedSigner: '0x5555555555555555555555555555555555555555',
  expiringNonceHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const satisfies Channel.ChannelDescriptor

const chainId = 42431

describe('precompile Channel.computeId', () => {
  test('returns deterministic 32-byte hash for fixed inputs', () => {
    const id = Channel.computeId({ ...descriptor, chainId })
    expect(Channel.computeId({ ...descriptor, chainId })).toBe(id)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('matches manual keccak256(abi.encode(...))', () => {
    const encoded = AbiParameters.encode(
      AbiParameters.from([
        'address payer',
        'address payee',
        'address operator',
        'address token',
        'bytes32 salt',
        'address authorizedSigner',
        'bytes32 expiringNonceHash',
        'address escrow',
        'uint256 chainId',
      ]),
      [
        descriptor.payer,
        descriptor.payee,
        descriptor.operator,
        descriptor.token,
        descriptor.salt,
        descriptor.authorizedSigner,
        descriptor.expiringNonceHash,
        tip20ChannelEscrow,
        BigInt(chainId),
      ],
    )
    expect(Channel.computeId({ ...descriptor, chainId })).toBe(Hash.keccak256(encoded))
  })

  test.each([
    ['payer', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['payee', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['operator', '0xcccccccccccccccccccccccccccccccccccccccc'],
    ['token', '0xdddddddddddddddddddddddddddddddddddddddd'],
    ['salt', '0x0000000000000000000000000000000000000000000000000000000000000002'],
    ['authorizedSigner', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    ['expiringNonceHash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  ] as const)('changes when %s changes', (key, value) => {
    expect(Channel.computeId({ ...descriptor, [key]: value, chainId })).not.toBe(
      Channel.computeId({ ...descriptor, chainId }),
    )
  })

  test('changes when escrow or chainId changes', () => {
    expect(
      Channel.computeId({ ...descriptor, chainId, escrow: '0xffffffffffffffffffffffffffffffffffffffff' }),
    ).not.toBe(Channel.computeId({ ...descriptor, chainId }))
    expect(Channel.computeId({ ...descriptor, chainId: 1 })).not.toBe(
      Channel.computeId({ ...descriptor, chainId }),
    )
  })

  test('encodes chainId as uint256', () => {
    const largeChainId = 2 ** 32
    const id = Channel.computeId({ ...descriptor, chainId: largeChainId })
    const encoded = AbiParameters.encode(
      AbiParameters.from([
        'address payer',
        'address payee',
        'address operator',
        'address token',
        'bytes32 salt',
        'address authorizedSigner',
        'bytes32 expiringNonceHash',
        'address escrow',
        'uint256 chainId',
      ]),
      [
        descriptor.payer,
        descriptor.payee,
        descriptor.operator,
        descriptor.token,
        descriptor.salt,
        descriptor.authorizedSigner,
        descriptor.expiringNonceHash,
        tip20ChannelEscrow,
        BigInt(largeChainId),
      ],
    )
    expect(id).toBe(Hash.keccak256(encoded))
  })
})
