import {
  qualifyPreparedPayment,
  type ContractRequirement,
  type FrozenRequest,
  type QualifiedAuthorization,
  type SelectedChallenge,
} from './qualify.js'

/** Minimal `preparePayment` surface used by this example. */
export type PreparePaymentClient = {
  preparePayment: (
    response: Response,
    options?: { request?: RequestInit },
  ) => Promise<{
    challenge: SelectedChallenge
    createCredential: () => Promise<string>
    setCredential: (request: RequestInit, credential: string) => RequestInit
  }>
}

export type AttachQualifiedCredentialOptions = {
  mppx: PreparePaymentClient
  request: FrozenRequest
  response: Response
  openApiDocument: string | Uint8Array
  required: ContractRequirement
}

export type AttachedQualifiedCredential = {
  authorization: QualifiedAuthorization
  credential: string
  authenticatedRequest: RequestInit
  sent: false
}

/** Thrown when buyer-side qualification fails before credential creation. */
export class QualificationError extends Error {
  override readonly name = 'QualificationError'
  readonly reason: string

  constructor(reason: string) {
    super('Prepared payment failed buyer qualification: ' + reason)
    this.reason = reason
  }
}

/**
 * Qualifies a prepared payment, creates one credential, attaches it to the
 * frozen request, and stops.
 *
 * Never sends the authenticated request. MPP binds the selected challenge
 * fields only; this helper adds buyer-side application binding before
 * `createCredential()`.
 */
export async function attachQualifiedCredential(
  options: AttachQualifiedCredentialOptions,
): Promise<AttachedQualifiedCredential> {
  const requestInit = toRequestInit(options.request)
  const prepared = await options.mppx.preparePayment(options.response, {
    request: requestInit,
  })
  const qualified = qualifyPreparedPayment({
    request: options.request,
    challenge: prepared.challenge,
    openApiDocument: options.openApiDocument,
    required: options.required,
  })
  if (!qualified.ok) throw new QualificationError(qualified.reason)

  const credential = await prepared.createCredential()
  const authenticatedRequest = prepared.setCredential(requestInit, credential)
  return {
    authorization: qualified.authorization,
    credential,
    authenticatedRequest,
    sent: false,
  }
}

/**
 * Returns the `RequestInit` used with `preparePayment` and `setCredential`.
 *
 * The URL stays on the frozen request so attachment cannot retarget another
 * resource.
 */
export function toRequestInit(request: FrozenRequest): RequestInit {
  return {
    method: request.method,
    ...(request.headers !== undefined ? { headers: request.headers } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  }
}
