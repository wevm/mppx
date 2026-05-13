import { Signature } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import type { Account, Address, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'

import * as TempoAddress from '../internal/address.js'
import { tip20ChannelEscrow } from './Constants.js'
import type { Uint96 } from './Types.js'
import { uint96 } from './Types.js'

const domainName = 'TIP20 Channel Escrow'
const domainVersion = '1'

export type Voucher = {
  channelId: Hex
  cumulativeAmount: Uint96
}

export type SignedVoucher = Voucher & { signature: Hex }

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

/** EIP-712 domain for TIP-1034 channel escrow vouchers. */
export function domain(chainId: number, verifyingContract: Address = tip20ChannelEscrow) {
  return {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract,
  } as const
}

/** EIP-712 voucher type for TIP-1034 channel escrow vouchers. */
export const types = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint96' },
  ],
} as const

/** Signs a TIP-1034 voucher and unwraps keychain signatures for delegated secp256k1 signers. */
export async function sign(
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
    domain: domain(parameters.chainId, parameters.verifyingContract),
    types,
    primaryType: 'Voucher',
    message: voucher,
  })

  if (parameters.authorizedSigner) {
    try {
      const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
      if (envelope.type === 'keychain' && envelope.inner.type === 'secp256k1')
        return Signature.toHex(envelope.inner.signature)
    } catch {}
  }

  return signature
}

/** Verifies a direct TIP-1034 voucher signature and rejects keychain wrapper signatures. */
export function verify(
  voucher: SignedVoucher,
  expectedSigner: Address,
  parameters: { chainId: number; verifyingContract?: Address | undefined },
): boolean {
  try {
    const envelope = SignatureEnvelope.from(voucher.signature as SignatureEnvelope.Serialized)
    if (envelope.type === 'keychain') return false

    const payload = hashTypedData({
      domain: domain(parameters.chainId, parameters.verifyingContract),
      types,
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
