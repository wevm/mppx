import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Chain from './Chain.js'
import * as Channel from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'
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
  calls: { to: `0x${string}`; data: `0x${string}` }[]
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
          nonceKey: 1n,
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
  return Channel.computeExpiringNonceHash(
    Transaction.deserialize(
      serializedTransaction as Transaction.TransactionSerializedTempo,
    ) as Channel.ExpiringNonceTransaction,
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
      transaction as Channel.ExpiringNonceTransaction,
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
      transaction as Channel.ExpiringNonceTransaction,
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
