import { Hex } from 'ox'
import { type Address, createClient, custom, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Channel from '../precompile/Channel.js'
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
  test('resolves escrow from override, challenge hint, or canonical default', () => {
    const override = '0x0000000000000000000000000000000000000005' as Address
    const hinted = '0x0000000000000000000000000000000000000006' as Address

    expect(
      ChannelOps.resolveEscrow(
        { request: { methodDetails: { escrowContract: hinted } } },
        override,
      ),
    ).toBe(override)
    expect(
      ChannelOps.resolveEscrow({ request: { methodDetails: { escrowContract: hinted } } }),
    ).toBe(hinted)
    expect(ChannelOps.resolveEscrow({ request: { methodDetails: { escrow: hinted } } })).toBe(
      hinted,
    )
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
})
