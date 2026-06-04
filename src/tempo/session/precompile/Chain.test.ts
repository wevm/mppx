import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  maxUint256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import { VerificationFailedError } from '../../../Errors.js'
import * as ServerChannelOps from '../server/ChannelOps.js'
import * as Chain from './Chain.js'
import * as Channel from './Channel.js'
import { escrowAbi } from './escrow.abi.js'
import { tip20ChannelEscrow } from './Protocol.js'
import * as Types from './Protocol.js'

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
const chainId = 42431
const txHash = `0x${'ab'.repeat(32)}` as const
const feePayer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389d1fc6e60e7346d6c36c49d32f75b9a1b',
)
const mockFeePayer = {
  ...feePayer,
  async signTransaction() {
    return `0x76${'00'.repeat(32)}` as `0x${string}`
  },
}

function createMockClient(
  parameters: {
    channel?: { descriptor: Channel.ChannelDescriptor; state: Chain.ChannelState } | undefined
    receipt?: Record<string, unknown> | null | undefined
    rpcMethods?: string[] | undefined
  } = {},
) {
  return createClient({
    account: feePayer,
    chain: { id: chainId } as never,
    transport: custom({
      async request(args) {
        parameters.rpcMethods?.push(args.method)
        if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (args.method === 'eth_sendRawTransaction') return txHash
        if (args.method === 'eth_sendRawTransactionSync') return parameters.receipt ?? receipt([])
        if (args.method === 'eth_getTransactionReceipt') return parameters.receipt ?? null
        if (args.method === 'eth_call') {
          const data = (args.params as [{ data?: `0x${string}` }])[0].data
          const channel = parameters.channel
          if (!channel || !data) return '0x'
          const selector = data.slice(0, 10)
          const getChannelSelector = encodeFunctionData({
            abi: escrowAbi,
            functionName: 'getChannel',
            args: [channel.descriptor],
          }).slice(0, 10)
          if (selector === getChannelSelector)
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'getChannel',
              result: { descriptor: channel.descriptor, state: channel.state },
            })
          return encodeFunctionResult({
            abi: escrowAbi,
            functionName: 'getChannelState',
            result: channel.state,
          })
        }
        throw new Error(`unexpected rpc request: ${args.method}`)
      },
    }),
  })
}

function receipt(logs: readonly Record<string, unknown>[]) {
  return {
    blockHash: `0x${'01'.repeat(32)}`,
    blockNumber: '0x1',
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    from: descriptor.payer,
    gasUsed: '0x1',
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    to: tip20ChannelEscrow,
    transactionHash: txHash,
    transactionIndex: '0x0',
    type: '0x76',
  }
}

function openedLog(parameters: {
  channelId: `0x${string}`
  expiringNonceHash: `0x${string}`
  deposit?: bigint | undefined
}) {
  return {
    address: tip20ChannelEscrow,
    data: encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint96' },
      ],
      [
        descriptor.operator,
        descriptor.token,
        descriptor.authorizedSigner,
        descriptor.salt,
        parameters.expiringNonceHash,
        parameters.deposit ?? deposit,
      ],
    ),
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: 'ChannelOpened',
      args: { channelId: parameters.channelId, payer: descriptor.payer, payee: descriptor.payee },
    }),
  }
}

function topUpLog(parameters: { channelId: `0x${string}`; newDeposit: bigint }) {
  return {
    address: tip20ChannelEscrow,
    data: encodeAbiParameters(
      [{ type: 'uint96' }, { type: 'uint96' }],
      [deposit, parameters.newDeposit],
    ),
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: 'TopUp',
      args: { channelId: parameters.channelId, payer: descriptor.payer, payee: descriptor.payee },
    }),
  }
}

