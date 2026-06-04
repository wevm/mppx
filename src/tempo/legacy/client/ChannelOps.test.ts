import { Hex } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import { type Address, createClient, decodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account as TempoAccount, Addresses, Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { tempoNetwork } from '~test/config.js'
import { deployEscrow, openChannel } from '~test/tempo/legacy/session.js'
import { accounts, asset, chain, client, fundAccount, http } from '~test/tempo/viem.js'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import {
  chainId as chainIdDefaults,
  escrowContract as escrowContractDefaults,
} from '../../internal/defaults.js'
import { escrowAbi } from '../session/Chain.js'
import { verifyVoucher } from '../session/Voucher.js'
import {
  createClosePayload,
  createOpenPayload,
  createVoucherPayload,
  resolveEscrow,
  serializeCredential,
  tryRecoverChannel,
} from './ChannelOps.js'

const escrow42431 = escrowContractDefaults[chainIdDefaults.testnet] as Address

const localAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const localClient = createClient({
  account: localAccount,
  transport: http('http://127.0.0.1'),
})

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex
const escrowContract = '0x1234567890abcdef1234567890abcdef12345678' as Address
const chainId = 42431
const isLocalnet = tempoNetwork === 'localnet'

function makeChallenge(overrides?: Partial<Challenge>): Challenge {
  return {
    id: 'test-id',
    realm: 'test.com',
    method: 'tempo',
    intent: 'session',
    request: { amount: '1000000' },
    ...overrides,
  }
}

describe('resolveEscrow', () => {
  test('prefers escrowContractOverride over challenge.request.methodDetails.escrowContract', () => {
    const challenge = {
      request: { methodDetails: { escrowContract: '0xChallengeEscrow' } },
    }
    const result = resolveEscrow(challenge, 42431, '0xOverride' as Address)
    expect(result).toBe('0xOverride')
  })

  test('falls back to escrowContractOverride', () => {
    const challenge = { request: { methodDetails: {} } }
    const result = resolveEscrow(challenge, 42431, '0xOverride' as Address)
    expect(result).toBe('0xOverride')
  })

  test('falls back to defaults when no override', () => {
    const challenge = { request: {} }
    const result = resolveEscrow(challenge, 42431)
    expect(result).toBe(escrow42431)
  })

  test('throws when no escrow available', () => {
    const challenge = { request: {} }
    expect(() => resolveEscrow(challenge, 99999)).toThrow('No `escrowContract` available')
  })

  test('falls back to defaults when methodDetails is undefined', () => {
    const challenge = { request: { methodDetails: undefined } }
    const result = resolveEscrow(challenge, 42431)
    expect(result).toBe(escrow42431)
  })
})

describe('serializeCredential', () => {
  test('produces correct DID source string', () => {
    const challenge = makeChallenge()
    const payload = {
      action: 'voucher' as const,
      channelId,
      cumulativeAmount: '1000000',
      signature: '0xsig' as `0x${string}`,
    }

    const result = serializeCredential(challenge, payload, 42431, localAccount)

    expect(result).toMatch(/^Payment /)
    const deserialized = Credential.deserialize(result)
    expect(deserialized.source).toBe(`did:pkh:eip155:42431:${localAccount.address}`)
  })

  test('encodes chainId in DID source', () => {
    const challenge = makeChallenge()
    const payload = {
      action: 'voucher' as const,
      channelId,
      cumulativeAmount: '1000000',
      signature: '0xsig' as `0x${string}`,
    }

    const result = serializeCredential(challenge, payload, 4217, localAccount)
    const deserialized = Credential.deserialize(result)
    expect(deserialized.source).toContain('did:pkh:eip155:4217:')
  })
})

describe('createVoucherPayload', () => {
  test('returns voucher payload with valid signature', async () => {
    const result = await createVoucherPayload(
      localClient,
      localAccount,
      channelId,
      5_000_000n,
      escrowContract,
      chainId,
    )

    expect(result.action).toBe('voucher')
    expect(result.channelId).toBe(channelId)
    if (result.action !== 'voucher') throw new Error('unexpected action')
    expect(result.cumulativeAmount).toBe('5000000')
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/)

    const valid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: 5_000_000n, signature: result.signature },
      localAccount.address,
    )
    expect(valid).toBe(true)
  })

  test('uses raw access-key signatures when no voucherSigner is provided', async () => {
    const accessKey = TempoAccount.fromSecp256k1(
      '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d',
      { access: localAccount },
    )
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    const result = await createVoucherPayload(
      accessKeyClient,
      accessKey,
      channelId,
      5_000_000n,
      escrowContract,
      chainId,
    )

    expect(result.action).toBe('voucher')
    if (result.action !== 'voucher') throw new Error('unexpected action')

    const envelope = SignatureEnvelope.from(result.signature as SignatureEnvelope.Serialized)
    expect(envelope.type).toBe('secp256k1')

    const valid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: 5_000_000n, signature: result.signature },
      accessKey.accessKeyAddress,
    )
    expect(valid).toBe(true)
  })
})

