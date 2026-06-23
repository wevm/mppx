import type * as Challenge from '../../../Challenge.js'
import type { MaybePromise } from '../../../internal/types.js'

/** One payment protocol over the `http` transport. */
export type Protocol = {
  /** This protocol's challenges from a response; `[]` when the response isn't its concern. */
  getChallenges: (response: Response, request?: RequestInit) => MaybePromise<Challenge.Challenge[]>
  /** Attaches this protocol's credential to a retry request. */
  setCredential: (request: RequestInit, credential: string) => RequestInit
}
