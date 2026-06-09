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
  if (hasBodyFramingHeaders(input)) return true
  if (input.hasBody === true) return true
  return false
}

function hasBodyFramingHeaders(input: Pick<RequestBodyProbe, 'headers'>): boolean {
  const contentLength = input.headers.get('content-length')
  return (contentLength !== null && contentLength !== '0') || input.headers.has('transfer-encoding')
}

function hasBodyIntentHeaders(input: Pick<RequestBodyProbe, 'headers'>): boolean {
  return hasBodyFramingHeaders(input) || input.headers.has('content-type')
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
  if (
    (payload.action === 'open' || payload.action === 'voucher') &&
    input.method === 'POST' &&
    !input.url?.search &&
    input.hasBody !== true &&
    !hasBodyIntentHeaders(input)
  )
    return false
  return isSessionContentRequest(input)
}
