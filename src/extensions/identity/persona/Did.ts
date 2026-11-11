/**
 * Returns the reference ID for a wallet: its `did:pkh` DID, the form a Credential's `source`
 * takes. EVM (`eip155`) addresses are lowercased, since they are case-insensitive; addresses on
 * other chains, such as base58 Solana addresses, are kept as they are.
 *
 * @example
 * ```ts
 * Persona.did({ address: '0xAb…', chainId: 4217 }) // 'did:pkh:eip155:4217:0xab…'
 * ```
 */
export function did(parameters: did.Parameters): string {
  const { address, chainId, namespace = 'eip155' } = parameters
  return normalize(`did:pkh:${namespace}:${chainId}:${address}`)
}

export declare namespace did {
  type Parameters = {
    /** Wallet address. */
    readonly address: string
    /** Chain reference, such as `4217` for Tempo mainnet. */
    readonly chainId: number | string
    /** CAIP-2 namespace. @default 'eip155' */
    readonly namespace?: string | undefined
  }
}

/** Normalizes a `did:pkh` DID: lowercases the scheme and an EVM address, keeps the rest. */
export function normalize(value: string): string {
  const parts = value.split(':')
  if (parts.length !== 5 || parts[0]!.toLowerCase() !== 'did' || parts[1]!.toLowerCase() !== 'pkh')
    return value
  const namespace = parts[2]!.toLowerCase()
  const address = namespace === 'eip155' ? parts[4]!.toLowerCase() : parts[4]!
  return ['did', 'pkh', namespace, parts[3], address].join(':')
}
