import { Challenge, Credential } from 'mppx'
import type { Address, Hex } from 'viem'
import { createClient, decodeFunctionData } from 'viem'
import { Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { deployEscrow, openChannel } from '~test/tempo/session.js'
import { accounts, asset, chain, fundAccount, http } from '~test/tempo/viem.js'

import * as Methods from './Methods.js'
import * as Session from './Session.js'
import { escrowAbi } from './session/Chain.js'
import { verifyVoucher } from './session/Voucher.js'

const isLocalnet = nodeEnv === 'localnet'

const account = accounts[2]
const authorizedSigner = accounts[3].address
const chainId = chain.id
const currency = asset
const escrowContract = '0x1234567890abcdef1234567890abcdef12345678' as Address
const recipient = accounts[1].address
const channelId = '0x0000000000000000000000000000000000000000000000000000000000000042' as Hex

type SessionRequest = ReturnType<typeof Methods.session.schema.request.parse>

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.session.schema.request.parse>[0]> = {},
): Challenge.Challenge<SessionRequest, 'session', 'tempo'> {
  const request = Methods.session.schema.request.parse({
    amount: '1',
    chainId,
    currency,
    decimals: 6,
    escrowContract,
    recipient,
    unitType: 'token',
    ...overrides,
  })
  return Challenge.from({
    id: 'test-session-challenge-id',
    intent: 'session',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<SessionRequest, 'session', 'tempo'>
}

describe('open.fill', () => {
  test('behavior: fills open channel calls', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()

    const filled = await Session.open.fill(client, {
      authorizedSigner,
      challenge,
      deposit: 10_000_000n,
      payer: account.address,
    })

    expect(filled.kind).toBe('open')
    expect(filled.chainId).toBe(chainId)
    expect(filled.payer).toBe(account.address)
    expect(filled.authorizedSigner).toBe(authorizedSigner)
    expect(filled.calls).toHaveLength(2)
    expect(filled.channelId).toMatch(/^0x[0-9a-f]{64}$/)

    const openCall = filled.calls[1]
    const openData = decodeFunctionData({
      abi: escrowAbi,
      data: openCall?.data ?? '0x',
    })
    const openArgs = openData.args as readonly [Address, Address, bigint, Hex, Address]
    expect(openArgs[0]).toBe(recipient)
    expect(openArgs[1].toLowerCase()).toBe(currency.toLowerCase())
    expect(openArgs[2]).toBe(10_000_000n)
    expect(openArgs[4]).toBe(authorizedSigner)
  })
})

describe('topUp.fill', () => {
  test('behavior: fills topUp calls', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()

    const filled = await Session.topUp.fill(client, {
      additionalDeposit: 5_000_000n,
      challenge,
      channelId,
    })

    expect(filled.kind).toBe('topUp')
    expect(filled.calls).toHaveLength(2)
    const topUpCall = filled.calls[1]
    const topUpData = decodeFunctionData({
      abi: escrowAbi,
      data: topUpCall?.data ?? '0x',
    })
    expect(topUpData.args).toEqual([channelId, 5_000_000n])
  })
})

describe('voucher.createCredential', () => {
  test('behavior: signs voucher credential', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()

    const authorization = await Session.voucher.createCredential(client, {
      challenge,
      channelId,
      cumulativeAmount: 2_000_000n,
      signer: account,
    })
    const credential = Credential.deserialize(authorization)

    expect(credential.challenge.id).toBe(challenge.id)
    expect(credential.payload).toMatchObject({
      action: 'voucher',
      channelId,
      cumulativeAmount: '2000000',
    })
    const valid = await verifyVoucher(
      escrowContract,
      chainId,
      {
        channelId,
        cumulativeAmount: 2_000_000n,
        signature: (credential.payload as { signature: Hex }).signature,
      },
      account.address,
    )
    expect(valid).toBe(true)
  })
})

describe('close.createCredential', () => {
  test('behavior: signs close credential', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge()

    const authorization = await Session.close.createCredential(client, {
      challenge,
      channelId,
      cumulativeAmount: 3_000_000n,
      signer: account,
    })
    const credential = Credential.deserialize(authorization)

    expect(credential.payload).toMatchObject({
      action: 'close',
      channelId,
      cumulativeAmount: '3000000',
    })
    const valid = await verifyVoucher(
      escrowContract,
      chainId,
      {
        channelId,
        cumulativeAmount: 3_000_000n,
        signature: (credential.payload as { signature: Hex }).signature,
      },
      account.address,
    )
    expect(valid).toBe(true)
  })
})

describe.runIf(isLocalnet)('topUp.createCredential with filled data', () => {
  const payer = accounts[0]
  let escrow: Address
  let openChannelId: Hex

  beforeAll(async () => {
    escrow = await deployEscrow()
    await fundAccount({ address: payer.address, token: currency })
    const opened = await openChannel({
      escrow,
      payer,
      payee: recipient,
      token: currency,
      deposit: 10_000_000n,
      salt: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
    })
    openChannelId = opened.channelId
  })

  test('behavior: creates topUp credential from filled data', async () => {
    const client = createClient({
      account: payer,
      chain,
      transport: http(),
    })
    const challenge = createChallenge({ escrowContract: escrow })
    const filled = await Session.topUp.fill(client, {
      additionalDeposit: 5_000_000n,
      challenge,
      channelId: openChannelId,
    })

    const authorization = await Session.topUp.createCredential(client, {
      filled,
      signer: payer,
    })
    const credential = Credential.deserialize(authorization)

    expect(credential.payload).toMatchObject({
      action: 'topUp',
      additionalDeposit: '5000000',
      channelId: openChannelId,
      type: 'transaction',
    })

    const transaction = Transaction.deserialize(
      (credential.payload as { transaction: Hex }).transaction,
    )
    if (!('calls' in transaction)) throw new Error('unexpected transaction type')
    expect(transaction.calls).toEqual(filled.calls.map(({ data, to }) => ({ data, to })))
  })
})

describe.runIf(isLocalnet)('open.createCredential', () => {
  let escrow: Address

  beforeAll(async () => {
    escrow = await deployEscrow()
    await fundAccount({ address: account.address, token: currency })
  })

  test('behavior: creates open credential from filled data', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge({ escrowContract: escrow })
    const filled = await Session.open.fill(client, {
      authorizedSigner: account.address,
      challenge,
      deposit: 10_000_000n,
      payer: account.address,
    })

    const authorization = await Session.open.createCredential(client, {
      filled,
      signer: account,
    })
    const credential = Credential.deserialize(authorization)

    expect(credential.challenge.id).toBe(challenge.id)
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    expect(credential.payload).toMatchObject({
      action: 'open',
      authorizedSigner: account.address,
      channelId: filled.channelId,
      cumulativeAmount: '1000000',
      type: 'transaction',
    })

    const transaction = Transaction.deserialize(
      (credential.payload as { transaction: Hex }).transaction,
    )
    if (!('calls' in transaction)) throw new Error('unexpected transaction type')
    expect(transaction.calls).toEqual(filled.calls.map(({ data, to }) => ({ data, to })))
  })

  test('error: rejects signer that does not match filled payer', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const challenge = createChallenge({ escrowContract: escrow })
    const filled = await Session.open.fill(client, {
      authorizedSigner: account.address,
      challenge,
      deposit: 10_000_000n,
      payer: account.address,
    })

    await expect(
      Session.open.createCredential(client, {
        filled,
        signer: accounts[4],
      }),
    ).rejects.toThrow('signer does not match filled payer.')
  })
})
