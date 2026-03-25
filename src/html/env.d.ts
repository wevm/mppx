import type { Challenge } from '../Challenge.js'

declare global {
  interface MppxChallengeRequest extends Record<string, unknown> {}

  interface MppxConfig extends Record<string, unknown> {}

  interface MppxEventMap {
    'mppx:complete': CustomEvent<string>
  }

  interface WindowEventMap extends MppxEventMap {}

  var mppx: {
    readonly challenge: Challenge<MppxChallengeRequest>
    readonly config: MppxConfig
    dispatch(payload: unknown, source?: string): void
    serializeCredential(payload: unknown, source?: string): string
  }
}
