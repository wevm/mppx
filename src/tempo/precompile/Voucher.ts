import { Signature } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import type { Account, Address, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'

import * as TempoAddress from '../internal/address.js'
import type { Voucher, SignedVoucher } from './Types.js'
import { uint96 } from './Types.js'

/** Must match the on-chain TIP20 channel escrow DOMAIN_SEPARATOR name. */
const DOMAIN_NAME = 'TIP20 Channel Escrow'
/** Must match the on-chain TIP20 channel escrow DOMAIN_SEPARATOR version. */
const DOMAIN_VERSION = '1'

/**
 * EIP-712 domain for voucher signing.
 */
export function getVoucherDomain(escrowContract: Address, chainId: number) {
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
export const voucherTypes = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint96' },
  ],
} as const

/**
 * Sign a voucher with an account.
 */
export async function signVoucher(
  client: Client,
  account: Account,
  voucher: Voucher,
  verifyingContract: Address,
  chainId: number,
  authorizedSigner?: Address | undefined,
): Promise<Hex> {
  const signature = await signTypedData(client, {
    account,
    domain: getVoucherDomain(verifyingContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: voucher,
  })

  // When a separate authorizedSigner is used (e.g. access key), unwrap the
  // keychain envelope — the escrow contract verifies raw ECDSA signatures
  // against authorizedSigner, not keychain-wrapped ones.
  // TODO: when TIP-1020 is implemented, we can remove this.
  if (authorizedSigner) {
    const envelope = (() => {
      try {
        return SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
      } catch {
        return undefined
      }
    })()
    if (envelope?.type === 'keychain' && envelope.inner.type === 'secp256k1')
      return Signature.toHex(envelope.inner.signature)
    if (envelope?.type === 'keychain')
      throw new Error('TIP-1034 voucher signing only supports secp256k1 keychain access keys.')
  }

  return signature
}

/**
 * Verify a voucher signature matches the expected signer.
 *
 * Only accepts raw secp256k1 signatures — the escrow contract verifies
 * via ecrecover. Keychain, p256, and webAuthn signatures are rejected.
 */
export function verifyVoucher(
  escrowContract: Address,
  chainId: number,
  voucher: SignedVoucher,
  expectedSigner: Address,
): boolean {
  try {
    const envelope = SignatureEnvelope.from(voucher.signature as SignatureEnvelope.Serialized)

    // Reject keychain signatures — the escrow contract verifies raw ECDSA
    // signatures against authorizedSigner, not keychain-wrapped ones.
    if (envelope.type === 'keychain') return false

    const payload = hashTypedData({
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: {
        channelId: voucher.channelId,
        cumulativeAmount: voucher.cumulativeAmount,
      },
    })
    const signer = SignatureEnvelope.extractAddress({ payload, signature: envelope })
    const valid = SignatureEnvelope.verify(envelope, { address: signer, payload })
    return valid && TempoAddress.isEqual(signer, expectedSigner)
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
    cumulativeAmount: uint96(BigInt(cumulativeAmount)),
    signature,
  }
}
