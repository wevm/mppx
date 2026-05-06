import { getAddress, isAddressEqual, type Address } from 'viem'

export function normalize(address: string): Address {
  return getAddress(address)
}

export function equal(left: string, right: string): boolean {
  return isAddressEqual(normalize(left), normalize(right))
}

export function parseSource(source: string | undefined):
  | {
      address: Address
      chainId: number
    }
  | undefined {
  if (!source) return undefined
  const match = source.match(/^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/)
  if (!match) return undefined
  return {
    address: normalize(match[2]!),
    chainId: Number(match[1]),
  }
}
