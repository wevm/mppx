import type * as Runtime from './internal/runtime.js'
import type { ShellState } from './mount.js'

declare global {
  interface MppxChallengeRequest extends Runtime.ChallengeRequest {}

  interface MppxConfig extends Runtime.Config {}

  interface MppxEventMap {
    'mppx:complete': CustomEvent<string>
    'mppx:set': CustomEvent<Runtime.SetEvent<ShellState>>
  }

  interface WindowEventMap extends MppxEventMap {}

  var mppx: Runtime.Mppx<MppxChallengeRequest, MppxConfig>
}
