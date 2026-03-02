import { type Address, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { waitForTransactionReceipt } from 'viem/actions'
import { Addresses, Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  closeChannelOnChain,
  deployEscrow,
  openChannel,
  signOpenChannel,
  signTopUpChannel,
  topUpChannel,
} from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'
import {
  broadcastOpenTransaction,
  broadcastTopUpTransaction,
  closeOnChain,
  getOnChainChannel,
  settleOnChain,
  verifyTopUpTransaction,
} from './Chain.js'
import { signVoucher } from './Voucher.js'

const UINT128_MAX = 2n ** 128n - 1n

describe('assertUint128 (via settleOnChain / closeOnChain)', () => {
  const mockClient = { chain: { id: 42431 } } as any
  const dummyEscrow = '0x0000000000000000000000000000000000000001' as Address
  const dummyChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

  test('settleOnChain rejects amounts exceeding uint128', async () => {
    await expect(
      settleOnChain(mockClient, dummyEscrow, {
        channelId: dummyChannelId,
        cumulativeAmount: UINT128_MAX + 1n,
        signature: '0xsig' as Hex,
      }),
    ).rejects.toThrow('cumulativeAmount exceeds uint128 range')
  })

  test('settleOnChain rejects negative amounts', async () => {
    await expect(
      settleOnChain(mockClient, dummyEscrow, {
        channelId: dummyChannelId,
        cumulativeAmount: -1n,
        signature: '0xsig' as Hex,
      }),
    ).rejects.toThrow('cumulativeAmount exceeds uint128 range')
  })

  test('closeOnChain rejects amounts exceeding uint128', async () => {
    await expect(
      closeOnChain(mockClient, dummyEscrow, {
        channelId: dummyChannelId,
        cumulativeAmount: UINT128_MAX + 1n,
        signature: '0xsig' as Hex,
      }),
    ).rejects.toThrow('cumulativeAmount exceeds uint128 range')
  })

  test('closeOnChain throws when no account available', async () => {
    await expect(
      closeOnChain(mockClient, dummyEscrow, {
        channelId: dummyChannelId,
        cumulativeAmount: 1_000_000n,
        signature: '0xsig' as Hex,
      }),
    ).rejects.toThrow('no account available')
  })
})

describe('on-chain', () => {
  const payer = accounts[2]
  const recipient = accounts[0].address
  const currency = asset

  let escrowContract: Address
  let saltCounter = 0

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: payer.address, token: Addresses.pathUsd })
    await fundAccount({ address: payer.address, token: currency })
  })

  function nextSalt(): Hex {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }

  describe('getOnChainChannel', () => {
    test('reads channel state after opening', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const channel = await getOnChainChannel(client, escrowContract, channelId)

      expect(channel.deposit).toBe(deposit)
      expect(channel.finalized).toBe(false)
      expect(channel.settled).toBe(0n)
    })
  })

  describe('verifyTopUpTransaction', () => {
    test('rejects when channel is finalized', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const signature = await signVoucher(
        client,
        payer,
        { channelId, cumulativeAmount: 0n },
        escrowContract,
        chain.id,
      )

      await closeChannelOnChain({
        escrow: escrowContract,
        payee: accounts[0],
        channelId,
        cumulativeAmount: 0n,
        signature,
      })

      await expect(verifyTopUpTransaction(client, escrowContract, channelId, 0n)).rejects.toThrow(
        'channel is finalized on-chain',
      )
    })

    test('rejects when deposit did not increase', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      await expect(
        verifyTopUpTransaction(client, escrowContract, channelId, deposit),
      ).rejects.toThrow('channel deposit did not increase')
    })

    test('succeeds when deposit increased via topUp', async () => {
      const salt = nextSalt()
      const initialDeposit = 5_000_000n
      const topUpAmount = 3_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit: initialDeposit,
        salt,
      })

      await topUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUpAmount,
      })

      const result = await verifyTopUpTransaction(client, escrowContract, channelId, initialDeposit)

      expect(result.deposit).toBe(initialDeposit + topUpAmount)
    })
  })

  describe('broadcastOpenTransaction', () => {
    test('rejects when payee does not match recipient', async () => {
      const wrongPayee = accounts[3].address
      const salt = nextSalt()

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: wrongPayee,
        token: currency,
        deposit: 5_000_000n,
        salt,
      })

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction,
          escrowContract,
          channelId,
          recipient,
          currency,
        }),
      ).rejects.toThrow('open transaction payee does not match server recipient')
    })

    test('rejects when token does not match currency', async () => {
      const wrongToken = Addresses.pathUsd
      const salt = nextSalt()

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: wrongToken,
        deposit: 5_000_000n,
        salt,
      })

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction,
          escrowContract,
          channelId,
          recipient,
          currency,
        }),
      ).rejects.toThrow('open transaction token does not match server currency')
    })

    test('successful broadcast returns txHash and onChain state', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const result = await broadcastOpenTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
      })

      expect(result.txHash).toBeDefined()
      expect(result.onChain.deposit).toBe(deposit)
      expect(result.onChain.finalized).toBe(false)
    })

    test('fee-payer: rejects unauthorized calls', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const transferData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, deposit],
      })

      const deserialized = Transaction.deserialize(
        serializedTransaction as Transaction.TransactionSerializedTempo,
      )

      const tampered = (await Transaction.serialize({
        ...deserialized,
        calls: [
          ...((deserialized as any).calls ?? []),
          { to: '0x8888888888888888888888888888888888888888' as Address, data: transferData },
        ],
      } as any)) as unknown as Hex

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction: tampered,
          escrowContract,
          channelId,
          recipient,
          currency,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('fee-sponsored open transaction contains an unauthorized call')
    })

    test('fee-payer: co-signs and broadcasts successfully', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const result = await broadcastOpenTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
        feePayer: accounts[0],
      })

      expect(result.txHash).toBeDefined()
      expect(result.onChain.deposit).toBe(deposit)
    })

    test('duplicate broadcast returns fallback with txHash undefined', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      await broadcastOpenTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
      })

      const result = await broadcastOpenTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
      })

      expect(result.txHash).toBeUndefined()
      expect(result.onChain.deposit).toBe(deposit)
    })
  })

    test('waitForConfirmation: false returns derived on-chain state', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n

      const { channelId, serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const result = await broadcastOpenTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
        waitForConfirmation: false,
      })

      expect(result.txHash).toBeUndefined()
      expect(result.onChain.payer).toBe(payer.address)
      expect(result.onChain.payee).toBe(recipient)
      expect(result.onChain.token).toBe(currency)
      expect(result.onChain.deposit).toBe(deposit)
      expect(result.onChain.settled).toBe(0n)
      expect(result.onChain.finalized).toBe(false)
    })

  describe('broadcastTopUpTransaction', () => {
    test('rejects channelId mismatch', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 3_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const { serializedTransaction } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUpAmount,
      })

      const wrongChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction,
          escrowContract,
          channelId: wrongChannelId,
          currency: asset,
          declaredDeposit: topUpAmount,
          previousDeposit: deposit,
        }),
      ).rejects.toThrow('topUp transaction channelId does not match payload channelId')
    })

    test('rejects amount mismatch', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 3_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const { serializedTransaction } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUpAmount,
      })

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction,
          escrowContract,
          channelId,
          currency: asset,
          declaredDeposit: 9_999_999n,
          previousDeposit: deposit,
        }),
      ).rejects.toThrow('topUp transaction amount')
    })

    test('successful broadcast returns txHash and newDeposit', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 3_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const { serializedTransaction } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUpAmount,
      })

      const result = await broadcastTopUpTransaction({
        client,
        serializedTransaction,
        escrowContract,
        channelId,
        currency: asset,
        declaredDeposit: topUpAmount,
        previousDeposit: deposit,
      })

      expect(result.txHash).toBeDefined()
      expect(result.newDeposit).toBe(deposit + topUpAmount)
    })

    test('fee-payer: rejects unauthorized calls', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 3_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const { serializedTransaction } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUpAmount,
      })

      const transferData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, topUpAmount],
      })

      const deserialized = Transaction.deserialize(
        serializedTransaction as Transaction.TransactionSerializedTempo,
      )

      const tampered = (await Transaction.serialize({
        ...deserialized,
        calls: [
          ...((deserialized as any).calls ?? []),
          { to: '0x8888888888888888888888888888888888888888' as Address, data: transferData },
        ],
      } as any)) as unknown as Hex

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction: tampered,
          escrowContract,
          channelId,
          currency: asset,
          declaredDeposit: topUpAmount,
          previousDeposit: deposit,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('fee-sponsored topUp transaction contains an unauthorized call')
    })
  })

  describe('settleOnChain', () => {
    test('settles a channel', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n
      const settleAmount = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const signature = await signVoucher(
        client,
        payer,
        { channelId, cumulativeAmount: settleAmount },
        escrowContract,
        chain.id,
      )

      const txHash = await settleOnChain(client, escrowContract, {
        channelId,
        cumulativeAmount: settleAmount,
        signature,
      })

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.settled).toBe(settleAmount)
      expect(channel.finalized).toBe(false)
    })

    test('settles a channel with fee payer', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n
      const settleAmount = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const signature = await signVoucher(
        client,
        payer,
        { channelId, cumulativeAmount: settleAmount },
        escrowContract,
        chain.id,
      )

      const txHash = await settleOnChain(
        client,
        escrowContract,
        {
          channelId,
          cumulativeAmount: settleAmount,
          signature,
        },
        accounts[0],
      )

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.settled).toBe(settleAmount)
      expect(channel.finalized).toBe(false)
    })
  })

  describe('closeOnChain', () => {
    test('closes a channel', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n
      const closeAmount = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const signature = await signVoucher(
        client,
        payer,
        { channelId, cumulativeAmount: closeAmount },
        escrowContract,
        chain.id,
      )

      const txHash = await closeOnChain(client, escrowContract, {
        channelId,
        cumulativeAmount: closeAmount,
        signature,
      })

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.finalized).toBe(true)
    })

    test('closes a channel with fee payer', async () => {
      const salt = nextSalt()
      const deposit = 10_000_000n
      const closeAmount = 5_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const signature = await signVoucher(
        client,
        payer,
        { channelId, cumulativeAmount: closeAmount },
        escrowContract,
        chain.id,
      )

      const txHash = await closeOnChain(
        client,
        escrowContract,
        {
          channelId,
          cumulativeAmount: closeAmount,
          signature,
        },
        undefined,
        accounts[0],
      )

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.finalized).toBe(true)
    })
  })
}) // end describe('on-chain')
