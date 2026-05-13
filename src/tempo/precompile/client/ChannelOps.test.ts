import { Hex } from 'ox'
import { type Address, createClient, custom, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import * as Types from '../Types.js'
import * as Voucher from '../Voucher.js'
import * as ChannelOps from './ChannelOps.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const client = createClient({
  account,
  transport: custom({
    async request() {
      throw new Error('unexpected rpc request')
    },
  }),
})
const chainId = 42431

const descriptor = {
  payer: account.address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  token: '0x0000000000000000000000000000000000000003' as Address,
  salt: `0x${'11'.repeat(32)}` as Hex.Hex,
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as Hex.Hex,
} satisfies Channel.ChannelDescriptor

const channelId = Channel.computeId(descriptor, { chainId, escrow: tip20ChannelEscrow })

describe('precompile client ChannelOps credential builders', () => {
  test('creates an open credential from a signed open result', () => {
    const initialAmount = Types.uint96(100n)
    const payload = ChannelOps.createOpenCredential(
      {
        channelId,
        descriptor,
        transaction: '0x1234',
        voucherSignature: '0xabcd',
      },
      initialAmount,
    )

    expect(payload).toEqual({
      action: 'open',
      type: 'transaction',
      channelId,
      transaction: '0x1234',
      signature: '0xabcd',
      descriptor,
      cumulativeAmount: '100',
      authorizedSigner: descriptor.authorizedSigner,
    })
  })

  test('creates a verifiable voucher credential for an existing precompile channel', async () => {
    const cumulativeAmount = Types.uint96(250n)
    const payload = await ChannelOps.createVoucherCredential(client, account, {
      chainId,
      cumulativeAmount,
      descriptor,
      escrow: tip20ChannelEscrow,
    })

    expect(payload.action).toBe('voucher')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.cumulativeAmount).toBe('250')
    expect(
      Voucher.verify(
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
        {
          chainId,
          verifyingContract: tip20ChannelEscrow,
        },
      ),
    ).toBe(true)
  })

  test('creates a top-up credential from a signed top-up result', () => {
    const additionalDeposit = Types.uint96(500n)
    const payload = ChannelOps.createTopUpCredential(
      {
        channelId,
        descriptor,
        transaction: '0x5678',
      },
      additionalDeposit,
    )

    expect(payload).toEqual({
      action: 'topUp',
      type: 'transaction',
      channelId,
      transaction: '0x5678',
      descriptor,
      additionalDeposit: '500',
    })
  })

  test('uses the payer as voucher signer when descriptor authorizedSigner is zero', async () => {
    const zeroSignerDescriptor = {
      ...descriptor,
      authorizedSigner: zeroAddress,
    }
    const zeroSignerChannelId = Channel.computeId(zeroSignerDescriptor, {
      chainId,
      escrow: tip20ChannelEscrow,
    })
    const cumulativeAmount = Types.uint96(275n)
    const payload = await ChannelOps.createVoucherCredential(client, account, {
      chainId,
      cumulativeAmount,
      descriptor: zeroSignerDescriptor,
      escrow: tip20ChannelEscrow,
    })

    expect(payload.channelId).toBe(zeroSignerChannelId)
    expect(
      Voucher.verify(
        { channelId: zeroSignerChannelId, cumulativeAmount, signature: payload.signature },
        descriptor.payer,
        {
          chainId,
          verifyingContract: tip20ChannelEscrow,
        },
      ),
    ).toBe(true)
  })

  test('creates a close credential with a verifiable voucher signature', async () => {
    const cumulativeAmount = Types.uint96(300n)
    const payload = await ChannelOps.createCloseCredential(client, account, {
      chainId,
      cumulativeAmount,
      descriptor,
      escrow: tip20ChannelEscrow,
    })

    expect(payload.action).toBe('close')
    expect(payload.channelId).toBe(channelId)
    expect(payload.cumulativeAmount).toBe('300')
    expect(
      Voucher.verify(
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
        {
          chainId,
          verifyingContract: tip20ChannelEscrow,
        },
      ),
    ).toBe(true)
  })
})
