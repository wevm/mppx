import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import type { Protocol } from './Protocol.js'
import { paymentRequiredStatus, setCredentialHeader } from './Shared.js'

/** MPP — native HTTP Payment authentication. */
export function mpp(): Protocol {
  return {
    getChallenges(response) {
      const header = response.headers.get(Constants.Headers.wwwAuthenticate)
      // A 402 without a Payment challenge (such as `WWW-Authenticate: X402`) is left to other protocols.
      if (
        response.status !== paymentRequiredStatus ||
        !header ||
        !Challenge.hasPaymentScheme(header)
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
