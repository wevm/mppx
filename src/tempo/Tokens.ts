import { defineToken } from 'viem/tokens'

/** MACH funding-token metadata for canonical swapper routes; not a direct settlement currency. */
export const mach = defineToken({
  addresses: {
    4217: '0x20c000000000000000000000f37de3740ADec032',
    42431: '0x20c000000000000000000000f37de3740ADec032',
  },
  currency: 'USD',
  decimals: 6,
  name: 'MACH',
  symbol: 'MACH',
})