async function createSerializedTransaction(parameters: {
  calls: { to: `0x${string}`; data?: `0x${string}` | undefined }[]
  gas?: bigint | undefined
  signed?: boolean | undefined
}) {
  return (await Transaction.serialize({
    chainId,
    calls: parameters.calls,
    feeToken: descriptor.token,
    nonce: 0,
    ...(parameters.gas !== undefined ? { gas: parameters.gas } : {}),
    ...(parameters.signed
      ? {
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          nonceKey: maxUint256,
          validBefore: Math.floor(Date.now() / 1_000) + 600,
        }
      : {}),
    ...(parameters.signed
      ? {
          signature: {
            r: `0x${'01'.repeat(32)}` as `0x${string}`,
            s: `0x${'02'.repeat(32)}` as `0x${string}`,
            yParity: 0,
          },
        }
      : {}),
  } as never)) as `0x${string}`
}

async function createOpenTransaction(
  parameters: {
    authorizedSigner?: `0x${string}` | undefined
    gas?: bigint | undefined
    operator?: `0x${string}` | undefined
    payee?: `0x${string}` | undefined
    signed?: boolean | undefined
    token?: `0x${string}` | undefined
    to?: `0x${string}` | undefined
  } = {},
) {
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [
      parameters.payee ?? descriptor.payee,
      parameters.operator ?? descriptor.operator,
      parameters.token ?? descriptor.token,
      deposit,
      descriptor.salt,
      parameters.authorizedSigner ?? descriptor.authorizedSigner,
    ],
  })
  return createSerializedTransaction({
    calls: [{ to: parameters.to ?? tip20ChannelEscrow, data }],
    gas: parameters.gas,
    signed: parameters.signed,
  })
}

async function createTopUpTransaction(
  parameters: {
    additionalDeposit?: bigint | undefined
    descriptor_?: Channel.ChannelDescriptor | undefined
    gas?: bigint | undefined
    signed?: boolean | undefined
    to?: `0x${string}` | undefined
  } = {},
) {
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'topUp',
    args: [
      parameters.descriptor_ ?? descriptor,
      Types.uint96(parameters.additionalDeposit ?? deposit),
    ],
  })
  return createSerializedTransaction({
    calls: [{ to: parameters.to ?? tip20ChannelEscrow, data }],
    gas: parameters.gas,
    signed: parameters.signed,
  })
}

function expectedExpiringNonceHash(serializedTransaction: `0x${string}`) {
  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  return Channel.computeExpiringNonceHash(
    Channel.transactionForExpiringNonceHash({ transaction }),
    { sender: descriptor.payer },
  )
}

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

