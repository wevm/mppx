import type { Account, Address, Hex, WalletClient } from 'viem'
import { recoverTypedDataAddress } from 'viem'
import type { SignedVoucher, Voucher } from './Types.js'

/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR name. */
const DOMAIN_NAME = 'Tempo Stream Channel'
/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR version. */
const DOMAIN_VERSION = '1'

/**
 * EIP-712 domain for voucher signing.
 */
function getVoucherDomain(escrowContract: Address, chainId: number) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: escrowContract,
  } as const
}

/**
 * EIP-712 types for voucher signing.
 * Matches @tempo/stream-channels/voucher and on-chain VOUCHER_TYPEHASH.
 */
const voucherTypes = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint128' },
  ],
} as const

/**
 * Sign a voucher with an account.
 */
export async function signVoucher(
  client: WalletClient,
  account: Account,
  message: Voucher,
  escrowContract: Address,
  chainId: number,
): Promise<Hex> {
  return client.signTypedData({
    account,
    domain: getVoucherDomain(escrowContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: {
      channelId: message.channelId,
      cumulativeAmount: message.cumulativeAmount,
    },
  })
}

/**
 * Verify a voucher signature matches the expected signer.
 */
export async function verifyVoucher(
  escrowContract: Address,
  chainId: number,
  voucher: SignedVoucher,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: {
        channelId: voucher.channelId,
        cumulativeAmount: voucher.cumulativeAmount,
      },
      signature: voucher.signature,
    })
    return signer.toLowerCase() === expectedSigner.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Parse a voucher from credential payload.
 */
export function parseVoucherFromPayload(
  channelId: Hex,
  cumulativeAmount: string,
  signature: Hex,
): SignedVoucher {
  return {
    channelId,
    cumulativeAmount: BigInt(cumulativeAmount),
    signature,
  }
}
