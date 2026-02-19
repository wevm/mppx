import { AbiParameters, Hash } from 'ox'
import { describe, expect, test } from 'vitest'
import * as Channel from './Channel.js'

describe('computeId', () => {
  const defaultParams: Channel.computeId.Parameters = {
    payer: '0x1111111111111111111111111111111111111111',
    payee: '0x2222222222222222222222222222222222222222',
    token: '0x3333333333333333333333333333333333333333',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000001',
    authorizedSigner: '0x4444444444444444444444444444444444444444',
    escrowContract: '0x5555555555555555555555555555555555555555',
    chainId: 42431,
  }

  test('returns deterministic hash for fixed inputs', () => {
    const id1 = Channel.computeId(defaultParams)
    const id2 = Channel.computeId(defaultParams)
    expect(id1).toBe(id2)
  })

  test('matches manual keccak256(abi.encode(...))', () => {
    const encoded = AbiParameters.encode(
      AbiParameters.from([
        'address payer',
        'address payee',
        'address token',
        'bytes32 salt',
        'address authorizedSigner',
        'address escrowContract',
        'uint256 chainId',
      ]),
      [
        defaultParams.payer,
        defaultParams.payee,
        defaultParams.token,
        defaultParams.salt,
        defaultParams.authorizedSigner,
        defaultParams.escrowContract,
        BigInt(defaultParams.chainId),
      ],
    )
    const expected = Hash.keccak256(encoded)
    expect(Channel.computeId(defaultParams)).toBe(expected)
  })

  test('different payer produces different id', () => {
    const id1 = Channel.computeId(defaultParams)
    const id2 = Channel.computeId({
      ...defaultParams,
      payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(id1).not.toBe(id2)
  })

  test('different salt produces different id', () => {
    const id1 = Channel.computeId(defaultParams)
    const id2 = Channel.computeId({
      ...defaultParams,
      salt: '0x0000000000000000000000000000000000000000000000000000000000000002',
    })
    expect(id1).not.toBe(id2)
  })

  test('different chainId produces different id', () => {
    const id1 = Channel.computeId(defaultParams)
    const id2 = Channel.computeId({ ...defaultParams, chainId: 1 })
    expect(id1).not.toBe(id2)
  })

  test('chainId is encoded as uint256', () => {
    const largeChainId = 2 ** 32
    const id = Channel.computeId({ ...defaultParams, chainId: largeChainId })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)

    const encoded = AbiParameters.encode(
      AbiParameters.from([
        'address payer',
        'address payee',
        'address token',
        'bytes32 salt',
        'address authorizedSigner',
        'address escrowContract',
        'uint256 chainId',
      ]),
      [
        defaultParams.payer,
        defaultParams.payee,
        defaultParams.token,
        defaultParams.salt,
        defaultParams.authorizedSigner,
        defaultParams.escrowContract,
        BigInt(largeChainId),
      ],
    )
    expect(id).toBe(Hash.keccak256(encoded))
  })

  test('result is a 0x-prefixed 32-byte hex string', () => {
    const id = Channel.computeId(defaultParams)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('chainId 0 is valid', () => {
    const id = Channel.computeId({ ...defaultParams, chainId: 0 })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
