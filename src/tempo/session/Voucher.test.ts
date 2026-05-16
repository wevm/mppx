import { SignatureEnvelope } from 'ox/tempo'
import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account as TempoAccount, WebCryptoP256 } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import { parseVoucherFromPayload, signVoucher, verifyVoucher } from './Voucher.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const escrowContract = '0x1234567890abcdef1234567890abcdef12345678' as const
const chainId = 42431

const client = createClient({
  account,
  transport: http('http://127.0.0.1'), // only used for local signTypedData
})

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const
const cumulativeAmount = 1000000n

describe('Voucher', () => {
  test('signVoucher and verifyVoucher round-trip', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)
    expect(signature.length).toBe(132)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })

  test('signVoucher and verifyVoucher round-trip with WebCrypto P256', async () => {
    const keyPair = await WebCryptoP256.createKeyPair()
    const p256Account = TempoAccount.fromWebCryptoP256(keyPair)
    const p256Client = createClient({
      account: p256Account,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signVoucher(
      p256Client,
      p256Account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)

    expect(envelope.type).toBe('p256')
    if (envelope.type !== 'p256') throw new Error('unexpected signature type')
    expect(envelope.prehash).toBe(true)
    expect(signature.length).toBe(262)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      p256Account.address,
    )
    expect(isValid).toBe(true)
  })

  test('verifyVoucher rejects keychain envelopes', async () => {
    const keyPair = await WebCryptoP256.createKeyPair()
    const p256Account = TempoAccount.fromWebCryptoP256(keyPair)
    const p256Client = createClient({
      account: p256Account,
      transport: http('http://127.0.0.1'),
    })
    const signature = await signVoucher(
      p256Client,
      p256Account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const keychainSignature = SignatureEnvelope.serialize({
      type: 'keychain',
      version: 'v2',
      userAddress: account.address,
      inner: SignatureEnvelope.from(signature as SignatureEnvelope.Serialized),
    })

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: keychainSignature },
      p256Account.address,
    )
    expect(isValid).toBe(false)
  })

  test('signVoucher rejects keychain signer accounts', async () => {
    const accessKey = TempoAccount.fromSecp256k1(
      '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d',
      { access: account },
    )
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    await expect(
      signVoucher(
        accessKeyClient,
        accessKey,
        { channelId, cumulativeAmount },
        escrowContract,
        chainId,
        accessKey.accessKeyAddress,
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Session vouchers must be signed directly by authorizedSigner; pass a direct voucherSigner instead of a keychain account.]`,
    )
  })

  test('verifyVoucher rejects wrong signer', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongAddress = '0x0000000000000000000000000000000000000001' as const
    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      wrongAddress,
    )
    expect(isValid).toBe(false)
  })

  test('verifyVoucher rejects tampered amount', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: 9999999n, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verifyVoucher rejects tampered channelId', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongChannelId =
      '0x0000000000000000000000000000000000000000000000000000000000000099' as const
    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId: wrongChannelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verifyVoucher rejects wrong chain ID', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = await verifyVoucher(
      escrowContract,
      99999,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verifyVoucher returns false for invalid signature', async () => {
    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: '0xdeadbeef' },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('parseVoucherFromPayload', () => {
    const sig =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '5000000', sig)
    expect(voucher.channelId).toBe(channelId)
    expect(voucher.cumulativeAmount).toBe(5000000n)
    expect(voucher.signature).toBe(sig)
  })

  test('parseVoucherFromPayload with zero amount', () => {
    const sig =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '0', sig)
    expect(voucher.cumulativeAmount).toBe(0n)
  })

  test('verifyVoucher rejects wrong escrow contract', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongEscrow = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const
    const isValid = await verifyVoucher(
      wrongEscrow,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('signVoucher and verifyVoucher round-trip with zero amount', async () => {
    const zeroAmount = 0n
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount: zeroAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: zeroAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })
})
