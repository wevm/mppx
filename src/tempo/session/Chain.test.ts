import {
  type Address,
  createClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  zeroAddress,
} from 'viem'
import { prepareTransactionRequest, signTransaction, waitForTransactionReceipt } from 'viem/actions'
import { Addresses, Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
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
  escrowAbi,
  getOnChainChannel,
  settleOnChain,
  verifyTopUpTransaction,
} from './Chain.js'
import * as Channel from './Channel.js'
import { signVoucher } from './Voucher.js'

const isLocalnet = nodeEnv === 'localnet'

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

describe.runIf(isLocalnet)('on-chain', () => {
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

    test('rejects when transaction channelId does not match claimed channelId', async () => {
      const salt = nextSalt()

      const { serializedTransaction } = await signOpenChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit: 5_000_000n,
        salt,
      })

      const fakeChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction,
          escrowContract,
          channelId: fakeChannelId,
          recipient,
          currency,
        }),
      ).rejects.toThrow('open transaction does not match claimed channelId')
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

    test('fee-payer: rejects unsigned transaction', async () => {
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

      // Strip the sender signature to simulate the POC attack
      const deserialized = Transaction.deserialize(
        serializedTransaction as Transaction.TransactionSerializedTempo,
      )
      const unsigned = await Transaction.serialize({
        ...deserialized,
        signature: undefined,
        from: undefined,
      })

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction: unsigned,
          escrowContract,
          channelId,
          recipient,
          currency,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('Transaction must be signed by the sender before fee payer co-signing')
    })

    test('fee-payer: rejects non-Tempo transaction', async () => {
      const fakeEip1559 =
        '0x02f8650182a5bf843b9aca00843b9aca008252089400000000000000000000000000000000000000008080c001a00000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000' as Hex

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction: fakeEip1559,
          escrowContract,
          channelId: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
          recipient,
          currency,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('Only Tempo (0x76/0x78) transactions are supported')
    })

    test('fee-payer: rejects transactions whose gas budget exceeds sponsor policy', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, deposit],
      })
      const openData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'open',
        args: [recipient, currency, deposit, salt, zeroAddress],
      })

      const channelId = Channel.computeId({
        authorizedSigner: zeroAddress,
        chainId: chain.id,
        escrowContract,
        payee: recipient,
        payer: payer.address,
        salt,
        token: currency,
      }) as Hex

      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: openData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = 2_000_001n

      const serializedTransaction = await signTransaction(client, prepared as never)

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction: serializedTransaction as Hex,
          escrowContract,
          channelId,
          recipient,
          currency,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('gas exceeds sponsor policy')
    })

    test('fee-payer: simulates open before broadcasting', async () => {
      const rpcMethods: string[] = []
      const interceptingClient = createClient({
        account: accounts[0],
        chain: client.chain,
        transport: custom({
          async request(args: any) {
            rpcMethods.push(args.method)
            return client.transport.request(args)
          },
        }),
      })

      const salt = nextSalt()
      const deposit = 5_000_000n
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, deposit],
      })
      const openData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'open',
        args: [recipient, currency, deposit, salt, zeroAddress],
      })
      const channelId = Channel.computeId({
        authorizedSigner: zeroAddress,
        chainId: chain.id,
        escrowContract,
        payee: recipient,
        payer: payer.address,
        salt,
        token: currency,
      }) as Hex
      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: openData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = prepared.gas! + 5_000n
      const serializedTransaction = await signTransaction(client, prepared as never)

      await broadcastOpenTransaction({
        client: interceptingClient,
        serializedTransaction,
        escrowContract,
        channelId,
        recipient,
        currency,
        feePayer: accounts[0],
      })

      const broadcastIndex = rpcMethods.indexOf('eth_sendRawTransactionSync')
      const simulationIndex = rpcMethods.indexOf('eth_call')

      expect(broadcastIndex).toBeGreaterThan(-1)
      expect(simulationIndex).toBeGreaterThan(-1)
      expect(simulationIndex).toBeLessThan(broadcastIndex)
    })

    test('fee-payer: rejects smuggled second open call', async () => {
      const deposit = 5_000_000n
      const smuggledDeposit = 7_000_000n
      const salt = nextSalt()
      const smuggledSalt = nextSalt()

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, deposit + smuggledDeposit],
      })
      const openData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'open',
        args: [recipient, currency, deposit, salt, zeroAddress],
      })
      const smuggledOpenData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'open',
        args: [accounts[3].address, currency, smuggledDeposit, smuggledSalt, zeroAddress],
      })

      const channelId = Channel.computeId({
        authorizedSigner: zeroAddress,
        chainId: chain.id,
        escrowContract,
        payee: recipient,
        payer: payer.address,
        salt,
        token: currency,
      }) as Hex

      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: openData },
          { to: escrowContract, data: smuggledOpenData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = prepared.gas! + 5_000n

      const serializedTransaction = await signTransaction(client, prepared as never)

      await expect(
        broadcastOpenTransaction({
          client,
          serializedTransaction: serializedTransaction as Hex,
          escrowContract,
          channelId,
          recipient,
          currency,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('fee-sponsored open transaction contains a smuggled call')
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

      expect(result.txHash).toBeDefined()
      expect(result.onChain.payer.toLowerCase()).toBe(payer.address.toLowerCase())
      expect(result.onChain.payee.toLowerCase()).toBe(recipient.toLowerCase())
      expect(result.onChain.token.toLowerCase()).toBe(currency.toLowerCase())
      expect(result.onChain.deposit).toBe(deposit)
      expect(result.onChain.settled).toBe(0n)
      expect(result.onChain.finalized).toBe(false)
    })
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

    test('rejects when post-broadcast deposit does not exceed declared previousDeposit', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 1_000_000n

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
          declaredDeposit: topUpAmount,
          previousDeposit: deposit + topUpAmount,
        }),
      ).rejects.toThrow('channel deposit did not increase after topUp')
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

    test('fee-payer: rejects unsigned transaction', async () => {
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

      // Strip the sender signature to simulate the POC attack
      const deserialized = Transaction.deserialize(
        serializedTransaction as Transaction.TransactionSerializedTempo,
      )
      const unsigned = await Transaction.serialize({
        ...deserialized,
        signature: undefined,
        from: undefined,
      })

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction: unsigned,
          escrowContract,
          channelId,
          currency: asset,
          declaredDeposit: topUpAmount,
          previousDeposit: deposit,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('Transaction must be signed by the sender before fee payer co-signing')
    })

    test('fee-payer: rejects non-Tempo transaction', async () => {
      const fakeEip1559 =
        '0x02f8650182a5bf843b9aca00843b9aca008252089400000000000000000000000000000000000000008080c001a00000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000' as Hex

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction: fakeEip1559,
          escrowContract,
          channelId: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
          currency: asset,
          declaredDeposit: 1_000_000n,
          previousDeposit: 0n,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('Only Tempo (0x76/0x78) transactions are supported')
    })

    test('fee-payer: rejects topUp transactions whose gas budget exceeds sponsor policy', async () => {
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

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, topUpAmount],
      })
      const topUpData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [channelId, topUpAmount],
      })

      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: topUpData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = 2_000_001n

      const serializedTransaction = await signTransaction(client, prepared as never)

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction: serializedTransaction as Hex,
          escrowContract,
          channelId,
          currency: asset,
          declaredDeposit: topUpAmount,
          previousDeposit: deposit,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('gas exceeds sponsor policy')
    })

    test('fee-payer: simulates topUp before broadcasting', async () => {
      const rpcMethods: string[] = []
      const interceptingClient = createClient({
        account: accounts[0],
        chain: client.chain,
        transport: custom({
          async request(args: any) {
            rpcMethods.push(args.method)
            return client.transport.request(args)
          },
        }),
      })

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

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, topUpAmount],
      })
      const topUpData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [channelId, topUpAmount],
      })
      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: topUpData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = prepared.gas! + 5_000n
      const serializedTransaction = await signTransaction(client, prepared as never)

      await broadcastTopUpTransaction({
        client: interceptingClient,
        serializedTransaction,
        escrowContract,
        channelId,
        currency: asset,
        declaredDeposit: topUpAmount,
        previousDeposit: deposit,
        feePayer: accounts[0],
      })

      const broadcastIndex = rpcMethods.indexOf('eth_sendRawTransactionSync')
      const simulationIndex = rpcMethods.indexOf('eth_call')

      expect(broadcastIndex).toBeGreaterThan(-1)
      expect(simulationIndex).toBeGreaterThan(-1)
      expect(simulationIndex).toBeLessThan(broadcastIndex)
    })

    test('fee-payer: rejects smuggled second topUp call', async () => {
      const salt = nextSalt()
      const deposit = 5_000_000n
      const topUpAmount = 3_000_000n
      const smuggledAmount = 4_000_000n

      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee: recipient,
        token: currency,
        deposit,
        salt,
      })

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [escrowContract, topUpAmount + smuggledAmount],
      })
      const topUpData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [channelId, topUpAmount],
      })
      const smuggledTopUpData = encodeFunctionData({
        abi: escrowAbi,
        functionName: 'topUp',
        args: [channelId, smuggledAmount],
      })

      const prepared = await prepareTransactionRequest(client, {
        account: payer,
        calls: [
          { to: currency, data: approveData },
          { to: escrowContract, data: topUpData },
          { to: escrowContract, data: smuggledTopUpData },
        ],
        feePayer: true,
        feeToken: currency,
      } as never)
      prepared.gas = prepared.gas! + 5_000n

      const serializedTransaction = await signTransaction(client, prepared as never)

      await expect(
        broadcastTopUpTransaction({
          client,
          serializedTransaction: serializedTransaction as Hex,
          escrowContract,
          channelId,
          currency: asset,
          declaredDeposit: topUpAmount,
          previousDeposit: deposit,
          feePayer: accounts[0],
        }),
      ).rejects.toThrow('fee-sponsored topUp transaction contains a smuggled call')
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

    test.todo('settles with distinct feePayer != account (fee-sponsored settle)')

    test('settles with explicit account (no fee payer)', async () => {
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

      // Pass account explicitly — should use it as sender instead of client.account
      const txHash = await settleOnChain(
        client,
        escrowContract,
        {
          channelId,
          cumulativeAmount: settleAmount,
          signature,
        },
        { account: accounts[0] },
      )

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.settled).toBe(settleAmount)
      expect(channel.finalized).toBe(false)
    })

    test('throws when no account available', async () => {
      const noAccountClient = { chain: { id: 42431 } } as any
      const dummyEscrow = '0x0000000000000000000000000000000000000001' as Address
      const dummyChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

      await expect(
        settleOnChain(noAccountClient, dummyEscrow, {
          channelId: dummyChannelId,
          cumulativeAmount: 1_000_000n,
          signature: '0xsig' as Hex,
        }),
      ).rejects.toThrow('no account available')
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

    test.todo('closes with distinct feePayer != account (fee-sponsored close)')

    test('closes with explicit account (no fee payer)', async () => {
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

      // Pass account explicitly — should use it as sender instead of client.account
      const txHash = await closeOnChain(
        client,
        escrowContract,
        {
          channelId,
          cumulativeAmount: closeAmount,
          signature,
        },
        { account: accounts[0] },
      )

      expect(txHash).toBeDefined()
      await waitForTransactionReceipt(client, { hash: txHash })
      const channel = await getOnChainChannel(client, escrowContract, channelId)
      expect(channel.finalized).toBe(true)
    })
  })
}) // end describe('on-chain')
