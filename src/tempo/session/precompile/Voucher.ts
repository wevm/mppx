import { Channel, SignatureEnvelope } from 'ox/tempo'
import type { Account, Address, Client, Hex } from 'viem'
import { hashTypedData } from 'viem'
import { signTypedData } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'

import * as TempoAddress from '../../internal/address.js'
import * as ConfigurableAccount from '../../internal/configurable-account.js'
import { isLowS, toLowS } from '../../internal/signature.js'
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

/** EIP-712 type that distinguishes cooperative close authorization from a voucher. */
export const closeAuthorizationTypes = {
  CloseAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint96' },
  ],
} as const

function getCloseAuthorizationPayload(
  verifyingContract: Address,
  chainId: number,
  authorization: Voucher,
): Hex {
  return hashTypedData({
    domain: getVoucherDomain(verifyingContract, chainId),
    types: closeAuthorizationTypes,
    primaryType: 'CloseAuthorization',
    message: authorization,
  })
}

function getVoucherDigest(chainId: number, voucher: Voucher): Hex {
  return Channel.getVoucherSignPayload({
    chainId,
    channelId: voucher.channelId,
    cumulativeAmount: voucher.cumulativeAmount,
  }) as Hex
}

function getVoucherPayload(verifyingContract: Address, chainId: number, voucher: Voucher): Hex {
  if (verifyingContract.toLowerCase() === Channel.address.toLowerCase())
    return getVoucherDigest(chainId, voucher)
  return hashTypedData({
    domain: getVoucherDomain(verifyingContract, chainId),
    types: voucherTypes,
    primaryType: 'Voucher',
    message: {
      channelId: voucher.channelId,
      cumulativeAmount: voucher.cumulativeAmount,
    },
  })
}

/**
 * Options for verifying TIP-1166 configurable account voucher signers.
 *
 * With the defaults, verification accepts only TIP-1020 primitive signatures, as before TIP-1166.
 */
export type VerifyVoucherOptions = {
  /**
   * Accepts TIP-1166 configurable account (`0x05`) signatures from a configurable account
   * signer. Enable only once the chain runs T15.
   * @default false
   */
  configurable?: boolean | undefined
  /**
   * Config commitment the escrow recorded for the channel signer at open
   * (`OpeningCommitmentRecorded`). A missing or zero opening commitment means the signer had no config
   * commitment when the channel opened.
   */
  openingCommitment?: Hex | undefined
}

/**
 * Verifies a canonical serialized signature against one expected signer under the TIP-1034 and
 * TIP-1166 rules. Keychain signatures are always rejected.
 */
function verifySignerSignature(
  signature: Hex,
  payload: Hex,
  expectedSigner: Address,
  options: VerifyVoucherOptions,
): boolean {
  const envelope = parseCanonicalEnvelope(signature)
  if (!envelope) return false
  return verifySignerEnvelope(envelope, payload, expectedSigner, options)
}

/** Parses a serialized signature envelope, or returns undefined unless it is canonical. */
function parseCanonicalEnvelope(signature: Hex): SignatureEnvelope.SignatureEnvelope | undefined {
  const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
  if (SignatureEnvelope.serialize(envelope).toLowerCase() !== signature.toLowerCase())
    return undefined
  return envelope
}

/** Verifies a parsed canonical signature envelope against one expected signer. */
function verifySignerEnvelope(
  envelope: SignatureEnvelope.SignatureEnvelope,
  payload: Hex,
  expectedSigner: Address,
  options: VerifyVoucherOptions,
): boolean {
  if (envelope.type === 'configurable') {
    if (!options.configurable) return false
    return ConfigurableAccount.verify(envelope, {
      account: expectedSigner,
      commitment: options.openingCommitment,
      payload,
    })
  }

  if (!ConfigurableAccount.isPrimitiveEnvelope(envelope.type)) return false
  // Tempo settlement rejects high-s signatures, so a voucher carrying one could never be collected.
  if (!isLowS(envelope)) return false
  // A channel whose signer had a config commitment at open accepts only that config's approvals.
  if (!ConfigurableAccount.isZeroCommitment(options.openingCommitment)) return false
  const signer = SignatureEnvelope.extractAddress({ payload, signature: envelope })
  const valid = SignatureEnvelope.verify(envelope, { address: signer, payload })
  return valid && TempoAddress.isEqual(signer, expectedSigner)
}

/** Returns whether an account signs with a TIP-1166 configurable account (`0x05`) signature. */
export function isConfigurableAccount(account: Account): boolean {
  return (account as { source?: unknown }).source === 'configurable'
}

