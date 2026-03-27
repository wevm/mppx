import type * as Runtime from './internal/runtime.js'

declare global {
  interface MppxChallengeRequest extends Runtime.ChallengeRequest {}

  interface MppxConfig extends Runtime.Config {}

  interface MppxEventMap {
    'mppx:complete': CustomEvent<string>
  }

  interface WindowEventMap extends MppxEventMap {}

  var mppx: Runtime.Mppx<MppxChallengeRequest, MppxConfig>
}
