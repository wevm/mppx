import { encodeFunctionData, type Address, type Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import { descriptorFromOpen, parseOpenCall, parseTopUpCall } from './ChannelOps.js'

const chainId = 4217
const payer = '0x0000000000000000000000000000000000000001' as Address
const payee = '0x0000000000000000000000000000000000000002' as Address
const operator = '0x0000000000000000000000000000000000000000' as Address
const token = '0x20C0000000000000000000000000000000000001' as Address
const authorizedSigner = '0x0000000000000000000000000000000000000003' as Address
const salt = `0x${'11'.repeat(32)}` as Hex
const expiringNonceHash = `0x${'22'.repeat(32)}` as Hex

const descriptor = {
  authorizedSigner,
  expiringNonceHash,
  operator,
  payee,
  payer,
  salt,
  token,
} satisfies Channel.ChannelDescriptor

describe('ChannelOps', () => {
  test('parseOpenCall decodes and validates TIP-1034 open calldata', () => {
    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [payee, operator, token, 500n, salt, authorizedSigner],
    })

    expect(
      parseOpenCall({
        data,
        expected: { authorizedSigner, deposit: 500n, operator, payee, token },
      }),
    ).toEqual({
      authorizedSigner,
      deposit: 500n,
      operator,
      payee,
      salt,
      token,
    })
  })

  test('parseOpenCall rejects mismatched challenge fields', () => {
    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [payee, operator, token, 500n, salt, authorizedSigner],
    })

    expect(() =>
      parseOpenCall({
        data,
        expected: { token: '0x0000000000000000000000000000000000000004' },
      }),
    ).toThrow('TIP-1034 open token does not match challenge.')
  })

  test('parseTopUpCall decodes and validates descriptor-based top-up calldata', () => {
    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'topUp',
      args: [descriptor, 700n],
    })

    expect(
      parseTopUpCall({
        data,
        expected: { additionalDeposit: 700n, descriptor },
      }),
    ).toEqual({
      additionalDeposit: 700n,
      descriptor,
    })
  })

  test('parseTopUpCall rejects mismatched descriptors', () => {
    const data = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'topUp',
      args: [descriptor, 700n],
    })

    expect(() =>
      parseTopUpCall({
        data,
        expected: {
          descriptor: {
            ...descriptor,
            payee: '0x0000000000000000000000000000000000000004',
          },
        },
      }),
    ).toThrow('TIP-1034 topUp descriptor does not match stored channel.')
  })

  test('descriptorFromOpen validates computed channel identity', () => {
    const open = {
      authorizedSigner,
      deposit: 500n,
      operator,
      payee,
      salt,
      token,
    }
    const channelId = Channel.computeId({
      ...descriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })

    expect(
      descriptorFromOpen({
        chainId,
        channelId,
        expiringNonceHash,
        open,
        payer,
      }),
    ).toEqual(descriptor)
  })
})
