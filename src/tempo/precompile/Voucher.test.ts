import { P256, Secp256k1 } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import { createClient, hashTypedData, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTypedData } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import { uint96 } from './Types.js'
import {
  getVoucherDomain,
  parseVoucherFromPayload,
  signVoucher,
  voucherTypes,
  verifyVoucher,
} from './Voucher.js'

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
const cumulativeAmount = uint96(1_000_000n)

describe('Precompile Voucher', () => {
  test('sign and verify round-trip', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)
    expect(signature.length).toBe(132)

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })

  test('verify rejects wrong signer', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongAddress = '0x0000000000000000000000000000000000000001' as const
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      wrongAddress,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects tampered amount', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: uint96(9_999_999n), signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects tampered channelId', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongChannelId =
      '0x0000000000000000000000000000000000000000000000000000000000000099' as const
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId: wrongChannelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects wrong chain ID', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = verifyVoucher(
      escrowContract,
      99999,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verify returns false for invalid signature', () => {
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: '0xdeadbeef' },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('parseVoucherFromPayload', () => {
    const signature =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '5000000', signature)
    expect(voucher.channelId).toBe(channelId)
    expect(voucher.cumulativeAmount).toBe(5_000_000n)
    expect(voucher.signature).toBe(signature)
  })

  test('parseVoucherFromPayload with zero amount', () => {
    const signature =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '0', signature)
    expect(voucher.cumulativeAmount).toBe(0n)
  })

  test('parseVoucherFromPayload rejects amounts outside uint96 bounds', () => {
    const signature = '0xdeadbeef' as const
    expect(() => parseVoucherFromPayload(channelId, '-1', signature)).toThrow(
      'outside uint96 bounds',
    )
    expect(() => parseVoucherFromPayload(channelId, (1n << 96n).toString(), signature)).toThrow(
      'outside uint96 bounds',
    )
  })

  test('verify rejects wrong escrow contract', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongEscrow = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const
    const isValid = verifyVoucher(
      wrongEscrow,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('sign and verify round-trip with zero amount', async () => {
    const zeroAmount = uint96(0n)
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount: zeroAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: zeroAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })

  test('verify rejects direct keychain wrapper signatures', async () => {
    const signature = await signTypedData(client, {
      account,
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    const wrapped = SignatureEnvelope.serialize(
      {
        inner: envelope,
        type: 'keychain',
        userAddress: account.address,
        version: 'v1',
      },
      { magic: true },
    )

    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: wrapped },
        account.address,
      ),
    ).toBe(false)
  })

  test('sign rejects p256 keychain access-key voucher delegation explicitly', async () => {
    const rootAccount = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
    const accessKey = TempoAccount.fromP256(P256.randomPrivateKey(), {
      access: rootAccount,
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
        accessKey.accessKeyAddress,
      ),
    ).rejects.toThrow('TIP-1034 voucher signing only supports secp256k1 keychain access keys.')
  })

  test('domain and type match TIP-1034', () => {
    expect(getVoucherDomain(escrowContract, chainId)).toEqual({
      name: 'TIP20 Channel Escrow',
      version: '1',
      chainId,
      verifyingContract: escrowContract,
    })
    expect(voucherTypes.Voucher).toEqual([
      { name: 'channelId', type: 'bytes32' },
      { name: 'cumulativeAmount', type: 'uint96' },
    ])
    expect(
      hashTypedData({
        domain: getVoucherDomain(escrowContract, chainId),
        types: voucherTypes,
        primaryType: 'Voucher',
        message: { channelId, cumulativeAmount },
      }),
    ).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
