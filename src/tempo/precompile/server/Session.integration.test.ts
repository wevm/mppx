import { Hex } from 'ox'
import { parseEventLogs, zeroAddress } from 'viem'
import { sendTransaction, waitForTransactionReceipt } from 'viem/actions'
import { describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { accounts, asset, chain, client } from '~test/tempo/viem.js'

import * as Store from '../../../Store.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import {
  createCloseCredential,
  createOpen,
  createOpenCredential,
  createTopUp,
  createTopUpCredential,
  createVoucherCredential,
} from '../client/ChannelOps.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import { uint96 } from '../Types.js'
import { session, settle } from './Session.js'

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

async function openRealChannel(deposit = 1_000n) {
  const salt = Hex.random(32)
  const receipt = await sendPrecompileCall(
    Chain.encodeOpen({
      payee: payee.address,
      operator: zeroAddress,
      token: asset,
      deposit: uint96(deposit),
      salt,
      authorizedSigner: payer.address,
    }),
  )
  const opened = getSingleEvent(receipt, 'ChannelOpened')
  const descriptor = {
    payer: payer.address,
    payee: payee.address,
    operator: zeroAddress,
    token: asset,
    salt,
    authorizedSigner: payer.address,
    expiringNonceHash: opened.args.expiringNonceHash as Hex.Hex,
  } satisfies Channel.ChannelDescriptor
  const channelId = opened.args.channelId as Hex.Hex
  expect(Channel.computeId(descriptor, { chainId: chain.id, escrow: tip20ChannelEscrow })).toBe(
    channelId,
  )
  return { channelId, descriptor, deposit: uint96(deposit) }
}

