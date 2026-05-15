import { Hex } from 'ox'
import { type Address, encodeFunctionData, isAddressEqual, parseEventLogs, zeroAddress } from 'viem'
import { sendTransaction, waitForTransactionReceipt } from 'viem/actions'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { accounts, asset, chain, client } from '~test/tempo/viem.js'

import * as Chain from './Chain.js'
import * as Channel from './Channel.js'
import { createOpenPayload, createTopUpPayload } from './client/ChannelOps.js'
import { tip20ChannelEscrow } from './Constants.js'
import { escrowAbi } from './escrow.abi.js'
import { uint96 } from './Types.js'
import * as Voucher from './Voucher.js'

const isPrecompileTestnet = nodeEnv === 'localnet' || nodeEnv === 'devnet'
const payer = accounts[2]
const payee = accounts[0]
const feePayer = accounts[1]

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
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [payee.address, zeroAddress, asset, deposit, salt, payer.address],
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
  expect(
    Channel.computeId({
      ...descriptor,
      chainId: chain.id,
      escrow: tip20ChannelEscrow,
    }),
  ).toBe(channelId)
  return { channelId, descriptor, deposit }
}

describe.runIf(isPrecompileTestnet)('TIP20EscrowChannel precompile chain operations', () => {
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
    const { channelId, descriptor, deposit } = await openChannel({
      deposit: 1_000n,
    })
    const additionalDeposit = uint96(750n)

    const receipt = await sendPrecompileCall(
      encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [descriptor, additionalDeposit],
      }),
    )
    const topUp = getSingleEvent(receipt, 'TopUp')
    expect(topUp.args.channelId).toBe(channelId)
    expect(topUp.args.additionalDeposit).toBe(additionalDeposit)
    expect(topUp.args.newDeposit).toBe(deposit + additionalDeposit)

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.deposit).toBe(deposit + additionalDeposit)
  })

  test('broadcastOpenTransaction broadcasts a real client-signed open transaction', async () => {
    const deposit = uint96(1_250n)
    const payload = await createOpenPayload(client, payer, {
      chainId: chain.id,
      deposit,
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    if (payload.action !== 'open') throw new Error('expected open payload')

    const transaction = Transaction.deserialize(
      payload.transaction as Transaction.TransactionSerializedTempo,
    )
    const expiringNonceHash = Channel.computeExpiringNonceHash(
      transaction as Channel.ExpiringNonceTransaction,
      { sender: payer.address },
    )

    const result = await Chain.broadcastOpenTransaction({
      chainId: chain.id,
      client,
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
      expectedChannelId: payload.channelId,
      expectedCurrency: asset,
      expectedExpiringNonceHash: expiringNonceHash,
      expectedOperator: payload.descriptor.operator,
      expectedPayee: payee.address,
      expectedPayer: payer.address,
      serializedTransaction: payload.transaction,
    })

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(isAddressEqual(result.descriptor.payer, payload.descriptor.payer)).toBe(true)
    expect(isAddressEqual(result.descriptor.payee, payload.descriptor.payee)).toBe(true)
    expect(isAddressEqual(result.descriptor.operator, payload.descriptor.operator)).toBe(true)
    expect(isAddressEqual(result.descriptor.token, payload.descriptor.token)).toBe(true)
    expect(
      isAddressEqual(result.descriptor.authorizedSigner, payload.descriptor.authorizedSigner),
    ).toBe(true)
    expect(result.descriptor.salt).toBe(payload.descriptor.salt)
    expect(result.descriptor.expiringNonceHash).toBe(payload.descriptor.expiringNonceHash)
    expect(result.expiringNonceHash).toBe(expiringNonceHash)
    expect(result.openDeposit).toBe(deposit)
    expect(result.state.deposit).toBe(deposit)
    expect(result.state.settled).toBe(0n)
    expect(result.state.closeRequestedAt).toBe(0)
  })

  test('broadcastOpenTransaction broadcasts a real fee-sponsored open transaction', async () => {
    const deposit = uint96(1_300n)
    const payload = await createOpenPayload(client, payer, {
      chainId: chain.id,
      deposit,
      feePayer: true,
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    if (payload.action !== 'open') throw new Error('expected open payload')

    const result = await Chain.broadcastOpenTransaction({
      chainId: chain.id,
      client,
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
      expectedChannelId: payload.channelId,
      expectedCurrency: asset,
      expectedExpiringNonceHash: payload.descriptor.expiringNonceHash,
      expectedOperator: payload.descriptor.operator,
      expectedPayee: payee.address,
      expectedPayer: payer.address,
      feePayer,
      serializedTransaction: payload.transaction,
    })

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.openDeposit).toBe(deposit)
    expect(result.state.deposit).toBe(deposit)
  })

  test('broadcastTopUpTransaction broadcasts a real client-signed top-up transaction', async () => {
    const opened = await createOpenPayload(client, payer, {
      chainId: chain.id,
      deposit: uint96(1_000n),
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    if (opened.action !== 'open') throw new Error('expected open payload')
    await Chain.broadcastOpenTransaction({
      chainId: chain.id,
      client,
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: opened.descriptor.authorizedSigner,
      expectedChannelId: opened.channelId,
      expectedCurrency: asset,
      expectedExpiringNonceHash: opened.descriptor.expiringNonceHash,
      expectedOperator: opened.descriptor.operator,
      expectedPayee: payee.address,
      expectedPayer: payer.address,
      serializedTransaction: opened.transaction,
    })

    const additionalDeposit = uint96(600n)
    const topUp = await createTopUpPayload(
      client,
      payer,
      opened.descriptor,
      additionalDeposit,
      chain.id,
    )
    if (topUp.action !== 'topUp') throw new Error('expected topUp payload')

    const result = await Chain.broadcastTopUpTransaction({
      additionalDeposit,
      chainId: chain.id,
      client,
      descriptor: opened.descriptor,
      escrowContract: tip20ChannelEscrow,
      expectedChannelId: opened.channelId,
      expectedCurrency: asset,
      serializedTransaction: topUp.transaction,
    })

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.newDeposit).toBe(1_600n)
    expect(result.state.deposit).toBe(1_600n)
  })

  test('broadcastTopUpTransaction broadcasts a real fee-sponsored top-up transaction', async () => {
    const opened = await createOpenPayload(client, payer, {
      chainId: chain.id,
      deposit: uint96(1_000n),
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    if (opened.action !== 'open') throw new Error('expected open payload')
    await Chain.broadcastOpenTransaction({
      chainId: chain.id,
      client,
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: opened.descriptor.authorizedSigner,
      expectedChannelId: opened.channelId,
      expectedCurrency: asset,
      expectedExpiringNonceHash: opened.descriptor.expiringNonceHash,
      expectedOperator: opened.descriptor.operator,
      expectedPayee: payee.address,
      expectedPayer: payer.address,
      serializedTransaction: opened.transaction,
    })

    const additionalDeposit = uint96(700n)
    const topUp = await createTopUpPayload(
      client,
      payer,
      opened.descriptor,
      additionalDeposit,
      chain.id,
      true,
    )
    if (topUp.action !== 'topUp') throw new Error('expected topUp payload')

    const result = await Chain.broadcastTopUpTransaction({
      additionalDeposit,
      chainId: chain.id,
      client,
      descriptor: opened.descriptor,
      escrowContract: tip20ChannelEscrow,
      expectedChannelId: opened.channelId,
      expectedCurrency: asset,
      feePayer,
      serializedTransaction: topUp.transaction,
    })

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.newDeposit).toBe(1_700n)
    expect(result.state.deposit).toBe(1_700n)
  })

  test('settles a signed voucher against the descriptor', async () => {
    const { channelId, descriptor } = await openChannel({ deposit: 1_000n })
    const cumulativeAmount = uint96(400n)
    const signature = await Voucher.signVoucher(
      client,
      payer,
      { channelId, cumulativeAmount },
      tip20ChannelEscrow,
      chain.id,
    )

    const receipt = await sendPrecompileCall(
      encodeFunctionData({
        abi: escrowAbi,
        functionName: 'settle',
        args: [descriptor, cumulativeAmount, signature],
      }),
      payee,
    )
    const settled = getSingleEvent(receipt, 'Settled')
    expect(settled.args.channelId).toBe(channelId)
    expect(settled.args.cumulativeAmount).toBe(cumulativeAmount)

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.settled).toBe(cumulativeAmount)
  })
})
