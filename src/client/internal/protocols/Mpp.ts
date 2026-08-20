import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import type { Protocol } from './Protocol.js'
import { paymentRequiredStatus, setCredentialHeader } from './Shared.js'

/** MPP — native HTTP Payment authentication. */
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
    setCredential(request, credential, options) {
      return setCredentialHeader(
        request,
        options?.challenge
          ? Challenge.credentialHeader(options.challenge)
          : Constants.Headers.authorization,
        credential,
      )
    },
  }
}