describe('precompile broadcastOpenTransaction', () => {
  test('rejects transactions with extra calls', async () => {
    const serializedTransaction = await createSerializedTransaction({
      calls: [
        {
          to: tip20ChannelEscrow,
          data: encodeFunctionData({
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
          }),
        },
        {
          to: descriptor.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [tip20ChannelEscrow, deposit],
          }),
        },
      ],
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: `0x${'aa'.repeat(32)}`,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 open transaction must contain exactly one call')
  })

  test('rejects open transactions targeting the wrong escrow contract', async () => {
    const serializedTransaction = await createOpenTransaction({ to: descriptor.token })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expectedExpiringNonceHash(serializedTransaction),
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 open transaction targets the wrong address')
  })

  test('rejects open transactions missing calldata', async () => {
    const serializedTransaction = await createSerializedTransaction({
      calls: [{ to: tip20ChannelEscrow }],
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expectedExpiringNonceHash(serializedTransaction),
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 open transaction is missing calldata')
  })

  test('rejects open calldata mismatches before broadcasting', async () => {
    const serializedTransaction = await createOpenTransaction({ payee: zeroAddress })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expectedExpiringNonceHash(serializedTransaction),
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('payee does not match')
  })

  test('fee-payer rejects non-Tempo open transactions', async () => {
    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: `0x${'aa'.repeat(32)}`,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        feePayer: { address: descriptor.payee } as never,
        serializedTransaction: '0x1234',
      }),
    ).rejects.toThrow('Only Tempo (0x76/0x78) transactions are supported')
  })

  test('fee-payer rejects unsigned open transactions', async () => {
    const serializedTransaction = await createOpenTransaction()
    const expiringNonceHash = expectedExpiringNonceHash(serializedTransaction)
    const expectedDescriptor = { ...descriptor, expiringNonceHash }
    const channelId = Channel.computeId({
      ...expectedDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: channelId,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expiringNonceHash,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        feePayer: { address: descriptor.payee } as never,
        serializedTransaction,
      }),
    ).rejects.toThrow('Transaction must be signed by the sender before fee payer co-signing')
  })

  test('fee-payer rejects open transactions whose gas budget exceeds sponsor policy', async () => {
    const serializedTransaction = await createOpenTransaction({ gas: 2_000_001n, signed: true })
    const transaction = Transaction.deserialize(
      serializedTransaction as Transaction.TransactionSerializedTempo,
    )
    const payer = transaction.from!
    const expiringNonceHash = Channel.computeExpiringNonceHash(
      Channel.transactionForExpiringNonceHash({ feePayer, transaction }),
      { sender: payer },
    )
    const expectedDescriptor = { ...descriptor, payer, expiringNonceHash }
    const channelId = Channel.computeId({
      ...expectedDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: channelId,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expiringNonceHash,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: payer,
        feePayer,
        feePayerPolicy: { maxGas: 2_000_000n },
        serializedTransaction,
      }),
    ).rejects.toThrow('fee-sponsored transaction gas exceeds sponsor policy')
  })

  test('fee-payer simulates open before raw broadcast', async () => {
    const rpcMethods: string[] = []
    const serializedTransaction = await createOpenTransaction({ gas: 100_000n, signed: true })
    const transaction = Transaction.deserialize(
      serializedTransaction as Transaction.TransactionSerializedTempo,
    )
    const payer = transaction.from!
    const expiringNonceHash = Channel.computeExpiringNonceHash(
      Channel.transactionForExpiringNonceHash({ feePayer, transaction }),
      { sender: payer },
    )
    const expectedDescriptor = { ...descriptor, payer, expiringNonceHash }
    const channelId = Channel.computeId({
      ...expectedDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })
    const state = { settled: 0n, deposit, closeRequestedAt: 0 }

    await Chain.broadcastOpenTransaction({
      chainId,
      client: createMockClient({
        channel: { descriptor: expectedDescriptor, state },
        receipt: receipt([openedLog({ channelId, expiringNonceHash })]),
        rpcMethods,
      }),
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: descriptor.authorizedSigner,
      expectedChannelId: channelId,
      expectedCurrency: descriptor.token,
      expectedExpiringNonceHash: expiringNonceHash,
      expectedOperator: descriptor.operator,
      expectedPayee: descriptor.payee,
      expectedPayer: payer,
      feePayer: mockFeePayer,
      serializedTransaction,
    })

    const broadcastIndex = rpcMethods.indexOf('eth_sendRawTransactionSync')
    const simulationIndex = rpcMethods.indexOf('eth_call')
    expect(broadcastIndex).toBeGreaterThan(-1)
    expect(simulationIndex).toBeGreaterThan(-1)
    expect(simulationIndex).toBeLessThan(broadcastIndex)
  })

  test('rejects expiring nonce hash mismatches before broadcasting', async () => {
    const serializedTransaction = await createOpenTransaction()

    const wrongExpiringNonceHash = `0x${'bb'.repeat(32)}` as const
    const expectedChannelId = Channel.computeId({
      ...descriptor,
      chainId,
      escrow: tip20ChannelEscrow,
      expiringNonceHash: wrongExpiringNonceHash,
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient(),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: wrongExpiringNonceHash,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('credential expiringNonceHash does not match transaction')
  })

  test('returns tx hash, descriptor, event fields, and read-back state on success', async () => {
    const serializedTransaction = await createOpenTransaction()
    const expiringNonceHash = expectedExpiringNonceHash(serializedTransaction)
    const expectedDescriptor = { ...descriptor, expiringNonceHash }
    const channelId = Channel.computeId({
      ...expectedDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })
    const state = { settled: 0n, deposit, closeRequestedAt: 0 }

    const result = await Chain.broadcastOpenTransaction({
      chainId,
      client: createMockClient({
        channel: { descriptor: expectedDescriptor, state },
        receipt: receipt([openedLog({ channelId, expiringNonceHash })]),
      }),
      escrowContract: tip20ChannelEscrow,
      expectedAuthorizedSigner: descriptor.authorizedSigner,
      expectedChannelId: channelId,
      expectedCurrency: descriptor.token,
      expectedExpiringNonceHash: expiringNonceHash,
      expectedOperator: descriptor.operator,
      expectedPayee: descriptor.payee,
      expectedPayer: descriptor.payer,
      serializedTransaction,
    })

    expect(result).toEqual({
      txHash,
      descriptor: expectedDescriptor,
      state,
      expiringNonceHash,
      openDeposit: deposit,
    })
  })

  test('rejects ChannelOpened receipt deposit mismatches', async () => {
    const serializedTransaction = await createOpenTransaction()
    const expiringNonceHash = expectedExpiringNonceHash(serializedTransaction)
    const expectedDescriptor = { ...descriptor, expiringNonceHash }
    const channelId = Channel.computeId({
      ...expectedDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })

    await expect(
      Chain.broadcastOpenTransaction({
        chainId,
        client: createMockClient({
          channel: {
            descriptor: expectedDescriptor,
            state: { settled: 0n, deposit, closeRequestedAt: 0 },
          },
          receipt: receipt([openedLog({ channelId, expiringNonceHash, deposit: deposit + 1n })]),
        }),
        escrowContract: tip20ChannelEscrow,
        expectedAuthorizedSigner: descriptor.authorizedSigner,
        expectedChannelId: channelId,
        expectedCurrency: descriptor.token,
        expectedExpiringNonceHash: expiringNonceHash,
        expectedOperator: descriptor.operator,
        expectedPayee: descriptor.payee,
        expectedPayer: descriptor.payer,
        serializedTransaction,
      }),
    ).rejects.toThrow('ChannelOpened deposit does not match calldata')
  })
})

