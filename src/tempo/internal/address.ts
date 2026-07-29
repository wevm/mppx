import { TempoAddress } from 'ox/tempo'

/** Returns whether two hex or Tempo-formatted addresses resolve to the same address. */
export function isEqual(a: TempoAddress.Address, b: TempoAddress.Address) {
  return TempoAddress.resolve(a).toLowerCase() === TempoAddress.resolve(b).toLowerCase()
}
