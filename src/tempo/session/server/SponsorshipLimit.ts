import { Address, type Hex } from 'ox'
import { KeyAuthorization, SignatureEnvelope, TxEnvelopeTempo } from 'ox/tempo'

import type * as Store from '../../../Store.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'

/**
 * Sponsored opens, and separately sponsored top-ups, each verified payer may make per UTC day. It is
 * tempoxyz/mpp-proxy's `DAILY_CHANNEL_OPEN_LIMIT`, the limit its proxy applied to sponsored channel
 * opens before the limit moved into mppx.
 */
export const defaultPerDay = 5

/** Limits on fee-payer-sponsored channel opens and top-ups. */
export type Parameters = {
  /** Atomic store holding one usage record per payer and chain. */
  store: Store.AtomicStore
  /** Sponsored opens, and separately sponsored top-ups, per payer per UTC day. @default 5 */
  perDay?: number | undefined
}

/** Sponsored management transactions one payer made on one UTC day. */
type Usage = {
  day: string
  open: number
  topUp: number
}

type ItemMap = {
  [key: `mppx:session:sponsorship:${string}`]: Usage
}

/** Validates a configured limit. */
export function assertParameters(parameters: Parameters | undefined): void {
  const perDay = parameters?.perDay
  if (perDay !== undefined && (!Number.isSafeInteger(perDay) || perDay < 0))
    throw new Error('`sponsorshipLimit.perDay` must be a non-negative integer.')
}

/**
 * The address that provably produced `signature` over `payload`, or null. secp256k1 recovery is
 * inherently verified; P256 and WebAuthn envelopes carry a public key, so their signature is
 * checked against it. Multisig has no single signer.
 */
function verifiedSigner(
  payload: Hex.Hex,
  signature: SignatureEnvelope.SignatureEnvelope,
): Address.Address | null {
  if (signature.type === 'secp256k1')
    return SignatureEnvelope.extractAddress({ payload, signature })
  if (signature.type === 'p256' || signature.type === 'webAuthn') {
    const { publicKey } = signature
    return SignatureEnvelope.verify(signature, { payload, publicKey })
      ? Address.fromPublicKey(publicKey)
      : null
  }
  return null
}

/**
 * Returns the verified signer of a serialized Tempo transaction, lowercased, or null. A
 * credential's `source` is client-supplied and unverified at this point, and so are the 0x78
 * explicit sender slot and a keychain signature's account, so limits key on what the signatures
 * prove:
 * - a direct signature: its signer;
 * - an access key authorized in the same transaction: the account that signed the authorization,
 *   so fresh keys do not get a fresh quota;
 * - an access key authorized earlier: the key itself (its account link is only checked on chain).
 */
export function verifiedPayer(serializedTransaction: string): Address.Address | null {
  if (!/^0x7[68][0-9a-fA-F]+$/.test(serializedTransaction)) return null
  try {
    const { from: _claimedSender, ...fields } = TxEnvelopeTempo.deserialize(
      serializedTransaction as TxEnvelopeTempo.Serialized,
    )
    const { signature } = fields
    if (!signature) return null
    const envelope = TxEnvelopeTempo.from(fields)
    if (signature.type !== 'keychain')
      return lower(verifiedSigner(TxEnvelopeTempo.getSignPayload(envelope), signature))
    // Keychain V2 signs over the account too: keccak256(0x04 || sigHash || userAddress).
    const accessKey = verifiedSigner(
      TxEnvelopeTempo.getSignPayload(
        envelope,
        signature.version === 'v2' ? { from: signature.userAddress } : {},
      ),
      signature.inner,
    )
    if (!accessKey) return null
    const authorization = fields.keyAuthorization
    if (!authorization) return lower(accessKey)
    if (!authorization.signature || !Address.isEqual(authorization.address, accessKey)) return null
    return lower(
      verifiedSigner(KeyAuthorization.getSignPayload(authorization), authorization.signature),
    )
  } catch {
    return null
  }
}

function lower(address: Address.Address | null): Address.Address | null {
  return address ? (address.toLowerCase() as Address.Address) : null
}

/**
 * Records one sponsored `action` for `payer` on the current UTC day. Returns false, recording
 * nothing, once the payer has used `perDay` of them.
 */
export async function reserve(
  store: Store.AtomicStore,
  parameters: {
    action: 'open' | 'topUp'
    chainId: number
    payer: string
    perDay?: number | undefined
    now?: Date | undefined
  },
): Promise<boolean> {
  const { action, chainId, payer, perDay = defaultPerDay } = parameters
  const day = (parameters.now ?? new Date()).toISOString().slice(0, 10)
  const key = `mppx:session:sponsorship:${chainId}:${payer.toLowerCase()}` as const
  return (store as Store.AtomicStore<ItemMap>).update(key, (current) => {
    const usage = current?.day === day ? current : { day, open: 0, topUp: 0 }
    if (usage[action] >= perDay) return { op: 'noop', result: false }
    return { op: 'set', value: { ...usage, [action]: usage[action] + 1 }, result: true }
  })
}

/**
 * Returns `feePayer` when the credential's open or top-up may be sponsored, and `undefined` once
 * its verified payer used the day's sponsored transactions, or when no signature proves a payer.
 * The transaction is then broadcast as the payer signed it, paying its own fees.
 */
export async function limitFeePayer<feePayer>(parameters: {
  chainId: number
  feePayer: feePayer | undefined
  limit: Parameters | undefined
  payload: SessionCredentialPayload
}): Promise<feePayer | undefined> {
  const { chainId, feePayer, limit, payload } = parameters
  if (!feePayer || !limit) return feePayer
  if (payload.action !== 'open' && payload.action !== 'topUp') return feePayer
  const payer = verifiedPayer(payload.transaction)
  if (!payer) return undefined
  const allowed = await reserve(limit.store, {
    action: payload.action,
    chainId,
    payer,
    perDay: limit.perDay,
  })
  return allowed ? feePayer : undefined
}