describe.runIf(isPrecompileTestnet)('precompile server session chain integration', () => {
  test('broadcasts and verifies a real precompile open credential', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const method = session({
      amount: '100',
      chainId: chain.id,
      currency: asset,
      decimals: 0,
      recipient: payee.address,
      store: rawStore,
      unitType: 'request',
      getClient: () => client,
    })
    const open = await createOpen(client, payer, {
      chainId: chain.id,
      deposit: uint96(1_000n),
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    const payload = createOpenCredential(open, uint96(100n))

    const receipt = await method.verify({
      credential: {
        challenge: {
          id: 'chain-open-challenge',
          realm: 'api.example.com',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '100',
            currency: asset,
            recipient: payee.address,
            methodDetails: {
              chainId: chain.id,
              escrowContract: tip20ChannelEscrow,
              channelId: payload.channelId,
            },
          },
        } as never,
        payload,
      },
      request: {
        amount: '100',
        currency: asset,
        recipient: payee.address,
        methodDetails: {
          chainId: chain.id,
          escrowContract: tip20ChannelEscrow,
          channelId: payload.channelId,
        },
      } as never,
    })

    expect(receipt.reference).toBe(payload.channelId)
    if (!('txHash' in receipt)) throw new Error('expected open txHash')
    const txReceipt = await waitForTransactionReceipt(client, { hash: receipt.txHash as Hex.Hex })
    const opened = getSingleEvent(txReceipt, 'ChannelOpened')
    expect(opened.args.channelId).toBe(payload.channelId)
    expect(opened.args.expiringNonceHash).toBe(payload.descriptor.expiringNonceHash)
    const state = await Chain.getChannelState(client, payload.channelId, tip20ChannelEscrow)
    expect(state.deposit).toBe(1_000n)
    const stored = await store.getChannel(payload.channelId)
    expect(stored?.backend).toBe('precompile')
    expect(stored?.highestVoucherAmount).toBe(100n)
  })

  test('broadcasts top-up credentials and stores event-backed deposit', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const method = session({
      amount: '100',
      chainId: chain.id,
      currency: asset,
      decimals: 0,
      recipient: payee.address,
      store: rawStore,
      unitType: 'request',
      getClient: () => client,
    })
    const open = await createOpen(client, payer, {
      chainId: chain.id,
      deposit: uint96(500n),
      initialAmount: uint96(100n),
      payee: payee.address,
      token: asset,
    })
    const openPayload = createOpenCredential(open, uint96(100n))
    await method.verify({
      credential: {
        challenge: {
          id: 'chain-topup-open',
          request: { currency: asset, recipient: payee.address },
        } as never,
        payload: openPayload,
      },
      request: {
        methodDetails: {
          chainId: chain.id,
          escrowContract: tip20ChannelEscrow,
          channelId: openPayload.channelId,
        },
      } as never,
    })

    const topUp = await createTopUp(client, payer, {
      additionalDeposit: uint96(700n),
      chainId: chain.id,
      descriptor: open.descriptor,
    })
    const topUpPayload = createTopUpCredential(topUp, uint96(700n))
    const receipt = await method.verify({
      credential: {
        challenge: {
          id: 'chain-topup',
          request: { currency: asset, recipient: payee.address },
        } as never,
        payload: topUpPayload,
      },
      request: {
        methodDetails: {
          chainId: chain.id,
          escrowContract: tip20ChannelEscrow,
          channelId: topUpPayload.channelId,
        },
      } as never,
    })

    if (!('txHash' in receipt)) throw new Error('expected topUp txHash')
    const txReceipt = await waitForTransactionReceipt(client, { hash: receipt.txHash as Hex.Hex })
    const toppedUp = getSingleEvent(txReceipt, 'TopUp')
    expect(toppedUp.args.channelId).toBe(openPayload.channelId)
    expect(toppedUp.args.newDeposit).toBe(1_200n)
    const state = await Chain.getChannelState(client, openPayload.channelId, tip20ChannelEscrow)
    expect(state.deposit).toBe(1_200n)
    const stored = await store.getChannel(openPayload.channelId)
    expect(stored?.deposit).toBe(1_200n)
    expect(stored?.closeRequestedAt).toBe(0n)
  })

  test('verifies vouchers and settles against a real precompile channel', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const { channelId, descriptor, deposit } = await openRealChannel(1_000n)

    await store.updateChannel(channelId, () => ({
      backend: 'precompile',
      channelId,
      chainId: chain.id,
      escrowContract: tip20ChannelEscrow,
      closeRequestedAt: 0n,
      payer: descriptor.payer,
      payee: descriptor.payee,
      token: descriptor.token,
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      settledOnChain: 0n,
      highestVoucherAmount: 0n,
      highestVoucher: null,
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
      descriptor,
      operator: descriptor.operator,
      salt: descriptor.salt,
      expiringNonceHash: descriptor.expiringNonceHash,
    }))

    const method = session({
      amount: '100',
      chainId: chain.id,
      currency: asset,
      decimals: 0,
      recipient: payee.address,
      store: rawStore,
      unitType: 'request',
      getClient: () => client,
    })
    const payload = await createVoucherCredential(client, payer, {
      chainId: chain.id,
      cumulativeAmount: uint96(300n),
      descriptor,
      escrow: tip20ChannelEscrow,
    })

    const receipt = await method.verify({
      credential: {
        challenge: {
          id: 'chain-challenge',
          realm: 'api.example.com',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '100',
            currency: asset,
            recipient: payee.address,
            methodDetails: { chainId: chain.id, escrowContract: tip20ChannelEscrow, channelId },
          },
        } as never,
        payload,
      },
      request: {
        amount: '100',
        currency: asset,
        recipient: payee.address,
        methodDetails: { chainId: chain.id, escrowContract: tip20ChannelEscrow, channelId },
      } as never,
    })
    expect(receipt.reference).toBe(channelId)

    const txHash = await settle(store, client, channelId)
    const settleReceipt = await waitForTransactionReceipt(client, { hash: txHash })
    expect(settleReceipt.status).toBe('success')
    const settled = getSingleEvent(settleReceipt, 'Settled')
    expect(settled.args.channelId).toBe(channelId)
    expect(settled.args.newSettled).toBe(300n)

    const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
    expect(state.settled).toBe(300n)
    const settledStore = await store.getChannel(channelId)
    expect(settledStore?.settledOnChain).toBe(300n)
  })

  test('settles a real precompile channel with fee-payer sponsorship', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const { channelId, descriptor, deposit } = await openRealChannel(1_000n)

    const voucher = await createVoucherCredential(client, payer, {
      chainId: chain.id,
      cumulativeAmount: uint96(250n),
      descriptor,
      escrow: tip20ChannelEscrow,
    })
    await store.updateChannel(channelId, () => ({
      backend: 'precompile',
      channelId,
      chainId: chain.id,
      escrowContract: tip20ChannelEscrow,
      closeRequestedAt: 0n,
      payer: descriptor.payer,
      payee: descriptor.payee,
      token: descriptor.token,
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      settledOnChain: 0n,
      highestVoucherAmount: 250n,
      highestVoucher: {
        channelId,
        cumulativeAmount: 250n,
        signature: voucher.signature,
      },
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
      descriptor,
      operator: descriptor.operator,
      salt: descriptor.salt,
      expiringNonceHash: descriptor.expiringNonceHash,
    }))

    const txHash = await settle(store, client, channelId, {
      account: payee,
      feePayer,
      feeToken: asset,
    })
    const receipt = await waitForTransactionReceipt(client, { hash: txHash })
    expect(receipt.status).toBe('success')
    const settled = getSingleEvent(receipt, 'Settled')
    expect(settled.args.channelId).toBe(channelId)
    expect(settled.args.newSettled).toBe(250n)
  })

  test('closes a real precompile channel with fee-payer sponsorship', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const { channelId, descriptor, deposit } = await openRealChannel(1_000n)
    await store.updateChannel(channelId, () => ({
      backend: 'precompile',
      channelId,
      chainId: chain.id,
      escrowContract: tip20ChannelEscrow,
      closeRequestedAt: 0n,
      payer: descriptor.payer,
      payee: descriptor.payee,
      token: descriptor.token,
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      settledOnChain: 0n,
      highestVoucherAmount: 300n,
      highestVoucher: null,
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
      descriptor,
      operator: descriptor.operator,
      salt: descriptor.salt,
      expiringNonceHash: descriptor.expiringNonceHash,
    }))
    const method = session({
      account: payee,
      amount: '100',
      chainId: chain.id,
      currency: asset,
      decimals: 0,
      feePayer,
      feeToken: asset,
      recipient: payee.address,
      store: rawStore,
      unitType: 'request',
      getClient: () => client,
    })
    const payload = await createCloseCredential(client, payer, {
      chainId: chain.id,
      cumulativeAmount: uint96(300n),
      descriptor,
      escrow: tip20ChannelEscrow,
    })

    const receipt = await method.verify({
      credential: {
        challenge: {
          id: 'chain-sponsored-close',
          request: { currency: asset, recipient: payee.address },
        } as never,
        payload,
      },
      request: {
        methodDetails: { chainId: chain.id, escrowContract: tip20ChannelEscrow, channelId },
      } as never,
    })
    if (!('txHash' in receipt)) throw new Error('expected sponsored close txHash')
    const closeReceipt = await waitForTransactionReceipt(client, {
      hash: receipt.txHash as Hex.Hex,
    })
    expect(closeReceipt.status).toBe('success')
    const closed = getSingleEvent(closeReceipt, 'ChannelClosed')
    expect(closed.args.channelId).toBe(channelId)
    expect(closed.args.settledToPayee).toBe(300n)
  })

  test('closes a real precompile channel only after a successful close receipt', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const { channelId, descriptor, deposit } = await openRealChannel(1_000n)

    await store.updateChannel(channelId, () => ({
      backend: 'precompile',
      channelId,
      chainId: chain.id,
      escrowContract: tip20ChannelEscrow,
      closeRequestedAt: 0n,
      payer: descriptor.payer,
      payee: descriptor.payee,
      token: descriptor.token,
      authorizedSigner: descriptor.authorizedSigner,
      deposit,
      settledOnChain: 0n,
      highestVoucherAmount: 300n,
      highestVoucher: null,
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
      descriptor,
      operator: descriptor.operator,
      salt: descriptor.salt,
      expiringNonceHash: descriptor.expiringNonceHash,
    }))

    const method = session({
      amount: '100',
      chainId: chain.id,
      currency: asset,
      decimals: 0,
      recipient: payee.address,
      store: rawStore,
      unitType: 'request',
      getClient: () => client,
    })
    const payload = await createCloseCredential(client, payer, {
      chainId: chain.id,
      cumulativeAmount: uint96(300n),
      descriptor,
      escrow: tip20ChannelEscrow,
    })

    const receipt = await method.verify({
      credential: {
        challenge: {
          id: 'chain-close',
          realm: 'api.example.com',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '100',
            currency: asset,
            recipient: payee.address,
            methodDetails: { chainId: chain.id, escrowContract: tip20ChannelEscrow, channelId },
          },
        } as never,
        payload,
      },
      request: {
        amount: '100',
        currency: asset,
        recipient: payee.address,
        methodDetails: { chainId: chain.id, escrowContract: tip20ChannelEscrow, channelId },
      } as never,
    })

    if (!('txHash' in receipt)) throw new Error('expected close txHash')
    const closeReceipt = await waitForTransactionReceipt(client, {
      hash: receipt.txHash as Hex.Hex,
    })
    expect(closeReceipt.status).toBe('success')
    const closed = getSingleEvent(closeReceipt, 'ChannelClosed')
    expect(closed.args.channelId).toBe(channelId)
    expect(closed.args.settledToPayee).toBe(300n)
    const stored = await store.getChannel(channelId)
    expect(stored?.finalized).toBe(true)
    expect(stored?.settledOnChain).toBe(300n)
  })
})
