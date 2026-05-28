import { Challenge, Credential } from 'mppx'
import { type Address, createClient, custom, type Hex } from 'viem'
import {
  Account as TempoAccount,
  KeyAuthorizationManager,
  Secp256k1,
  Transaction,
} from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { deployEscrow, openChannel } from '~test/tempo/session.js'
import { asset as currency, chain, http } from '~test/tempo/viem.js'

import { createOpenPayload } from './client/ChannelOps.js'
import { charge } from './client/Charge.js'
import * as Methods from './Methods.js'
import { closeOnChain, settleOnChain } from './session/Chain.js'
import { signVoucher } from './session/Voucher.js'

type ChargeCredentialPayload =
  | { hash: Hex; type: 'hash' }
  | { signature: Hex; type: 'proof' | 'transaction' }

const rootAccount = TempoAccount.fromSecp256k1(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const recipient = '0x2222222222222222222222222222222222222222' as Address

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>

function createChargeChallenge(
  overrides: Partial<Parameters<typeof Methods.charge.schema.request.parse>[0]> = {},
): Challenge.Challenge<ChargeRequest, 'charge', 'tempo'> {
  const request = Methods.charge.schema.request.parse({
    amount: '1000000',
    chainId: chain.id,
    currency,
    decimals: 6,
    recipient,
    ...overrides,
  })
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'charge',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<ChargeRequest, 'charge', 'tempo'>
}

async function createAccessKeyClient() {
  const keyAuthorizationManager = KeyAuthorizationManager.memory()
  const accessKey = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey(), {
    access: rootAccount,
    keyAuthorizationManager,
  })
  const keyAuthorization = await rootAccount.signKeyAuthorization(
    {
      accessKeyAddress: accessKey.accessKeyAddress,
      keyType: accessKey.keyType,
    },
    {
      chainId: BigInt(chain.id),
    },
  )
  await keyAuthorizationManager.set(
    {
      accessKey: accessKey.accessKeyAddress,
      address: rootAccount.address,
      chainId: chain.id,
    },
    keyAuthorization,
  )

  const signedTransactions: Transaction.TransactionSerializedTempo[] = []
  const rpcClient = createClient({ chain, transport: http() })

  const client = createClient({
    account: accessKey,
    chain,
    transport: custom({
      async request({ method, params }: { method: string; params?: readonly unknown[] }) {
        if (method === 'eth_sendRawTransaction' || method === 'eth_sendRawTransactionSync')
          signedTransactions.push(params?.[0] as Transaction.TransactionSerializedTempo)
        return rpcClient.request({ method, params } as never)
      },
    }),
  })

  return { accessKey, client, keyAuthorization, signedTransactions }
}

function expectTransactionKeyAuthorization(
  serializedTransaction: Hex,
  keyAuthorization: Awaited<ReturnType<typeof rootAccount.signKeyAuthorization>>,
) {
  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  expect(transaction.keyAuthorization).toEqual(keyAuthorization)
}

async function createChannelForPayee(payee: Address, escrowContract: Address) {
  const payer = rootAccount
  const { channelId } = await openChannel({
    deposit: 10_000_000n,
    escrow: escrowContract,
    payee,
    payer,
    salt: Secp256k1.randomPrivateKey(),
    token: currency,
  })
  const cumulativeAmount = 1_000_000n
  const signature = await signVoucher(
    createClient({ account: payer, chain, transport: http() }),
    payer,
    { channelId, cumulativeAmount },
    escrowContract,
    chain.id,
  )

  return { channelId, cumulativeAmount, escrowContract, signature }
}

describe.runIf(nodeEnv === 'localnet')('Tempo access-key authorization attachment', () => {
  let escrowContract: Address

  beforeAll(async () => {
    escrowContract = await deployEscrow()
  })

  test('tempo.charge pull signs a prepared transaction with keyAuthorization', async () => {
    const { accessKey, client, keyAuthorization } = await createAccessKeyClient()
    const method = charge({
      account: accessKey,
      getClient: () => client,
      mode: 'pull',
    })

    const credential = Credential.deserialize<ChargeCredentialPayload>(
      await method.createCredential({
        challenge: createChargeChallenge({ supportedModes: ['pull'] }),
        context: {},
      }),
    )

    expect(credential.payload.type).toBe('transaction')
    if (credential.payload.type !== 'transaction') throw new Error('unexpected credential type')
    expectTransactionKeyAuthorization(credential.payload.signature as Hex, keyAuthorization)
  })

  test('tempo.charge push fallback sends a prepared transaction with keyAuthorization', async () => {
    const { accessKey, client, keyAuthorization, signedTransactions } =
      await createAccessKeyClient()
    const method = charge({
      account: accessKey,
      getClient: () => client,
      mode: 'push',
    })

    const credential = Credential.deserialize<ChargeCredentialPayload>(
      await method.createCredential({
        challenge: createChargeChallenge({ supportedModes: ['push'] }),
        context: {},
      }),
    )

    expect(credential.payload.type).toBe('hash')
    expect(signedTransactions).toHaveLength(1)
    expectTransactionKeyAuthorization(signedTransactions[0]!, keyAuthorization)
  })

  test('tempo.session open signs a prepared transaction with keyAuthorization', async () => {
    const { accessKey, client, keyAuthorization } = await createAccessKeyClient()

    const { payload } = await createOpenPayload(client, accessKey, {
      chainId: chain.id,
      currency,
      deposit: 5_000_000n,
      escrowContract,
      initialAmount: 1_000_000n,
      payee: recipient,
    })

    expect(payload.action).toBe('open')
    if (payload.action !== 'open') throw new Error('unexpected payload action')
    expectTransactionKeyAuthorization(payload.transaction, keyAuthorization)
  })

  test('tempo.session settle sends a prepared transaction with keyAuthorization', async () => {
    const { accessKey, client, keyAuthorization, signedTransactions } =
      await createAccessKeyClient()
    const channel = await createChannelForPayee(rootAccount.address, escrowContract)

    const hash = await settleOnChain(
      client,
      channel.escrowContract,
      {
        channelId: channel.channelId,
        cumulativeAmount: channel.cumulativeAmount,
        signature: channel.signature,
      },
      { account: accessKey },
    )

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(signedTransactions).toHaveLength(1)
    expectTransactionKeyAuthorization(signedTransactions[0]!, keyAuthorization)
  })

  test('tempo.session close sends a prepared transaction with keyAuthorization', async () => {
    const { accessKey, client, keyAuthorization, signedTransactions } =
      await createAccessKeyClient()
    const channel = await createChannelForPayee(rootAccount.address, escrowContract)

    const hash = await closeOnChain(
      client,
      channel.escrowContract,
      {
        channelId: channel.channelId,
        cumulativeAmount: channel.cumulativeAmount,
        signature: channel.signature,
      },
      { account: accessKey },
    )

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(signedTransactions).toHaveLength(1)
    expectTransactionKeyAuthorization(signedTransactions[0]!, keyAuthorization)
  })
})
