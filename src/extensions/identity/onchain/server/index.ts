import {
  type Address,
  type Client,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroHash,
} from 'viem'
import { readContract } from 'viem/actions'

import type * as Credential from '../../../../Credential.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

const registryAbi = parseAbi(['function isVerified(address account) view returns (bool)'])

/**
 * Creates a payment check that requires the payer to be allowed by an onchain registry.
 *
 * Every 402 of the route carries `Identity-Required: kyc;issuer="eip155:<chainId>:<registry>"`.
 * On the paid retry, before settlement, the check reads the registry for the address in the
 * Credential's `source`: allowed continues to settlement, not allowed rejects with 403, and a
 * failed read rejects with 503. Only Credentials that bind `source` to the payer and settle after
 * the check are accepted (401 otherwise): EVM charge, and Tempo charge paid by transaction or proof.
 * Offer Tempo with `supportedModes: ['pull']` so a client never broadcasts a payment (push mode, a
 * Zone withdrawal) the check would then reject. By default it calls `isVerified(address) returns (bool)`; pass
 * `read` for any other contract.
 *
 * @example
 * ```ts
 * const kyc = Onchain.Server.registry({
 *   client: createClient({ chain: tempo, transport: http() }),
 *   registry: '0x…',
 * })
 * const result = await mppx.charge({ amount: '1', identity: { payment: kyc } })(request)
 * if (result.status === 200) result.identity?.get(kyc)?.address
 * ```
 */
export function registry(config: registry.Config): Identity.PaymentCheck<Types.Payer> {
  const { client, read } = config
  const address = getAddress(config.registry)
  return check({
    client,
    registry: address,
    type: config.type,
    async read(payer) {
      const allowed = read
        ? await read({ client, payer, registry: address })
        : await readContract(client, {
            abi: registryAbi,
            address,
            args: [payer],
            functionName: 'isVerified',
          })
      return allowed ? {} : undefined
    },
  })
}

export declare namespace registry {
  type Config = {
    /** Client for the registry's chain. Its `chain` must be set. */
    client: Client
    /** Address of the registry contract. */
    registry: Address
    /**
     * Returns whether the registry allows `payer`. Defaults to calling
     * `isVerified(address) returns (bool)` on `registry`.
     */
    read?:
      | ((parameters: {
          client: Client
          payer: Address
          registry: Address
        }) => MaybePromise<boolean>)
      | undefined
    /** Requirement type advertised in the 402. @default 'kyc' */
    type?: string | undefined
  }
}

const indexerAbi = parseAbi([
  'function getAttestationUid(address recipient, bytes32 schema) view returns (bytes32)',
])
const easAbi = parseAbi([
  'struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }',
  'function getAttestation(bytes32 uid) view returns (Attestation)',
])

/**
 * Creates a payment check that requires the payer to hold a Coinbase Verifications attestation
 * on Base, by default Verified Account (a Coinbase account that passed Coinbase's verification).
 *
 * The check looks up the payer's latest attestation for `schema` in Coinbase's indexer and
 * accepts it only if Coinbase's attester issued it to the payer and it is neither revoked nor
 * expired. The payer must pay from the address it verified with Coinbase.
 *
 * @example
 * ```ts
 * const verified = Onchain.Server.coinbase({
 *   client: createClient({ chain: base, transport: http() }),
 * })
 * mppx.charge({ amount: '1', identity: { payment: verified } })
 * ```
 */
export function coinbase(config: coinbase.Config): Identity.PaymentCheck<Types.Payer> {
  const { client } = config
  const { attester, eas, indexer, schemas } = Constants.coinbase
  const schema = config.schema ?? schemas.verifiedAccount
  return check({
    client,
    registry: indexer,
    type: config.type,
    async read(payer) {
      const uid = await readContract(client, {
        abi: indexerAbi,
        address: indexer,
        args: [payer, schema],
        functionName: 'getAttestationUid',
      })
      if (uid === zeroHash) return undefined
      const attestation = await readContract(client, {
        abi: easAbi,
        address: eas,
        args: [uid],
        functionName: 'getAttestation',
      })
      const now = BigInt(Math.floor(Date.now() / 1_000))
      const allowed =
        attestation.uid === uid &&
        attestation.schema === schema &&
        isAddressEqual(attestation.recipient, payer) &&
        isAddressEqual(attestation.attester, attester) &&
        attestation.revocationTime === 0n &&
        (attestation.expirationTime === 0n || attestation.expirationTime > now)
      return allowed ? { attestation: uid } : undefined
    },
  })
}

export declare namespace coinbase {
  type Config = {
    /** Client for Base mainnet. */
    client: Client
    /** EAS schema to require. @default Constants.coinbase.schemas.verifiedAccount */
    schema?: Hex | undefined
    /** Requirement type advertised in the 402. @default 'kyc' */
    type?: string | undefined
  }
}

/** Builds the payment check shared by every registry: payer lookup, read and outcomes. */
function check(parameters: {
  client: Client
  registry: Address
  type?: string | undefined
  read: (payer: Address) => Promise<{ attestation?: Hex } | undefined>
}): Identity.PaymentCheck<Types.Payer> {
  const { client, read, registry } = parameters
  const chainId = client.chain?.id
  if (chainId === undefined) throw new TypeError('The registry client must have a chain.')
  return Object.freeze({
    requires: [
      { type: parameters.type ?? Constants.type, issuer: `eip155:${chainId}:${registry}` },
    ],
    async verify({ credential }): Promise<Identity.Verification<Types.Payer>> {
      // Without a Credential (a route's `authorize` hook) there is no payer to check yet.
      if (!credential) return { status: 'missing', reason: 'A registered payer is required.' }
      // On a method that does not bind `source` (such as Stripe or a Tempo Zone withdrawal), a
      // payer could name an allowed address it does not control.
      if (!bindsSource(credential))
        return {
          status: 'invalid',
          reason: 'The payment method does not bind the payer address this route checks.',
        }
      const payer = payerOf(credential)
      if (!payer)
        return { status: 'invalid', reason: 'The Credential does not name a payer address.' }
      let allowed: Awaited<ReturnType<typeof read>>
      try {
        allowed = await read(payer)
      } catch {
        // Upstream errors stay out of the response.
        return { status: 'unavailable', reason: 'The registry could not be read.' }
      }
      if (!allowed) return { status: 'forbidden', reason: 'The payer is not in the registry.' }
      return {
        status: 'valid',
        value: { address: payer, chainId, registry, ...allowed },
      }
    },
  })
}

/**
 * Returns whether the Credential's method rejects a `source` that is not the account that signed
 * or sent the payment, and that the server settles only after this check: EVM charge, and Tempo
 * charge paid by transaction or proof. A Tempo hash Credential is already broadcast when the check
 * runs, and Tempo Zone withdrawals and other methods (such as Stripe) leave `source` unchecked.
 */
function bindsSource(credential: Credential.Credential): boolean {
  const { intent, method } = credential.challenge
  if (intent !== 'charge') return false
  if (method === 'evm') return true
  if (method !== 'tempo') return false
  const type = (credential.payload as { type?: unknown } | undefined)?.type
  return type === 'transaction' || type === 'proof'
}

/** Returns the address in a Credential's `did:pkh:eip155:<chainId>:<address>` source. */
function payerOf(credential: Credential.Credential): Address | undefined {
  const match = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(credential.source ?? '')
  if (!match || !isAddress(match[1]!, { strict: false })) return undefined
  return getAddress(match[1]!)
}
