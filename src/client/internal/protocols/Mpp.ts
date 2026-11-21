import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
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
      // A Payment credential echoes its challenge, so callers that attach one without passing the
      // challenge still send it in the field that challenge selects (`Payment-Authorization`).
      const challenge = options?.challenge ?? credentialChallenge(credential)
      return setCredentialHeader(
        request,
        challenge ? Challenge.credentialHeader(challenge) : Constants.Headers.authorization,
        credential,
      )
    },
  }
}

/** `Payment <base64url>`, as `Credential.serialize` writes it. */
const serializedCredential = /^Payment [A-Za-z0-9_-]+={0,2}$/

/** Returns the challenge a serialized Payment credential echoes, or `undefined` for any other value. */
function credentialChallenge(credential: string): Challenge.Challenge | undefined {
  // Parse only values shaped like a serialized credential, checked in linear time, so arbitrary
  // strings never reach the deserializer's regex.
  if (!serializedCredential.test(credential)) return undefined
  try {
    return Credential.deserialize(credential).challenge
  } catch {
    return undefined
  }
}
