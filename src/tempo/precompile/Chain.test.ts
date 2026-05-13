import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Chain from './Chain.js'
import { escrowAbi } from './escrow.abi.js'
import * as ServerChannelOps from './server/ChannelOps.js'
import * as Types from './Types.js'

const descriptor = {
  payer: '0x1111111111111111111111111111111111111111',
  payee: '0x2222222222222222222222222222222222222222',
  operator: '0x3333333333333333333333333333333333333333',
  token: '0x4444444444444444444444444444444444444444',
  salt: '0x0000000000000000000000000000000000000000000000000000000000000001',
  authorizedSigner: '0x5555555555555555555555555555555555555555',
  expiringNonceHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const

const deposit = Types.uint96(1_000_000n)
const cumulativeAmount = Types.uint96(500_000n)
const captureAmount = Types.uint96(400_000n)
const signature = '0x1234' as const

function expectDescriptor(actual: unknown) {
  expect(actual).toEqual(descriptor)
}

describe('precompile Chain encoders', () => {
  test('encodeOpen round-trips through parseOpenCall', () => {
    const data = Chain.encodeOpen({
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      operator: descriptor.operator,
      payee: descriptor.payee,
      salt: descriptor.salt,
      token: descriptor.token,
    })
    const open = ServerChannelOps.parseOpenCall({
      data,
      expected: {
        authorizedSigner: descriptor.authorizedSigner,
        deposit,
        operator: descriptor.operator,
        payee: descriptor.payee,
        token: descriptor.token,
      },
    })
    expect(open).toEqual({
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      operator: descriptor.operator,
      payee: descriptor.payee,
      salt: descriptor.salt,
      token: descriptor.token,
    })
  })

  test('parseOpenCall rejects non-open calldata and expected mismatches', () => {
    const approve = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [descriptor.payee, deposit],
    })
    expect(() => ServerChannelOps.parseOpenCall({ data: approve })).toThrow(
      'Expected TIP-1034 open calldata',
    )

    const data = Chain.encodeOpen({
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      operator: descriptor.operator,
      payee: descriptor.payee,
      salt: descriptor.salt,
      token: descriptor.token,
    })
    expect(() =>
      ServerChannelOps.parseOpenCall({
        data,
        expected: { payee: '0xffffffffffffffffffffffffffffffffffffffff' },
      }),
    ).toThrow('payee does not match')
    expect(() =>
      ServerChannelOps.parseOpenCall({
        data,
        expected: { operator: '0xffffffffffffffffffffffffffffffffffffffff' },
      }),
    ).toThrow('operator does not match')
    expect(() =>
      ServerChannelOps.parseOpenCall({
        data,
        expected: { token: '0xffffffffffffffffffffffffffffffffffffffff' },
      }),
    ).toThrow('token does not match')
    expect(() =>
      ServerChannelOps.parseOpenCall({
        data,
        expected: { authorizedSigner: '0xffffffffffffffffffffffffffffffffffffffff' },
      }),
    ).toThrow('authorizedSigner does not match')
    expect(() =>
      ServerChannelOps.parseOpenCall({ data, expected: { deposit: Types.uint96(1n) } }),
    ).toThrow('deposit does not match')
  })

  test('encodes descriptor-based lifecycle calls', () => {
    const settle = decodeFunctionData({
      abi: escrowAbi,
      data: Chain.encodeSettle(descriptor, cumulativeAmount, signature),
    })
    expect(settle.functionName).toBe('settle')
    expectDescriptor(settle.args[0])
    expect(settle.args[1]).toBe(cumulativeAmount)
    expect(settle.args[2]).toBe(signature)

    const topUp = decodeFunctionData({
      abi: escrowAbi,
      data: Chain.encodeTopUp(descriptor, deposit),
    })
    expect(topUp.functionName).toBe('topUp')
    expectDescriptor(topUp.args[0])
    expect(topUp.args[1]).toBe(deposit)

    const close = decodeFunctionData({
      abi: escrowAbi,
      data: Chain.encodeClose(descriptor, cumulativeAmount, captureAmount, signature),
    })
    expect(close.functionName).toBe('close')
    expectDescriptor(close.args[0])
    expect(close.args[1]).toBe(cumulativeAmount)
    expect(close.args[2]).toBe(captureAmount)
    expect(close.args[3]).toBe(signature)

    const requestClose = decodeFunctionData({
      abi: escrowAbi,
      data: Chain.encodeRequestClose(descriptor),
    })
    expect(requestClose.functionName).toBe('requestClose')
    expectDescriptor(requestClose.args[0])

    const withdraw = decodeFunctionData({ abi: escrowAbi, data: Chain.encodeWithdraw(descriptor) })
    expect(withdraw.functionName).toBe('withdraw')
    expectDescriptor(withdraw.args[0])
  })
})

describe('precompile escrowAbi parity', () => {
  test('contains all TIP-1034 functions and events', () => {
    const functions = escrowAbi.filter((item) => item.type === 'function').map((item) => item.name)
    expect(functions).toEqual([
      'CLOSE_GRACE_PERIOD',
      'VOUCHER_TYPEHASH',
      'open',
      'settle',
      'topUp',
      'close',
      'requestClose',
      'withdraw',
      'getChannel',
      'getChannelState',
      'getChannelStatesBatch',
      'computeChannelId',
      'getVoucherDigest',
      'domainSeparator',
    ])

    const events = escrowAbi.filter((item) => item.type === 'event').map((item) => item.name)
    expect(events).toEqual([
      'ChannelOpened',
      'Settled',
      'TopUp',
      'CloseRequested',
      'ChannelClosed',
      'CloseRequestCancelled',
    ])
  })

  test('keeps ChannelDescriptor component order and ChannelOpened expiringNonceHash', () => {
    const settle = escrowAbi.find((item) => item.type === 'function' && item.name === 'settle')!
    const descriptorInput = settle.inputs[0]
    expect(descriptorInput.components.map((component) => component.name)).toEqual([
      'payer',
      'payee',
      'operator',
      'token',
      'salt',
      'authorizedSigner',
      'expiringNonceHash',
    ])

    const opened = escrowAbi.find((item) => item.type === 'event' && item.name === 'ChannelOpened')!
    expect(opened.inputs.map((input) => input.name)).toContain('expiringNonceHash')
  })
})
