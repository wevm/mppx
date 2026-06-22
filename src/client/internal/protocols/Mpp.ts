import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import type { Protocol } from './Protocol.js'
import { paymentRequiredStatus, setCredentialHeader } from './Shared.js'

/** MPP — the native HTTP scheme: a 402 carrying a `WWW-Authenticate` challenge, paid back in `Authorization`. */
export function mpp(): Protocol {
  return {
    getChallenges(response) {
      if (
        response.status !== paymentRequiredStatus ||
        !response.headers.has(Constants.Headers.wwwAuthenticate)
      )
        return []
      return Challenge.fromResponseList(response)
    },
    setCredential(request, credential) {
      return setCredentialHeader(request, Constants.Headers.authorization, credential)
    },
  }
}
