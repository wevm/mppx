import { defineToken } from 'viem/tokens'

/** MACH token metadata and deployed addresses. */
export const mach = defineToken({
  addresses: {
    42431: '0x20c000000000000000000000f37de3740ADec032',
  },
  currency: 'USD',
  decimals: 6,
  name: 'MACH',
  symbol: 'MACH',
})
