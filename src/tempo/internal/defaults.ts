export const rpcUrl = {
  4217: 'https://rpc.tempo.xyz',
  42431: 'https://rpc.moderato.tempo.xyz',
} as const

export const escrowContract = {
  4217: '0x0901aED692C755b870F9605E56BAA66C35BEfF69',
  42431: '0x542831e3E4Ace07559b7C8787395f4Fb99F70787',
} as const

export const testnetChainId = 42431

/**
 * Default token decimals for TIP-20 stablecoins (e.g. pathUSD).
 *
 * All TIP-20 tokens on Tempo use 6 decimals, so there is no risk of
 * client/server mismatch within the Tempo ecosystem. Other chains and
 * runtimes should set `decimals` explicitly to match their token.
 */
export const decimals = 6
