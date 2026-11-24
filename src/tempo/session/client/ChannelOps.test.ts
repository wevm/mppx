import { Challenge, Credential } from 'mppx'
import { Hex, Secp256k1 } from 'ox'
import { AccountConfig } from 'ox/tempo'
import {
  type Address,
  createClient,
  custom,
  encodeErrorResult,
  encodeFunctionResult,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis, Account as TempoAccount } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Errors from '../../../Errors.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import * as Types from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelOps from './ChannelOps.js'

const mocks = vi.hoisted(() => ({
  prepareTransactionRequest: vi.fn(async (_client: unknown, request: unknown) => request),
  signTransaction: vi.fn(async () => '0x1234'),
}))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  prepareTransactionRequest: mocks.prepareTransactionRequest,
  signTransaction: mocks.signTransaction,
}))

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const client = createClient({
  account,
  transport: custom({
    async request() {
      throw new Error('unexpected rpc request')
    },
  }),
})
const chainId = 42431

const descriptor = {
  payer: account.address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  token: '0x0000000000000000000000000000000000000003' as Address,
  salt: `0x${'11'.repeat(32)}` as Hex.Hex,
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as Hex.Hex,
} satisfies Channel.ChannelDescriptor

const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

describe('precompile client ChannelOps credential builders', () => {
  test('names the funding payer when a delegated signer serializes a voucher', () => {
    const payer = '0x0000000000000000000000000000000000000099'
    const challenge = Challenge.from({
      id: 'payer',
      intent: 'session',
      method: 'tempo',
      realm: 'api.example.com',
      request: {},
    })
    const credential = ChannelOps.serializeCredential(
      challenge,
      {
        action: 'voucher',
        channelId,
        cumulativeAmount: '1',
        descriptor: { ...descriptor, payer },
        signature: '0x1234',
      },
      chainId,
      account,
    )
    expect(Credential.deserialize(credential).source).toBe(`did:pkh:eip155:42431:${payer}`)
  })

  test('requires custom challenge escrows to be allowed or explicitly pinned', () => {
    const override = '0x0000000000000000000000000000000000000005' as Address
    const hinted = '0x0000000000000000000000000000000000000006' as Address

    expect(
      ChannelOps.resolveEscrow(
        { request: { methodDetails: { escrowContract: override } } },
        override,
      ),
    ).toBe(override)
    expect(() =>
      ChannelOps.resolveEscrow(
        { request: { methodDetails: { escrowContract: hinted } } },
        override,
      ),
    ).toThrow('does not match client escrow')
    expect(() =>
      ChannelOps.resolveEscrow({ request: { methodDetails: { escrowContract: hinted } } }),
    ).toThrow('does not match client escrow')
    expect(
      ChannelOps.resolveEscrow(
        { request: { methodDetails: { escrowContract: hinted } } },
        undefined,
        true,
      ),
    ).toBe(hinted)
    expect(() =>
      ChannelOps.resolveEscrow({ request: { methodDetails: { escrow: hinted } } }),
    ).toThrow('does not match client escrow')
    const canonicalMixedCase =
      `${tip20ChannelEscrow.slice(0, 2)}${tip20ChannelEscrow.slice(2).toUpperCase()}` as Address
    expect(
      ChannelOps.resolveEscrow({
        request: { methodDetails: { escrowContract: canonicalMixedCase } },
      }),
    ).toBe(tip20ChannelEscrow)
    expect(
      ChannelOps.resolveEscrow({
        request: { methodDetails: { escrowContract: 'not-an-address' } },
      }),
    ).toBe(tip20ChannelEscrow)
    expect(ChannelOps.resolveEscrow({ request: { methodDetails: {} } })).toBe(tip20ChannelEscrow)
  })

  test('creates a verifiable voucher credential for an existing precompile channel', async () => {
    const cumulativeAmount = Types.uint96(250n)
    const payload = await ChannelOps.createVoucherPayload(
      client,
      account,
      descriptor,
      cumulativeAmount,
      chainId,
    )
    if (payload.action !== 'voucher') throw new Error('expected voucher payload')

    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.cumulativeAmount).toBe('250')
    expect(
      Voucher.verifyVoucher(
        tip20ChannelEscrow,
        chainId,
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
      ),
    ).toBe(true)
  })

  test('binds voucher channel ID and signature domain to the provided escrow', async () => {
    const escrow = '0x0000000000000000000000000000000000000005' as Address
    const cumulativeAmount = Types.uint96(260n)
    const expectedChannelId = Channel.computeId({ ...descriptor, chainId, escrow })
    const payload = await ChannelOps.createVoucherPayload(
      client,
      account,
      descriptor,
      cumulativeAmount,
      chainId,
      escrow,
    )

    expect(payload.channelId).toBe(expectedChannelId)
    expect(
      Voucher.verifyVoucher(
        escrow,
        chainId,
        { channelId: expectedChannelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
      ),
    ).toBe(true)
  })

  test('uses the payer as voucher signer when descriptor authorizedSigner is zero', async () => {
    const zeroSignerDescriptor = {
      ...descriptor,
      authorizedSigner: zeroAddress,
    }
    const zeroSignerChannelId = Channel.computeId({
      ...zeroSignerDescriptor,
      chainId,
      escrow: tip20ChannelEscrow,
    })
    const cumulativeAmount = Types.uint96(275n)
    const payload = await ChannelOps.createVoucherPayload(
      client,
      account,
      zeroSignerDescriptor,
      cumulativeAmount,
      chainId,
    )
    if (payload.action !== 'voucher') throw new Error('expected voucher payload')

    expect(payload.channelId).toBe(zeroSignerChannelId)
    expect(
      Voucher.verifyVoucher(
        tip20ChannelEscrow,
        chainId,
        { channelId: zeroSignerChannelId, cumulativeAmount, signature: payload.signature },
        descriptor.payer,
      ),
    ).toBe(true)
  })

  test('creates a close credential with a verifiable voucher signature', async () => {
    const cumulativeAmount = Types.uint96(300n)
    const payload = await ChannelOps.createClosePayload(
      client,
      account,
      descriptor,
      cumulativeAmount,
      chainId,
    )
    if (payload.action !== 'close') throw new Error('expected close payload')

    expect(payload.channelId).toBe(channelId)
    expect(payload.cumulativeAmount).toBe('300')
    expect(
      Voucher.verifyVoucher(
        tip20ChannelEscrow,
        chainId,
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
      ),
    ).toBe(true)
  })

  test('distinguishes otherwise-identical fee-sponsored management transactions', async () => {
    mocks.prepareTransactionRequest.mockClear()
    let randomValue = 1
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (!array) return array
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(randomValue++)
      return array
    })
    try {
      await ChannelOps.createTopUpPayload(client, account, descriptor, 10n, chainId, true)
      await ChannelOps.createTopUpPayload(client, account, descriptor, 10n, chainId, true)
    } finally {
      random.mockRestore()
    }

    const requests = mocks.prepareTransactionRequest.mock.calls.map(([, request]) => request)
    const validAfter = requests.map((request) =>
      Number((request as { validAfter?: number }).validAfter),
    )
    const now = Math.floor(Date.now() / 1_000)

    expect(requests).toMatchObject([
      { feePayer: true, nonceKey: 'expiring', validAfter: expect.any(Number) },
      { feePayer: true, nonceKey: 'expiring', validAfter: expect.any(Number) },
    ])
    expect(new Set(validAfter).size).toBe(2)
    expect(validAfter.every((value) => value >= 0 && value < now)).toBe(true)
  })

  test('uses expiring nonces and entropy for unsponsored management transactions', async () => {
    mocks.prepareTransactionRequest.mockClear()

    await ChannelOps.createTopUpPayload(client, account, descriptor, 10n, chainId, false)

    expect(mocks.prepareTransactionRequest).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        nonceKey: 'expiring',
        validAfter: expect.any(Number),
      }),
    )
    expect(mocks.prepareTransactionRequest.mock.calls[0]?.[1]).not.toHaveProperty('feePayer')
  })

  test('distinguishes otherwise-identical opens that share a salt', async () => {
    mocks.prepareTransactionRequest.mockClear()
    let randomValue = 1
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (!array) return array
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(randomValue++)
      return array
    })
    const parameters = {
      chainId,
      deposit: 100n,
      initialAmount: 1n,
      payee: descriptor.payee,
      salt: descriptor.salt,
      token: descriptor.token,
    }
    try {
      for (let i = 0; i < 2; i++) {
        mocks.signTransaction.mockRejectedValueOnce(new Error('stop after prepare'))
        await expect(ChannelOps.createOpenPayload(client, account, parameters)).rejects.toThrow(
          'stop after prepare',
        )
      }
    } finally {
      random.mockRestore()
    }

    const validAfter = mocks.prepareTransactionRequest.mock.calls.map(([, request]) =>
      Number((request as { validAfter?: number }).validAfter),
    )
    const now = Math.floor(Date.now() / 1_000)
    expect(validAfter).toHaveLength(2)
    expect(new Set(validAfter).size).toBe(2)
    expect(validAfter.every((value) => value >= 0 && value < now)).toBe(true)
  })
})

