import { Hex } from 'ox'
import { type Address, isAddressEqual, parseEventLogs, zeroAddress } from 'viem'
import { sendTransaction, waitForTransactionReceipt } from 'viem/actions'
import { describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { accounts, asset, chain, client } from '~test/tempo/viem.js'

import * as Chain from './Chain.js'
import * as Channel from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'
import { escrowAbi } from './escrow.abi.js'
import { uint96 } from './Types.js'
import * as Voucher from './Voucher.js'

const isLocalnet = nodeEnv === 'localnet'
const payer = accounts[2]
const payee = accounts[0]

async function sendPrecompileCall(data: Hex.Hex, account = payer) {
  const hash = await sendTransaction(client, {
    account,
    chain,
    to: tip20ChannelEscrow,
    data,
    gasPrice: 30_000_000_000n,
  })
  const receipt = await waitForTransactionReceipt(client, { hash })
  expect(receipt.status).toBe('success')
  return receipt
}

function getSingleEvent(receipt: { logs: readonly unknown[] }, name: string) {
  const logs = parseEventLogs({
    abi: escrowAbi,
    eventName: name as never,
    logs: receipt.logs as never,
  })
  expect(logs).toHaveLength(1)
  return logs[0] as unknown as { args: Record<string, unknown> }
}

async function openChannel(parameters: { deposit?: bigint | undefined } = {}) {
  const deposit = uint96(parameters.deposit ?? 1_000n)
  const salt = Hex.random(32)
  const data = Chain.encodeOpen({
    payee: payee.address,
    operator: zeroAddress,
    token: asset,
    deposit,
    salt,
    authorizedSigner: payer.address,
  })
  const receipt = await sendPrecompileCall(data)
  const opened = getSingleEvent(receipt, 'ChannelOpened')
  const expiringNonceHash = opened.args.expiringNonceHash as Hex.Hex
  const channelId = opened.args.channelId as Hex.Hex
  const descriptor = {
    payer: payer.address,
    payee: payee.address,
    operator: zeroAddress,
    token: asset,
    salt,
    authorizedSigner: payer.address,
    expiringNonceHash,
  } satisfies Channel.ChannelDescriptor
  expect(Channel.computeId(descriptor, { chainId: chain.id, escrow: tip20ChannelEscrow })).toBe(
    channelId,
  )
  return { channelId, descriptor, deposit }
}

describe.runIf(isLocalnet)('TIP-1034 precompile localnet chain operations', () => {
  test('opens a channel, parses ChannelOpened, and reads channel state', async () => {
    const { channelId, descriptor, deposit } = await openChannel()

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.deposit).toBe(deposit)
    expect(state.settled).toBe(0n)
    expect(state.closeRequestedAt).toBe(0)

    const channel = await Chain.getChannel(client, descriptor, tip20ChannelEscrow)
    expect(isAddressEqual(channel.descriptor.payer as Address, payer.address)).toBe(true)
    expect(isAddressEqual(channel.descriptor.payee as Address, payee.address)).toBe(true)
    expect(channel.state.deposit).toBe(deposit)
  })

  test('topUp updates precompile channel state and emits TopUp', async () => {
    const { channelId, descriptor, deposit } = await openChannel({ deposit: 1_000n })
    const additionalDeposit = uint96(750n)

    const receipt = await sendPrecompileCall(Chain.encodeTopUp(descriptor, additionalDeposit))
    const topUp = getSingleEvent(receipt, 'TopUp')
    expect(topUp.args.channelId).toBe(channelId)
    expect(topUp.args.additionalDeposit).toBe(additionalDeposit)
    expect(topUp.args.newDeposit).toBe(deposit + additionalDeposit)

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.deposit).toBe(deposit + additionalDeposit)
  })

  test('settles a signed voucher against the descriptor', async () => {
    const { channelId, descriptor } = await openChannel({ deposit: 1_000n })
    const cumulativeAmount = uint96(400n)
    const signature = await Voucher.sign(
      client,
      payer,
      { channelId, cumulativeAmount },
      { chainId: chain.id, verifyingContract: tip20ChannelEscrow },
    )

    const receipt = await sendPrecompileCall(
      Chain.encodeSettle(descriptor, cumulativeAmount, signature),
      payee,
    )
    const settled = getSingleEvent(receipt, 'Settled')
    expect(settled.args.channelId).toBe(channelId)
    expect(settled.args.cumulativeAmount).toBe(cumulativeAmount)

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.settled).toBe(cumulativeAmount)
  })
})
