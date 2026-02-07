import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
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
})