describe('TIP-1166 configurable account signers', () => {
  const ownerA = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
  const ownerB = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
  const configurable = TempoAccount.fromConfig({ owners: [ownerA, ownerB], threshold: 2 })
  const localCommitment = AccountConfig.getCommitment(configurable.config!)

  function commitmentClient(commitment: Hex.Hex, calls: string[] = []) {
    return createClient({
      account: configurable,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          calls.push(args.method)
          if (args.method === 'eth_call')
            return encodeFunctionResult({
              abi: Abis.configurableAccount,
              functionName: 'getConfigCommitment',
              result: commitment,
            })
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      }),
    })
  }

  test('signs vouchers only for a channel whose signer rules accept its config', () => {
    const rotated = TempoAccount.fromConfig({
      address: configurable.address,
      owners: [ownerA],
      salt: configurable.config!.salt,
      threshold: 1,
      version: 1,
    })
    const descriptor = (salt: Hex.Hex) =>
      ({
        payer: configurable.address,
        payee: account.address,
        operator: zeroAddress,
        token: account.address,
        salt,
        authorizedSigner: configurable.address,
        expiringNonceHash: `0x${'00'.repeat(32)}`,
      }) as Channel.ChannelDescriptor
    const randomSalt = Hex.random(32)
    // A zero-commitment channel (random salt) settles the version-zero config that derives the signer.
    expect(() =>
      ChannelOps.assertCanSignVoucher(configurable, descriptor(randomSalt)),
    ).not.toThrow()
    // A config the channel recorded as its opening commitment (the salt) settles.
    const rotatedCommitment = AccountConfig.getCommitment(rotated.config!)
    expect(() =>
      ChannelOps.assertCanSignVoucher(rotated, descriptor(rotatedCommitment)),
    ).not.toThrow()
    // A rotated config on a zero-commitment channel would not settle.
    expect(() => ChannelOps.assertCanSignVoucher(rotated, descriptor(randomSalt))).toThrow(
      /cannot sign a voucher the channel settles/,
    )
    // Primitive accounts keep signing primitive vouchers.
    expect(() => ChannelOps.assertCanSignVoucher(account, descriptor(randomSalt))).not.toThrow()
  })

  test('detects configurable account signers', () => {
    expect(ChannelOps.isConfigurableSigner(configurable)).toBe(true)
    expect(ChannelOps.isConfigurableSigner(account)).toBe(false)
    const accessKey = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey(), {
      access: configurable,
    })
    expect(ChannelOps.isConfigurableSigner(accessKey)).toBe(false)
  })

  test('treats a configurable access key as a configurable signer', () => {
    // A configurable account access key (TIP-1111) signs vouchers raw as the configurable account.
    const configurableKey = TempoAccount.fromConfig(
      { owners: [ownerA, ownerB], threshold: 2 },
      { access: account },
    )
    expect(ChannelOps.isConfigurableSigner(configurableKey)).toBe(true)
    const rotatedKey = TempoAccount.fromConfig(
      {
        address: configurable.address,
        owners: [ownerA],
        salt: configurable.config!.salt,
        threshold: 1,
        version: 1,
      },
      { access: account },
    )
    const descriptor = {
      payer: account.address,
      payee: account.address,
      operator: zeroAddress,
      token: account.address,
      salt: Hex.random(32),
      authorizedSigner: configurable.address,
      expiringNonceHash: `0x${'00'.repeat(32)}`,
    } as Channel.ChannelDescriptor
    // Its rotated config would not settle on a zero-commitment channel.
    expect(() => ChannelOps.assertCanSignVoucher(rotatedKey, descriptor)).toThrow(
      /cannot sign a voucher the channel settles/,
    )
  })

  test('keeps a random salt for other accounts without an RPC call', async () => {
    const salt = await ChannelOps.resolveOpenSalt(client, account)
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
    expect(await ChannelOps.resolveOpenSalt(client, account)).not.toBe(salt)
  })

  test("opens with a registered configurable account's commitment", async () => {
    const calls: string[] = []
    expect(
      await ChannelOps.resolveOpenSalt(commitmentClient(localCommitment, calls), configurable),
    ).toBe(localCommitment)
    expect(calls).toEqual(['eth_call'])
  })

  test("opens an unregistered configurable account with its version-zero config's commitment", async () => {
    expect(
      await ChannelOps.resolveOpenSalt(commitmentClient(`0x${'00'.repeat(32)}`), configurable),
    ).toBe(localCommitment)
  })

  test('rejects a configurable account whose config is stale', async () => {
    await expect(
      ChannelOps.resolveOpenSalt(commitmentClient(`0x${'77'.repeat(32)}`), configurable),
    ).rejects.toThrow('does not match its on-chain commitment')
  })

  test.each([
    { errorName: 'SignerConfigChanged' as const },
    { errorName: 'RootKeyRetired' as const },
  ])('maps a $errorName top-up revert to SignerConfigChangedError', async ({ errorName }) => {
    const data = encodeErrorResult({ abi: escrowAbi, errorName, args: [account.address] })
    mocks.prepareTransactionRequest.mockImplementationOnce(async () => {
      throw Object.assign(new Error('execution reverted'), { data })
    })
    const error = await ChannelOps.createTopUpPayload(
      client,
      account,
      descriptor,
      10n,
      chainId,
      false,
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Errors.SignerConfigChangedError)
    expect(error).toMatchObject({ channelId, reason: errorName, signer: account.address })
  })

  test('leaves other top-up reverts unmapped', async () => {
    const data = encodeErrorResult({
      abi: escrowAbi,
      errorName: 'SignerConfigChanged',
      args: [descriptor.payee],
    })
    mocks.prepareTransactionRequest.mockImplementationOnce(async () => {
      throw Object.assign(new Error('execution reverted'), { data })
    })
    const error = await ChannelOps.createTopUpPayload(
      client,
      account,
      descriptor,
      10n,
      chainId,
      false,
    ).catch((error: unknown) => error)
    expect(error).not.toBeInstanceOf(Errors.SignerConfigChangedError)
  })
})
