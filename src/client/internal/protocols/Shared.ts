import * as Constants from '../../../Constants.js'
import * as x402_Types from '../../../x402/Types.js'

/** HTTP status that signals a native payment challenge. */
export const paymentRequiredStatus = 402

/** Credential headers purged before a fresh credential is attached. */
const credentialHeaders = [
  Constants.Headers.authorization,
  x402_Types.paymentRequiredHeader,
  x402_Types.paymentResponseHeader,
  x402_Types.paymentSignatureHeader,
]

/** Attaches `credential` under `header`, clearing any stale credential headers first. */
export function setCredentialHeader(
  request: RequestInit,
  header: string,
  credential: string,
): RequestInit {
  const headers = new Headers(request.headers)
  for (const stale of credentialHeaders) headers.delete(stale)
  headers.set(header, credential)
  return { ...request, headers }
}
