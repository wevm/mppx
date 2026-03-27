import type { Challenge } from '../../Challenge.js'
import type { Config as HtmlConfig } from './types.js'

export interface ChallengeRequest extends Record<string, unknown> {}

export interface Config extends Record<string, unknown>, HtmlConfig {
  actions?: Record<string, string> | undefined
}

export type SetEvent<state extends object> = {
  [name in keyof state]: {
    key: string
    name: name
    value: state[name]
  }
}[keyof state]

export type Mppx<
  request extends Record<string, unknown> = ChallengeRequest,
  config extends Record<string, unknown> = Config,
> = {
  readonly challenge: Challenge<request>
  readonly challenges: Readonly<Record<string, Challenge<request>>> | undefined
  readonly config: config
  dispatch(payload: unknown, source?: string): void
  serializeCredential(payload: unknown, source?: string): string
}
