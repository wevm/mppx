export const rpcUrl = {
  4217: 'https://rpc.tempo.xyz',
  42431: 'https://rpc.moderato.tempo.xyz',
} as const

export const escrowContract = {
  4217: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
  42431: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
} as const

export const testnetChainId = 42431

/**
 * Default token decimals for TIP-20 stablecoins (e.g. alphaUSD).
 *
 * All TIP-20 tokens on Tempo use 6 decimals, so there is no risk of
 * client/server mismatch within the Tempo ecosystem. Other chains and
 * runtimes should set `decimals` explicitly to match their token.
 */
export const decimals = 6
