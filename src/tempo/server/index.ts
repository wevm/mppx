import { charge as charge_ } from './Charge.js'
import { stream as stream_ } from './Stream.js'

export type { ChannelState, ChannelStorage, SessionState } from '../stream/Storage.js'
export { charge } from './Charge.js'
export { settle, stream } from './Stream.js'

export function tempo(parameters: tempo.Parameters) {
  return [tempo.charge(parameters), tempo.stream(parameters)] as const
}

export namespace tempo {
  export type Parameters = charge_.Parameters & stream_.Parameters

  export const charge = charge_
  export const stream = stream_
}
