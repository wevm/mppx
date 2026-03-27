import type { Challenge } from '../../Challenge.js'
import type { Config as HtmlConfig } from './types.js'

export interface ChallengeRequest extends Record<string, unknown> {}

export interface Config extends Record<string, unknown>, HtmlConfig {}

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
