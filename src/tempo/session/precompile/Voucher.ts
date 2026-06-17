import { Channel, SignatureEnvelope } from 'ox/tempo'
import type { Account, Address, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'

import * as TempoAddress from '../../internal/address.js'
import type { Voucher, SignedVoucher } from './Protocol.js'
import { uint96 } from './Protocol.js'

/** Must match the on-chain TIP-20 channel reserve DOMAIN_SEPARATOR name. */
const DOMAIN_NAME = 'TIP20 Channel Reserve'
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

function getVoucherDigest(chainId: number, voucher: Voucher): Hex {
  return Channel.getVoucherSignPayload({
    chainId,
    channelId: voucher.channelId,
    cumulativeAmount: voucher.cumulativeAmount,
  }) as Hex
}

/** EIP-712 / canonical digest a voucher signature is verified against. */
function getVoucherPayload(verifyingContract: Address, chainId: number, voucher: Voucher): Hex {
  if (verifyingContract.toLowerCase() === Channel.address.toLowerCase())
    return getVoucherDigest(chainId, voucher)
  return hashTypedData({
    domain: getVoucherDomain(verifyingContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: voucher,
  })
}

/**
 * Whether a signature envelope type is a TIP-1020 primitive (secp256k1, p256,
 * webAuthn). The TIP-1020 Signature Verification Precompile only verifies these
 * primitives for vouchers — keychain wrappers and multisig are rejected.
 */
function isPrimitive(type: string): boolean {
  return (SignatureEnvelope.types as readonly string[]).includes(type)
}

function signCanonicalTempoVoucher(
  account: Account,
  parameters: {
    chainId: number
    channelId: Hex
    cumulativeAmount: bigint
  },
) {
  // viem/tempo's canonical TIP-1034 voucher signer accepts Tempo account
  // extensions that are wider than viem's base Account type. Keep that
  // compatibility bridge here and fall back to generic EIP-712 below.
  return TempoAccount.signVoucher(account as never, {
    chainId: parameters.chainId,
    channel: parameters.channelId,
    cumulativeAmount: parameters.cumulativeAmount,
  })
}

/**
 * Sign a voucher with an account.
 *
 * Returns a TIP-1020 primitive signature (secp256k1, p256, or webAuthn). Access
 * keys sign the raw voucher digest, so they produce a primitive directly.
 * Keychain wrappers and multisig signatures are rejected — the TIP-1020
 * Signature Verification Precompile only verifies primitive voucher signatures.
 */
export async function signVoucher(
  client: Client,
  account: Account,
  voucher: Voucher,
  verifyingContract: Address,
  chainId: number,
  _authorizedSigner?: Address | undefined,
): Promise<Hex> {
  const signature = await (async () => {
    if (verifyingContract.toLowerCase() === Channel.address.toLowerCase()) {
      try {
        return await signCanonicalTempoVoucher(account, {
          chainId,
          channelId: voucher.channelId,
          cumulativeAmount: voucher.cumulativeAmount,
        })
      } catch {}
    }
    return signTypedData(client, {
      account,
      domain: getVoucherDomain(verifyingContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: voucher,
    })
  })()

  const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
  if (!isPrimitive(envelope.type))
    throw new Error(
      `TIP-1034 vouchers require a TIP-1020 primitive signature (secp256k1, p256, or webAuthn); received "${envelope.type}".`,
    )

  return SignatureEnvelope.serialize(envelope)
}

/**
 * Verify a voucher signature matches the expected signer.
 *
 * Accepts TIP-1020 primitive signatures (secp256k1, p256, webAuthn), which the
 * TIP-1020 Signature Verification Precompile verifies on-chain. Keychain
 * wrappers, multisig, and magic-suffixed encodings are rejected.
 */
export function verifyVoucher(
  escrowContract: Address,
  chainId: number,
  voucher: SignedVoucher,
  expectedSigner: Address,
): boolean {
  try {
    const envelope = SignatureEnvelope.from(voucher.signature as SignatureEnvelope.Serialized)

    if (!isPrimitive(envelope.type)) return false
    // Reject magic-suffixed or otherwise non-canonical encodings.
    if (SignatureEnvelope.serialize(envelope).toLowerCase() !== voucher.signature.toLowerCase())
      return false

    const payload = getVoucherPayload(escrowContract, chainId, voucher)
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
