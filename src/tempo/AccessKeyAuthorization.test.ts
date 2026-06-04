import { Challenge, Credential } from 'mppx'
import { type Address, createClient, custom, type Hex } from 'viem'
import {
  Account as TempoAccount,
  KeyAuthorizationManager,
  Secp256k1,
  Transaction,
} from 'viem/tempo'
import { describe, expect, test } from 'vp/test'
import { tempoNetwork } from '~test/config.js'
import { asset as currency, chain, http } from '~test/tempo/viem.js'

import { charge } from './client/Charge.js'
import * as Methods from './Methods.js'

type ChargeCredentialPayload =
  | { hash: Hex; type: 'hash' }
  | { signature: Hex; type: 'proof' | 'transaction' }

const rootAccount = TempoAccount.fromSecp256k1(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const recipient = '0x2222222222222222222222222222222222222222' as Address
const isLocalnet = tempoNetwork === 'localnet'

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

describe.runIf(isLocalnet)('Tempo access-key authorization attachment', () => {
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
})
