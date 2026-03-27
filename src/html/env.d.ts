import type { Challenge } from '../Challenge.js'
import type { Text, Theme } from '../server/internal/html.shared.js'

declare global {
  module '*.css' {
    const src: string
    export default src
  }

  module '*.svg' {
    const src: string
    export default src
  }

  interface ImportMetaEnv {
    readonly DEV: boolean
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  /** Per-method root element ID, set by composed pages. @internal */
  var __mppx_root: string | undefined
  /** Active method key for composed pages. @internal */
  var __mppx_active: string | undefined

  interface MppxChallengeRequest extends Record<string, unknown> {}

  interface MppxConfig extends Record<string, unknown> {
    theme?: Theme | undefined
    text?: Text | undefined
  }

  interface MppxEventMap {
    'mppx:complete': CustomEvent<string>
  }

  interface WindowEventMap extends MppxEventMap {}

  var mppx: {
    readonly challenge: Challenge<MppxChallengeRequest>
    readonly challenges: Readonly<Record<string, Challenge<MppxChallengeRequest>>> | undefined
    readonly config: MppxConfig
    dispatch(payload: unknown, source?: string): void
    serializeCredential(payload: unknown, source?: string): string
  }
}
