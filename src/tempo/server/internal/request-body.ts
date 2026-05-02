import type * as Method from '../../../Method.js'
import type { SessionCredentialPayload } from '../../session/Types.js'

export type RequestBodyProbe = Pick<Method.CapturedRequest, 'headers' | 'hasBody' | 'method'> &
  Partial<Pick<Method.CapturedRequest, 'url'>>

export function captureRequestBodyProbe(input: Request): RequestBodyProbe {
  return {
    headers: input.headers,
    hasBody: input.body !== null,
    method: input.method,
    url: new URL(input.url),
  }
}

export function hasCapturedRequestBody(
  input: Pick<RequestBodyProbe, 'headers' | 'hasBody'>,
): boolean {
  const contentLength = input.headers.get('content-length')
  const headerIndicatesBody =
    (contentLength !== null && contentLength !== '0') || input.headers.has('transfer-encoding')

  if (input.hasBody === true) return true
  return headerIndicatesBody
}

export function isSessionContentRequest(input: RequestBodyProbe): boolean {
  if (input.method === 'HEAD') return false
  if (input.method !== 'POST') return true
  if (input.url?.search) return true
  return hasCapturedRequestBody(input)
}

export function shouldChargePlainResponse(
  input: RequestBodyProbe,
  payload: Partial<SessionCredentialPayload>,
): boolean {
  if (payload.action === 'close' || payload.action === 'topUp') return false
  return isSessionContentRequest(input)
}
