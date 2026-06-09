import { P256, Secp256k1, Signature } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import { createClient, http, type Account, type Hex } from 'viem'
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

  test('signVoucher rejects direct WebCrypto P256 voucher signatures', async () => {
    const keyPair = await WebCryptoP256.createKeyPair()
    const p256Account = TempoAccount.fromWebCryptoP256(keyPair)
    const p256Client = createClient({
      account: p256Account,
      transport: http('http://127.0.0.1'),
    })

    await expect(
      signVoucher(
        p256Client,
        p256Account,
        { channelId, cumulativeAmount },
        escrowContract,
        chainId,
      ),
    ).rejects.toThrow('Session vouchers only support secp256k1 signatures')
  })

  test('signVoucher rejects direct WebAuthn voucher signatures', async () => {
    const webAuthnAccount = TempoAccount.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
      origin: 'https://example.com',
      rpId: 'example.com',
    })
    const webAuthnClient = createClient({
      account: webAuthnAccount,
      transport: http('http://127.0.0.1'),
    })

    await expect(
      signVoucher(
        webAuthnClient,
        webAuthnAccount,
        { channelId, cumulativeAmount },
        escrowContract,
        chainId,
      ),
    ).rejects.toThrow('Session vouchers only support secp256k1 signatures')
  })

  test('signVoucher signs v1 secp256k1 access keys with raw signatures', async () => {
    const accessKey = TempoAccount.fromSecp256k1(
      '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d',
      { access: account, internal_version: 'v1' },
    )
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signVoucher(
      accessKeyClient,
      accessKey,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)

    expect(envelope.type).toBe('secp256k1')
    expect(signature.length).toBe(132)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      accessKey.accessKeyAddress,
    )
    expect(isValid).toBe(true)
  })

  test('signVoucher unwraps legacy secp256k1 keychain signatures', async () => {
    const privateKey = '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d'
    const rawAccessKey = TempoAccount.fromSecp256k1(privateKey)
    const keychainSigner = {
      accessKeyAddress: rawAccessKey.address,
      address: account.address,
      async sign({ hash }: { hash: Hex }) {
        const inner = SignatureEnvelope.from(
          Signature.toHex(Secp256k1.sign({ payload: hash, privateKey })),
        )
        return SignatureEnvelope.serialize({
          type: 'keychain',
          version: 'v1',
          userAddress: account.address,
          inner,
        })
      },
    } as unknown as Account

    const signature = await signVoucher(
      client,
      keychainSigner,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)

    expect(envelope.type).toBe('secp256k1')
    expect(signature.length).toBe(132)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      rawAccessKey.address,
    )
    expect(isValid).toBe(true)
  })

  test('signVoucher signs v2 secp256k1 access keys with raw signatures', async () => {
    const accessKey = TempoAccount.fromSecp256k1(
      '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d',
      { access: account },
    )
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signVoucher(
      accessKeyClient,
      accessKey,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)

    expect(envelope.type).toBe('secp256k1')
    expect(signature.length).toBe(132)

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      accessKey.accessKeyAddress,
    )
    expect(isValid).toBe(true)
  })

  test('verifyVoucher rejects keychain envelopes', async () => {
    const privateKey = '0x59c6995e998f97a5a0044966f09453863d462d2b3f1446a99f0a3d7b5d0f5a0d'
    const inner = SignatureEnvelope.from(
      Signature.toHex(Secp256k1.sign({ payload: channelId, privateKey })),
    )
    const keychainSignature = SignatureEnvelope.serialize({
      type: 'keychain',
      version: 'v2',
      userAddress: account.address,
      inner,
    })

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: keychainSignature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('signVoucher signs non-secp256k1 access keys without keychain envelopes', async () => {
    const accessKey = TempoAccount.fromP256(P256.randomPrivateKey(), {
      access: account,
      internal_version: 'v1',
    })
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
      ),
    ).rejects.toThrow('Session vouchers only support secp256k1 signatures')
  })

  test('verifyVoucher rejects magic-suffixed secp256k1 signatures', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const signatureWithMagic = SignatureEnvelope.serialize(SignatureEnvelope.from(signature), {
      magic: true,
    })

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: signatureWithMagic },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verifyVoucher rejects EIP-155-style secp256k1 v values', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const signatureWithEip155V = `${signature.slice(0, -2)}${
      signature.endsWith('1b') ? '23' : '24'
    }` as `0x${string}`

    const isValid = await verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: signatureWithEip155V },
      account.address,
    )
    expect(isValid).toBe(false)
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