describe('precompile broadcastTopUpTransaction', () => {
  test('rejects transactions with extra calls', async () => {
    const serializedTransaction = await createSerializedTransaction({
      calls: [
        {
          to: tip20ChannelEscrow,
          data: encodeFunctionData({
            abi: escrowAbi,
            functionName: 'topUp',
            args: [descriptor, deposit],
          }),
        },
        {
          to: descriptor.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [tip20ChannelEscrow, deposit],
          }),
        },
      ],
    })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 topUp transaction must contain exactly one call')
  })

  test('rejects top-up transactions targeting the wrong escrow contract', async () => {
    const serializedTransaction = await createTopUpTransaction({ to: descriptor.token })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 topUp transaction targets the wrong address')
  })

  test('rejects top-up transactions missing calldata', async () => {
    const serializedTransaction = await createSerializedTransaction({
      calls: [{ to: tip20ChannelEscrow }],
    })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('TIP-1034 topUp transaction is missing calldata')
  })

  test('rejects top-up calldata descriptor mismatches before broadcasting', async () => {
    const serializedTransaction = await createTopUpTransaction({
      descriptor_: { ...descriptor, payee: zeroAddress },
    })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('descriptor does not match')
  })

  test('fee-payer rejects non-Tempo top-up transactions', async () => {
    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        feePayer: { address: descriptor.payee } as never,
        serializedTransaction: '0x1234',
      }),
    ).rejects.toThrow('Only Tempo (0x76/0x78) transactions are supported')
  })

  test('fee-payer rejects unsigned top-up transactions', async () => {
    const serializedTransaction = await createTopUpTransaction()

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: Channel.computeId({
          ...descriptor,
          chainId,
          escrow: tip20ChannelEscrow,
        }),
        expectedCurrency: descriptor.token,
        feePayer: { address: descriptor.payee } as never,
        serializedTransaction,
      }),
    ).rejects.toThrow('Transaction must be signed by the sender before fee payer co-signing')
  })

  test('fee-payer rejects top-up transactions whose gas budget exceeds sponsor policy', async () => {
    const serializedTransaction = await createTopUpTransaction({ gas: 2_000_001n, signed: true })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: Channel.computeId({
          ...descriptor,
          chainId,
          escrow: tip20ChannelEscrow,
        }),
        expectedCurrency: descriptor.token,
        feePayer,
        feePayerPolicy: { maxGas: 2_000_000n },
        serializedTransaction,
      }),
    ).rejects.toThrow('fee-sponsored transaction gas exceeds sponsor policy')
  })

  test('fee-payer simulates top-up before raw broadcast', async () => {
    const rpcMethods: string[] = []
    const serializedTransaction = await createTopUpTransaction({ gas: 100_000n, signed: true })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const newDeposit = deposit * 2n
    await Chain.broadcastTopUpTransaction({
      additionalDeposit: deposit,
      chainId,
      client: createMockClient({
        channel: { descriptor, state: { settled: 0n, deposit: newDeposit, closeRequestedAt: 0 } },
        receipt: receipt([topUpLog({ channelId, newDeposit })]),
        rpcMethods,
      }),
      descriptor,
      escrowContract: tip20ChannelEscrow,
      expectedChannelId: channelId,
      expectedCurrency: descriptor.token,
      feePayer: mockFeePayer,
      serializedTransaction,
    })

    const broadcastIndex = rpcMethods.indexOf('eth_sendRawTransactionSync')
    const simulationIndex = rpcMethods.indexOf('eth_call')
    expect(broadcastIndex).toBeGreaterThan(-1)
    expect(simulationIndex).toBeGreaterThan(-1)
    expect(simulationIndex).toBeLessThan(broadcastIndex)
  })

  test('rejects top-up calldata amount mismatches before broadcasting', async () => {
    const serializedTransaction = await createTopUpTransaction({ additionalDeposit: 1n })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient(),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: `0x${'11'.repeat(32)}`,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('topUp deposit does not match credential')
  })

  test('returns tx hash, new deposit, and read-back state on success', async () => {
    const serializedTransaction = await createTopUpTransaction()
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const newDeposit = deposit * 2n
    const state = { settled: 0n, deposit: newDeposit, closeRequestedAt: 0 }

    const result = await Chain.broadcastTopUpTransaction({
      additionalDeposit: deposit,
      chainId,
      client: createMockClient({
        channel: { descriptor, state },
        receipt: receipt([topUpLog({ channelId, newDeposit })]),
      }),
      descriptor,
      escrowContract: tip20ChannelEscrow,
      expectedChannelId: channelId,
      expectedCurrency: descriptor.token,
      serializedTransaction,
    })

    expect(result).toEqual({ txHash, newDeposit, state })
  })

  test('rejects top-up receipt/readback deposit mismatches', async () => {
    const serializedTransaction = await createTopUpTransaction()
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    await expect(
      Chain.broadcastTopUpTransaction({
        additionalDeposit: deposit,
        chainId,
        client: createMockClient({
          channel: { descriptor, state: { settled: 0n, deposit: deposit, closeRequestedAt: 0 } },
          receipt: receipt([topUpLog({ channelId, newDeposit: deposit * 2n })]),
        }),
        descriptor,
        escrowContract: tip20ChannelEscrow,
        expectedChannelId: channelId,
        expectedCurrency: descriptor.token,
        serializedTransaction,
      }),
    ).rejects.toThrow('on-chain channel state does not match topUp receipt')
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

const receiptValidationChainId = 42431
const receiptValidationEscrow = '0x4D50500000000000000000000000000000000000' as Address
const receiptValidationDescriptor = {
  payer: '0x0000000000000000000000000000000000000001' as Address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  token: '0x20c0000000000000000000000000000000000001' as Address,
  salt: `0x${'11'.repeat(32)}` as Hex,
  authorizedSigner: '0x0000000000000000000000000000000000000001' as Address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as Hex,
} satisfies Channel.ChannelDescriptor
const receiptValidationChannelId = Channel.computeId({
  ...receiptValidationDescriptor,
  chainId: receiptValidationChainId,
  escrow: receiptValidationEscrow,
})

describe('ChainReceiptValidation', () => {
  test('reads typed ChannelOpened receipt fields', () => {
    expect(
      Chain.readChannelOpenedReceiptFields({
        args: {
          channelId: receiptValidationChannelId,
          deposit: 100n,
          expiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
        },
      }),
    ).toEqual({
      channelId: receiptValidationChannelId,
      deposit: 100n,
      expiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
    })
  })

  test('reads typed TopUp receipt fields', () => {
    expect(
      Chain.readTopUpReceiptFields({
        args: { channelId: receiptValidationChannelId, newDeposit: 200n },
      }),
    ).toEqual({
      channelId: receiptValidationChannelId,
      newDeposit: 200n,
    })
  })

  test('reads typed settlement receipt fields', () => {
    expect(Chain.readSettledReceiptFields({ args: { newSettled: 300n } })).toEqual({
      newSettled: 300n,
    })
  })

  test('reads typed ChannelClosed receipt fields', () => {
    expect(
      Chain.readChannelClosedReceiptFields({
        args: {
          settledToPayee: 250n,
          refundedToPayer: 50n,
        },
      }),
    ).toEqual({
      settledToPayee: 250n,
      refundedToPayer: 50n,
    })
  })

  test('rejects malformed receipt event fields', () => {
    expect(() =>
      Chain.readChannelOpenedReceiptFields({
        args: {
          channelId: receiptValidationChannelId,
          deposit: '100',
          expiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
        },
      }),
    ).toThrow('ChannelOpened deposit missing from receipt event')

    expect(() =>
      Chain.readChannelOpenedReceiptFields({
        args: {
          channelId: '0x1234',
          deposit: 100n,
          expiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
        },
      }),
    ).toThrow('ChannelOpened channelId missing from receipt event')

    expect(() =>
      Chain.readChannelOpenedReceiptFields({
        args: {
          channelId: receiptValidationChannelId,
          deposit: 100n,
          expiringNonceHash: `0x${'zz'.repeat(32)}`,
        },
      }),
    ).toThrow('ChannelOpened expiringNonceHash missing from receipt event')

    expect(() =>
      Chain.readTopUpReceiptFields({
        args: {
          channelId: '0x1234',
          newDeposit: 200n,
        },
      }),
    ).toThrow('TopUp channelId missing from receipt event')

    expect(() =>
      Chain.readTopUpReceiptFields({
        args: {
          channelId: receiptValidationChannelId,
          newDeposit: 2n ** 96n,
        },
      }),
    ).toThrow('TopUp newDeposit exceeds uint96 range')

    expect(() => Chain.readSettledReceiptFields({ args: { newSettled: '300' } })).toThrow(
      'Settled newSettled missing from receipt event',
    )

    expect(() =>
      Chain.readChannelClosedReceiptFields({
        args: {
          settledToPayee: 250n,
          refundedToPayer: 2n ** 96n,
        },
      }),
    ).toThrow('ChannelClosed refundedToPayer exceeds uint96 range')
  })

  test('accepts a matching ChannelOpened receipt and read-back state', () => {
    expect(() =>
      Chain.validateChannelOpenedReceipt({
        chainId: receiptValidationChainId,
        descriptor: receiptValidationDescriptor,
        emittedChannelId: receiptValidationChannelId,
        emittedDeposit: 100n,
        emittedExpiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
        escrow: receiptValidationEscrow,
        expectedChannelId: receiptValidationChannelId,
        openDeposit: 100n,
      }),
    ).not.toThrow()

    expect(() =>
      Chain.validateOpenReadbackState({
        emittedDeposit: 100n,
        state: { deposit: 100n, settled: 0n, closeRequestedAt: 0 },
      }),
    ).not.toThrow()
  })

  test('rejects ChannelOpened mismatches', () => {
    const cases = [
      {
        parameters: { emittedChannelId: `0x${'ff'.repeat(32)}` as Hex },
        message: 'ChannelOpened channelId does not match credential',
      },
      {
        parameters: { emittedExpiringNonceHash: `0x${'33'.repeat(32)}` as Hex },
        message: 'ChannelOpened expiringNonceHash does not match descriptor',
      },
      {
        parameters: { emittedDeposit: 101n },
        message: 'ChannelOpened deposit does not match calldata',
      },
    ] as const

    for (const item of cases) {
      expect(() =>
        Chain.validateChannelOpenedReceipt({
          chainId: receiptValidationChainId,
          descriptor: receiptValidationDescriptor,
          emittedChannelId: receiptValidationChannelId,
          emittedDeposit: 100n,
          emittedExpiringNonceHash: receiptValidationDescriptor.expiringNonceHash,
          escrow: receiptValidationEscrow,
          expectedChannelId: receiptValidationChannelId,
          openDeposit: 100n,
          ...item.parameters,
        }),
      ).toThrow(item.message)
    }
  })

  test('rejects mismatched open read-back state', () => {
    expect(() =>
      Chain.validateOpenReadbackState({
        emittedDeposit: 100n,
        state: { deposit: 100n, settled: 1n, closeRequestedAt: 0 },
      }),
    ).toThrow(VerificationFailedError)
  })

  test('validates top-up receipt and read-back state', () => {
    expect(() =>
      Chain.validateTopUpReceipt({
        emittedChannelId: receiptValidationChannelId,
        expectedChannelId: receiptValidationChannelId,
      }),
    ).not.toThrow()
    expect(() =>
      Chain.validateTopUpReadbackState({
        newDeposit: 200n,
        state: { deposit: 200n, settled: 0n, closeRequestedAt: 0 },
      }),
    ).not.toThrow()
  })

  test('rejects top-up receipt and read-back mismatches', () => {
    expect(() =>
      Chain.validateTopUpReceipt({
        emittedChannelId: `0x${'ff'.repeat(32)}` as Hex,
        expectedChannelId: receiptValidationChannelId,
      }),
    ).toThrow('TopUp channelId does not match credential')

    expect(() =>
      Chain.validateTopUpReadbackState({
        newDeposit: 200n,
        state: { deposit: 199n, settled: 0n, closeRequestedAt: 0 },
      }),
    ).toThrow('on-chain channel state does not match topUp receipt')
  })
})

describe('Chain.assertPrecompileFeePayerPolicy', () => {
  test('allows transactions within configured sponsor limits', () => {
    expect(() =>
      Chain.assertPrecompileFeePayerPolicy({
        prepared: {
          gas: 100n,
          maxFeePerGas: 20n,
          maxPriorityFeePerGas: 5n,
        },
        policy: {
          maxGas: 100n,
          maxFeePerGas: 20n,
          maxPriorityFeePerGas: 5n,
          maxTotalFee: 2_000n,
        },
      }),
    ).not.toThrow()
  })

  test('allows missing optional policy', () => {
    expect(() =>
      Chain.assertPrecompileFeePayerPolicy({
        prepared: {
          gas: 100n,
          maxFeePerGas: 20n,
          maxPriorityFeePerGas: 5n,
        },
      }),
    ).not.toThrow()
  })

  test('rejects each exceeded sponsor limit', () => {
    const cases = [
      {
        policy: { maxGas: 99n },
        reason: 'fee-payer policy maxGas exceeded',
      },
      {
        policy: { maxFeePerGas: 19n },
        reason: 'fee-payer policy maxFeePerGas exceeded',
      },
      {
        policy: { maxPriorityFeePerGas: 4n },
        reason: 'fee-payer policy maxPriorityFeePerGas exceeded',
      },
      {
        policy: { maxTotalFee: 1_999n },
        reason: 'fee-payer policy maxTotalFee exceeded',
      },
    ] as const

    for (const item of cases) {
      expect(() =>
        Chain.assertPrecompileFeePayerPolicy({
          prepared: {
            gas: 100n,
            maxFeePerGas: 20n,
            maxPriorityFeePerGas: 5n,
          },
          policy: item.policy,
        }),
      ).toThrow(item.reason)
    }
  })
})