/** Detects a viem/tempo access key account the same way `Account.signVoucher` does. */
function isAccessKeyAccount(account: Account): account is TempoAccount.AccessKeyAccount {
  return account.source === 'accessKey' && 'accessKeyAddress' in account
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
 */
export async function signVoucher(
  client: Client,
  account: Account,
  voucher: Voucher,
  verifyingContract: Address,
  chainId: number,
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
  if (!ConfigurableAccount.isPrimitiveEnvelope(envelope.type) && envelope.type !== 'configurable')
    throw new Error(
      `TIP-1034 vouchers require a TIP-1020 primitive or TIP-1166 configurable account signature; received "${envelope.type}".`,
    )

  return SignatureEnvelope.serialize(toLowS(envelope))
}

/**
 * Signs a distinct EIP-712 authorization for cooperatively closing a channel.
 */
export async function signCloseAuthorization(
  client: Client,
  account: Account,
  authorization: Voucher,
  verifyingContract: Address,
  chainId: number,
): Promise<Hex> {
  // `signTypedData` wraps access key signatures in a keychain envelope, which
  // TIP-1034 rejects. Sign the hash raw instead, as viem/tempo's
  // `Account.signVoucher` does for vouchers: the access key is the channel's
  // authorized signer.
  const signature = isAccessKeyAccount(account)
    ? await account.sign({
        hash: getCloseAuthorizationPayload(verifyingContract, chainId, authorization),
        raw: true,
      })
    : await signTypedData(client, {
        account,
        domain: getVoucherDomain(verifyingContract, chainId),
        types: closeAuthorizationTypes,
        primaryType: 'CloseAuthorization',
        message: authorization,
      })
  const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
  if (!ConfigurableAccount.isPrimitiveEnvelope(envelope.type) && envelope.type !== 'configurable')
    throw new Error(
      `TIP-1034 close authorizations require a TIP-1020 primitive or TIP-1166 configurable account signature; received "${envelope.type}".`,
    )
  return SignatureEnvelope.serialize(toLowS(envelope))
}

/** Options for {@link verifyCloseAuthorization}. */
export type VerifyCloseAuthorizationOptions = VerifyVoucherOptions & {
  /**
   * The channel's voucher signer. The configurable account rules apply only to the candidate equal
   * to it; other candidates, such as a distinct payer, must sign a primitive signature, since no
   * opening commitment binds their config. Without it, the options apply to every candidate.
   */
  voucherSigner?: Address | undefined
}

/**
 * Verifies that a cooperative-close signature belongs to a channel authority.
 *
 * `options` applies the TIP-1166 configurable account rules of {@link verifyVoucher}; the
 * defaults accept only TIP-1020 primitive signatures.
 */
export function verifyCloseAuthorization(
  escrowContract: Address,
  chainId: number,
  authorization: SignedVoucher,
  expectedSigners: readonly Address[],
  options: VerifyCloseAuthorizationOptions = {},
): boolean {
  try {
    const payload = getCloseAuthorizationPayload(escrowContract, chainId, authorization)
    const { voucherSigner, ...voucherOptions } = options
    // Parse once: every candidate checks the same envelope.
    const envelope = parseCanonicalEnvelope(authorization.signature)
    if (!envelope) return false
    return expectedSigners.some((expected) =>
      verifySignerEnvelope(
        envelope,
        payload,
        expected,
        // The opening commitment binds only the voucher signer's config. Another candidate's
        // configurable signature could only be checked against its version-zero config, which a
        // later rotation supersedes, so it is rejected.
        !voucherSigner || TempoAddress.isEqual(expected, voucherSigner) ? voucherOptions : {},
      ),
    )
  } catch {
    return false
  }
}

/**
 * Verify a voucher signature matches the expected signer.
 *
 * By default, accepts canonical TIP-1020 primitive signatures only. Keychain wrappers,
 * configurable account signatures, and magic-suffixed encodings are rejected.
 *
 * With `options.configurable`, also applies TIP-1166: a configurable account (`0x05`)
 * signature is accepted when it names `expectedSigner`, its owner approvals reach the
 * threshold, and its config commitment equals `options.openingCommitment` or, when the channel
 * has no opening commitment, its config is the version-zero config that derives `expectedSigner`. A
 * nonzero `openingCommitment` rejects primitive signatures.
 */
export function verifyVoucher(
  escrowContract: Address,
  chainId: number,
  voucher: SignedVoucher,
  expectedSigner: Address,
  options: VerifyVoucherOptions = {},
): boolean {
  try {
    const payload = getVoucherPayload(escrowContract, chainId, voucher)
    return verifySignerSignature(voucher.signature, payload, expectedSigner, options)
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
