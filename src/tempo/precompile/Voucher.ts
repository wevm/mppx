import { Signature } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import type { Account, Address, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'

import * as TempoAddress from '../internal/address.js'
import { tip20ChannelEscrow } from './Constants.js'
import type { Voucher, SignedVoucher } from './Types.js'
import { uint96 } from './Types.js'

/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR name. */
const DOMAIN_NAME = 'TIP20 Channel Escrow'
/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR version. */
const DOMAIN_VERSION = '1'

/** EIP-712 domain for TIP-1034 channel escrow vouchers. */
export function getVoucherDomain(chainId: number, verifyingContract: Address = tip20ChannelEscrow) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const
}

/** EIP-712 voucher type for TIP-1034 channel escrow vouchers. */
export const voucherTypes = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint96' },
  ],
} as const

/**
 * Signs a TIP-1034 voucher.
 *
 * When `authorizedSigner` is a delegated access key, only secp256k1 keychain
 * signatures can be unwrapped into the raw ECDSA signature accepted by the
 * precompile. p256/WebAuthn keychain wrappers are rejected; pass an explicit
 * secp256k1 authorized signer for voucher delegation.
 */
export async function signVoucher(
  client: Client,
  account: Account,
  voucher: Voucher,
  parameters: {
    chainId: number
    verifyingContract?: Address | undefined
    authorizedSigner?: Address | undefined
  },
): Promise<Hex> {
  const signature = await signTypedData(client, {
    account,
    domain: getVoucherDomain(parameters.chainId, parameters.verifyingContract),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: voucher,
  })

  if (parameters.authorizedSigner) {
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
 * Verifies a direct TIP-1034 voucher signature.
 *
 * Only raw secp256k1 signatures are accepted. Keychain wrapper signatures are
 * rejected because the precompile verifies vouchers with ecrecover against the
 * channel's authorized signer.
 */
export function verifyVoucher(
  voucher: SignedVoucher,
  expectedSigner: Address,
  parameters: { chainId: number; verifyingContract?: Address | undefined },
): boolean {
  try {
    const envelope = SignatureEnvelope.from(voucher.signature as SignatureEnvelope.Serialized)
    if (envelope.type === 'keychain') return false

    const payload = hashTypedData({
      domain: getVoucherDomain(parameters.chainId, parameters.verifyingContract),
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

/** Parses a signed TIP-1034 voucher payload and brands its uint96 cumulative amount. */
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
