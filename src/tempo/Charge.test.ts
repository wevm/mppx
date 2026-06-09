import { Challenge, Credential } from 'mppx'
import type * as Hex from 'ox/Hex'
import { createClient, type Address } from 'viem'
import {
  Account as TempoAccount,
  KeyAuthorizationManager,
  Secp256k1,
  Transaction,
} from 'viem/tempo'
import { describe, expect, test } from 'vp/test'
import { accounts, asset, chain, http } from '~test/tempo/viem.js'

import * as Charge from './Charge.js'
import * as Methods from './Methods.js'

const account = accounts[1]
const chainId = chain.id
const currency = asset
const recipient = '0x2222222222222222222222222222222222222222' as Address
const splitRecipient = '0x4444444444444444444444444444444444444444' as Address
const rootAccount = TempoAccount.fromSecp256k1(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.charge.schema.request.parse>[0]> = {},
): Challenge.Challenge<ChargeRequest, 'charge', 'tempo'> {
  const request = Methods.charge.schema.request.parse({
    amount: '1',
    chainId,
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

async function createAccessKey() {
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
    { chainId: BigInt(chainId) },
  )
  await keyAuthorizationManager.set(
    {
      accessKey: accessKey.accessKeyAddress,
      address: rootAccount.address,
      chainId,
    },
    keyAuthorization,
  )
  return { accessKey, keyAuthorization }
}

describe('fill', () => {
  test('behavior: fills split payment calls', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const filled = await Charge.fill(client, {
      challenge: createChallenge({
        splits: [{ amount: '0.25', recipient: splitRecipient }],
      }),
      payer: account.address,
    })

    expect(filled.kind).toBe('calls')
    if (filled.kind !== 'calls') throw new Error('expected filled calls')
    expect(filled.chainId).toBe(chainId)
    expect(filled.payer).toBe(account.address)
    expect(filled.supportedModes).toEqual(['pull', 'push'])
    expect(filled.calls).toHaveLength(2)
  })

  test('error: rejects unexpected split recipients', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })

    await expect(
      Charge.fill(client, {
        challenge: createChallenge({
          splits: [{ amount: '0.25', recipient: splitRecipient }],
        }),
        expectedRecipients: [recipient],
        payer: account.address,
      }),
    ).rejects.toThrow(`Unexpected split recipient: ${splitRecipient}`)
  })
})

describe('createCredential', () => {
  test('error: rejects unsupported mode', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const filled = await Charge.fill(client, {
      challenge: createChallenge({ supportedModes: ['push'] }),
      payer: account.address,
    })

    await expect(
      Charge.createCredential(client, {
        filled,
        mode: 'pull',
        signer: account,
      }),
    ).rejects.toThrow('Challenge does not support pull mode.')
  })

  test('behavior: creates pull transaction credential', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()
    const filled = await Charge.fill(client, {
      challenge,
      payer: account.address,
    })

    const authorization = await Charge.createCredential(client, { filled, signer: account })
    const credential = Credential.deserialize(authorization)

    expect(credential.challenge.id).toBe(challenge.id)
    expect(credential.payload).toMatchObject({ type: 'transaction' })
    const signature = (credential.payload as { signature: Hex.Hex }).signature
    const transaction = Transaction.deserialize(signature as Transaction.TransactionSerializedTempo)
    if (!('calls' in transaction)) throw new Error('unexpected transaction type')
    if (filled.kind !== 'calls') throw new Error('expected filled calls')
    expect(transaction.calls).toEqual(filled.calls.map(({ data, to }) => ({ data, to })))
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('behavior: creates pull transaction credential with access key', async () => {
    const { accessKey, keyAuthorization } = await createAccessKey()
    const client = createClient({
      account: accessKey,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()
    const filled = await Charge.fill(client, {
      challenge,
      payer: accessKey.address,
    })

    const authorization = await Charge.createCredential(client, { filled, signer: accessKey })
    const credential = Credential.deserialize(authorization)

    expect(accessKey.address).toBe(rootAccount.address)
    expect(accessKey.accessKeyAddress).not.toBe(rootAccount.address)
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${rootAccount.address}`)
    expect(credential.payload).toMatchObject({ type: 'transaction' })
    const signature = (credential.payload as { signature: Hex.Hex }).signature
    const transaction = Transaction.deserialize(signature as Transaction.TransactionSerializedTempo)
    expect(transaction.keyAuthorization).toEqual(keyAuthorization)
  })

  test('behavior: creates proof credential for zero-amount charge', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge({ amount: '0' })
    const filled = await Charge.fill(client, {
      challenge,
      payer: account.address,
    })

    const authorization = await Charge.createCredential(client, { filled, signer: account })
    const credential = Credential.deserialize(authorization)

    expect(credential.challenge.id).toBe(challenge.id)
    expect(credential.payload).toMatchObject({ type: 'proof' })
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('behavior: creates proof credential with access key source account', async () => {
    const { accessKey } = await createAccessKey()
    const client = createClient({
      account: accessKey,
      chain,
      transport: http(),
    })
    const challenge = createChallenge({ amount: '0' })
    const filled = await Charge.fill(client, {
      challenge,
      payer: accessKey.address,
    })

    const authorization = await Charge.createCredential(client, { filled, signer: accessKey })
    const credential = Credential.deserialize(authorization)

    expect(accessKey.address).toBe(rootAccount.address)
    expect(accessKey.accessKeyAddress).not.toBe(rootAccount.address)
    expect(credential.payload).toMatchObject({ type: 'proof' })
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${rootAccount.address}`)
  })
})
