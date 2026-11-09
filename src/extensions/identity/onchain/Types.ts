import type { Address, Hex } from 'viem'

/** A payer an onchain registry allowed, returned by `result.identity.get(check)`. */
export type Payer = {
  /** The payer's address, from the Credential's `source`. */
  address: Address
  /** Chain ID of the registry. */
  chainId: number
  /** Address of the registry contract that allowed the payer. */
  registry: Address
  /** UID of the attestation that allowed the payer, for attestation registries. */
  attestation?: Hex | undefined
}
