import type { Challenge } from '../../Challenge.js'
import type { Config as HtmlConfig } from './types.js'

export interface ChallengeRequest extends Record<string, unknown> {}

export interface Config extends Record<string, unknown> {}

export interface Actions extends Record<string, string> {}

export type Shell = HtmlConfig

export type SetEvent<state extends object> = {
  [name in keyof state]: {
    key: string
    name: name
    value: state[name]
  }
}[keyof state]

export type ScopedMppx<
  request extends Record<string, unknown> = ChallengeRequest,
  config extends Record<string, unknown> = Config,
  actions extends Record<string, string> = Actions,
> = {
  readonly challenge: Challenge<request>
  readonly challenges: Readonly<Record<string, Challenge<request>>> | undefined
  readonly config: config
  readonly actions: actions
  dispatch(payload: unknown, source?: string): void
  serializeCredential(payload: unknown, source?: string): string
}

export type Mppx<
  request extends Record<string, unknown> = ChallengeRequest,
  config extends Record<string, unknown> = Config,
  actions extends Record<string, string> = Actions,
> = ScopedMppx<request, config, actions> & {
  /** Returns a stable runtime scoped to a specific method key (for composed pages). @internal */
  scope(key: string): ScopedMppx<request, config, actions>
}
