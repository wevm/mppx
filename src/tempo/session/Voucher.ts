import type { Address } from 'ox'
import { SignatureEnvelope } from 'ox/tempo'
import type { Account, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'

import type { SignedVoucher, Voucher } from './Types.js'

/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR name. */
const DOMAIN_NAME = 'Tempo Stream Channel'
/** Must match the on-chain TempoStreamChannel DOMAIN_SEPARATOR version. */
const DOMAIN_VERSION = '1'

/**
 * EIP-712 domain for voucher signing.
 */
function getVoucherDomain(escrowContract: Address.Address, chainId: number) {
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

function getVoucherMessage(message: Voucher) {
  return {
    channelId: message.channelId,
    cumulativeAmount: message.cumulativeAmount,
  }
}

function getVoucherDigest(escrowContract: Address.Address, chainId: number, message: Voucher) {
  return hashTypedData({
    domain: getVoucherDomain(escrowContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: getVoucherMessage(message),
  })
}

async function signVoucherDigest(
  client: Client,
  account: Account,
  message: Voucher,
  escrowContract: Address.Address,
  chainId: number,
): Promise<Hex> {
  const sign = (account as { sign?: ((parameters: { hash: Hex }) => Promise<Hex>) | undefined })
    .sign
  if (sign) return sign({ hash: getVoucherDigest(escrowContract, chainId, message) })

  return signTypedData(client, {
    account,
    domain: getVoucherDomain(escrowContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: getVoucherMessage(message),
  })
}

function normalizeVoucherSignature(signature: Hex): Hex {
  try {
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)

    if (envelope.type === 'keychain')
      throw new Error(
        'Session vouchers must be signed directly by authorizedSigner; pass a direct voucherSigner instead of a keychain account.',
      )

    // Tempo local accounts may append signature-envelope magic bytes for RPC
    // routing. Voucher signatures are direct TIP-1020 envelopes.
    return SignatureEnvelope.serialize(envelope)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Session vouchers must be signed'))
      throw error
  }

  return signature
}

/**
 * Sign a voucher with an account.
 */
export async function signVoucher(
  client: Client,
  account: Account,
  message: Voucher,
  escrowContract: Address.Address,
  chainId: number,
  authorizedSigner?: Address.Address | undefined,
  voucherSigner?: Account | undefined,
): Promise<Hex> {
  const signer = voucherSigner ?? account
  if ((signer as { accessKeyAddress?: Address.Address }).accessKeyAddress)
    throw new Error(
      'Session vouchers must be signed directly by authorizedSigner; pass a direct voucherSigner instead of a keychain account.',
    )
  if (authorizedSigner && signer.address.toLowerCase() !== authorizedSigner.toLowerCase())
    throw new Error('authorizedSigner must match voucher signer address')

  const signature = await signVoucherDigest(client, signer, message, escrowContract, chainId)

  return normalizeVoucherSignature(signature)
}

/**
 * Verify a voucher signature matches the expected signer.
 *
 * Accepts direct TIP-1020 signatures. Keychain envelopes are rejected because
 * direct voucher verification checks `authorizedSigner`, not wrapper metadata.
 */
export async function verifyVoucher(
  escrowContract: Address.Address,
  chainId: number,
  voucher: SignedVoucher,
  expectedSigner: Address.Address,
): Promise<boolean> {
  try {
    const envelope = SignatureEnvelope.from(voucher.signature)

    if (envelope.type === 'keychain') return false

    return SignatureEnvelope.verify(envelope, {
      address: expectedSigner,
      payload: getVoucherDigest(escrowContract, chainId, voucher),
    })
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