describe('createClosePayload', () => {
  test('returns close payload with valid signature', async () => {
    const result = await createClosePayload(
      localClient,
      localAccount,
      channelId,
      5_000_000n,
      escrowContract,
      chainId,
    )

    expect(result.action).toBe('close')
    expect(result.channelId).toBe(channelId)
    if (result.action !== 'close') throw new Error('unexpected action')
    expect(result.cumulativeAmount).toBe('5000000')
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/)

    const valid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: 5_000_000n, signature: result.signature },
      localAccount.address,
    )
    expect(valid).toBe(true)
  })
})

describe.runIf(isLocalnet)('createOpenPayload', () => {
  const payer = accounts[2]
  const payee = accounts[1].address
  const currency = asset

  let escrow: Address

  beforeAll(async () => {
    escrow = await deployEscrow()
    await fundAccount({ address: payer.address, token: Addresses.pathUsd })
    await fundAccount({ address: payer.address, token: currency })
  })

  test('returns entry with correct fields and valid payload', async () => {
    const payerClient = createClient({
      account: payer,
      chain,
      transport: http(),
    })

    const result = await createOpenPayload(payerClient, payer, {
      escrowContract: escrow,
      payee,
      currency,
      deposit: 10_000_000n,
      initialAmount: 1_000_000n,
      chainId: chain.id,
    })

    expect(result.entry.opened).toBe(true)
    expect(result.entry.cumulativeAmount).toBe(1_000_000n)
    expect(result.entry.escrowContract).toBe(escrow)
    expect(result.entry.chainId).toBe(chain.id)
    expect(result.entry.channelId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.entry.salt).toMatch(/^0x/)

    expect(result.payload.action).toBe('open')
    expect(result.payload).toHaveProperty('type', 'transaction')
    expect(result.payload).toHaveProperty('transaction')
    expect(result.payload).toHaveProperty('signature')
    expect(result.payload.channelId).toBe(result.entry.channelId)
  })

  test('defaults authorizedSigner to account.address', async () => {
    const payerClient = createClient({
      account: payer,
      chain,
      transport: http(),
    })

    const result = await createOpenPayload(payerClient, payer, {
      escrowContract: escrow,
      payee,
      currency,
      deposit: 10_000_000n,
      initialAmount: 1_000_000n,
      chainId: chain.id,
    })

    expect(result.payload.action).toBe('open')
    if (result.payload.action !== 'open') throw new Error('unexpected action')
    expect(result.payload.authorizedSigner).toBe(payer.address)
  })

  test('derives authorizedSigner from voucherSigner when provided', async () => {
    const voucherSigner = accounts[5]
    const payerClient = createClient({
      account: payer,
      chain,
      transport: http(),
    })

    const result = await createOpenPayload(payerClient, payer, {
      voucherSigner,
      escrowContract: escrow,
      payee,
      currency,
      deposit: 10_000_000n,
      initialAmount: 1_000_000n,
      chainId: chain.id,
    })

    expect(result.payload.action).toBe('open')
    if (result.payload.action !== 'open') throw new Error('unexpected action')
    expect(result.payload.authorizedSigner).toBe(voucherSigner.address)

    const transaction = Transaction.deserialize(result.payload.transaction)
    if (!('calls' in transaction)) throw new Error('unexpected transaction type')
    const calls = transaction.calls as readonly [
      { to?: Address; data?: Hex.Hex },
      { to?: Address; data?: Hex.Hex },
    ]
    const openCall = calls[1]
    const open = decodeFunctionData({
      abi: escrowAbi,
      data: openCall?.data ?? '0x',
    })
    const openArgs = open.args as readonly [Address, Address, bigint, string, Address]
    expect(openArgs[4].toLowerCase()).toBe(voucherSigner.address.toLowerCase())
  })
})

describe.runIf(isLocalnet)('tryRecoverChannel', () => {
  const payer = accounts[3]
  const payee = accounts[1].address
  const currency = asset

  let escrow: Address
  let existingChannelId: `0x${string}`

  beforeAll(async () => {
    escrow = await deployEscrow()
    await fundAccount({ address: payer.address, token: Addresses.pathUsd })
    await fundAccount({ address: payer.address, token: currency })

    const salt = Hex.random(32) as `0x${string}`
    const result = await openChannel({
      escrow,
      payer,
      payee,
      token: currency,
      deposit: 10_000_000n,
      salt,
    })
    existingChannelId = result.channelId
  })

  test('returns entry when channel has positive deposit and not finalized', async () => {
    const result = await tryRecoverChannel(client, escrow, existingChannelId, chain.id)

    expect(result).not.toBeUndefined()
    expect(result!.channelId).toBe(existingChannelId)
    expect(result!.cumulativeAmount).toBe(0n)
    expect(result!.opened).toBe(true)
    expect(result!.escrowContract).toBe(escrow)
    expect(result!.chainId).toBe(chain.id)
  })

  test('returns undefined for non-existent channel', async () => {
    const fakeChannelId =
      '0x0000000000000000000000000000000000000000000000000000000000000099' as `0x${string}`
    const result = await tryRecoverChannel(client, escrow, fakeChannelId, chain.id)
    expect(result).toBeUndefined()
  })
})
