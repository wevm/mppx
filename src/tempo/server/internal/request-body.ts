import type * as Method from '../../../Method.js'
import type { SessionCredentialContext } from '../../session/precompile/Protocol.js'

/** Minimal immutable request shape used to decide whether a session request serves billable content. */
export type RequestBodyProbe = Pick<Method.CapturedRequest, 'headers' | 'hasBody' | 'method'> &
  Partial<Pick<Method.CapturedRequest, 'url'>>

/** Captures the request fields needed by the session content/management classifier. */
export function captureRequestBodyProbe(input: Request): RequestBodyProbe {
  return {
    headers: input.headers,
    hasBody: input.body !== null,
    method: input.method,
    url: new URL(input.url),
  }
}

/** Returns whether request metadata indicates a meaningful body is present. */
export function hasCapturedRequestBody(
  input: Pick<RequestBodyProbe, 'headers' | 'hasBody'>,
): boolean {
  const contentLength = input.headers.get('content-length')
  const headerIndicatesBody =
    (contentLength !== null && contentLength !== '0') || input.headers.has('transfer-encoding')

  if (headerIndicatesBody) return true
  if (input.hasBody === true) return true
  return false
}

/** Returns whether a verified session credential should let the application handler serve content. */
export function isSessionContentRequest(input: RequestBodyProbe): boolean {
  if (input.method === 'HEAD') return false
  if (input.method !== 'POST') return true
  if (input.url?.search) return true
  return hasCapturedRequestBody(input)
}

/** Returns whether a plain non-streaming response should be charged after verification. */
export function shouldChargePlainResponse(
  input: RequestBodyProbe,
  payload: Partial<SessionCredentialContext>,
): boolean {
  if (payload.action === 'close' || payload.action === 'topUp') return false
  return isSessionContentRequest(input)
}
