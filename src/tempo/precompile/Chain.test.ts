import { encodeFunctionData, erc20Abi } from 'viem'
import { describe, expect, test } from 'vp/test'

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

describe('precompile open calldata parsing', () => {
  test('parseOpenCall accepts TIP-1034 open calldata', () => {
    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [
        descriptor.payee,
        descriptor.operator,
        descriptor.token,
        deposit,
        descriptor.salt,
        descriptor.authorizedSigner,
      ],
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

    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [
        descriptor.payee,
        descriptor.operator,
        descriptor.token,
        deposit,
        descriptor.salt,
        descriptor.authorizedSigner,
      ],
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
