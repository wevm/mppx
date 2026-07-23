import { Bytes, Hash, Hex, Json } from 'ox'

import { PaymentExpiredError, VerificationFailedError } from '../../Errors.js'
import type * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'

const defaultApiBaseUrl = 'https://api.tempo.xyz'

const relayErrorCode = [
  'already_used',
  'broadcast_failed',
  'expired',
  'invalid_payment',
  'insufficient_funds',
  'policy_denied',
  'screen_rejected',
  'simulation_failed',
  'temporarily_unavailable',
  'unsupported',
  'unknown',
] as const

type RelayErrorCode = (typeof relayErrorCode)[number]

/** Error body returned by Tempo API's MPP relay. */
type RelayError = {
  /** Stable machine-readable reason the relay rejected the credential. */
  code: RelayErrorCode
  /** Human-readable explanation of the relay result. */
  message?: string | undefined
}

/** Credential fields accepted by Tempo API's MPP relay. */
type RelayInput = {
  /** Challenge from the submitted credential. */
  challenge: Record<string, unknown>
  /** Method-specific credential payload. */
  payload: unknown
  /** Optional payer identity. */
  source?: string | undefined
}

/** Response returned by the MPP relay validation endpoint. */
type ValidateResponse = { success: true } | { error: RelayError; success: false }

/** Receipt returned by the MPP relay after broadcast. */
type RelayReceipt = {
  /** Optional caller-provided payment reference. */
  externalId?: string | undefined
  /** Payment method that settled the credential. */
  method: string
  /** On-chain or payment-system settlement reference. */
  reference: string
  /** RFC 3339 settlement timestamp. */
  timestamp: string
}

/** Response returned by the MPP relay broadcast endpoint. */
type BroadcastResponse =
  | { receipt: RelayReceipt; success: true }
  | { error: RelayError; success: false }

/**
 * Configures a Tempo payment method to use Tempo API's MPP relay.
 *
 * The adapter preserves the supplied method's challenge configuration while
 * delegating credential validation and terminal broadcast to
 * `/v1/mpp/validate` and `/v1/mpp/broadcast` respectively.
 *
 * @internal
 */
export function configure<const intent extends Method.Method>(
  method: Method.Server<intent>,
  options: configure.Options,
): configure.Adapter<intent> {
  const request = createRequest(options)

  const validate: Method.ValidateFn<intent> = async (parameters) => {
    const input = toRelayInput(parameters.credential)
    await request.validate(input)

    return {
      challenge: parameters.credential.challenge,
      credential: parameters.credential,
      details: {},
      intent: method.intent,
      method: method.name,
      request: parameters.credential.challenge.request,
      ...(parameters.credential.source ? { source: parameters.credential.source } : {}),
    } as Method.Validation<intent>
  }

  const broadcast: Method.BroadcastFn<intent> = async (parameters) => {
    const input = toRelayInput(parameters.credential)
    const receipt = await request.broadcast(input, {
      idempotencyKey: idempotencyKey(input),
    })
    if (receipt.method !== method.name) throw failure()
    try {
      return Receipt.from({ ...receipt, status: 'success' })
    } catch {
      throw failure()
    }
  }

  // Preserve the legacy combined hook for direct method consumers.
  const verify: Method.VerifyFn<intent> = async (parameters) => {
    await validate(parameters)
    return broadcast(parameters)
  }

  return {
    ...method,
    broadcast,
    verify,
    validate,
  } as configure.Adapter<intent>
}

export declare namespace configure {
  /**
   * Server method augmented with Tempo API validation and broadcast hooks.
   *
   * The legacy `verify` method validates and broadcasts in one call.
   */
  type Adapter<intent extends Method.Method> = Omit<
    Method.Server<intent>,
    'broadcast' | 'validate'
  > & {
    /** Broadcasts the credential through Tempo API. */
    broadcast: Method.BroadcastFn<intent>
    /** Validates the credential through Tempo API. */
    validate: Method.ValidateFn<intent>
  }

  /** Tempo API relay configuration for server-side Tempo charges. */
  type Options = {
    /** Tempo API key with the `mpp:write` scope. */
    apiKey: string
    /** Fetch implementation used to call Tempo API. */
    fetch?: typeof globalThis.fetch | undefined
    /** Tempo API base URL, including an optional path prefix. @default 'https://api.tempo.xyz' */
    apiBaseUrl?: string | undefined
  }

  /** Stable failure codes returned by Tempo API's MPP relay. */
  type ErrorCode = RelayErrorCode

  /** Safe relay error details exposed in Payment Auth problem details. */
  type ErrorDetails =
    | { code: 'already_used' | 'broadcast_failed' | 'insufficient_funds' | 'invalid_payment' }
    | { code: 'simulation_failed' | 'unsupported' }
    | { code: 'temporarily_unavailable'; retry: 'same_credential' }
}

function createRequest(options: configure.Options) {
  const fetch = options.fetch ?? globalThis.fetch
  const apiBaseUrl = new URL(options.apiBaseUrl ?? defaultApiBaseUrl)
  if (!apiBaseUrl.pathname.endsWith('/')) apiBaseUrl.pathname += '/'

  async function post(
    path: 'v1/mpp/broadcast' | 'v1/mpp/validate',
    input: RelayInput,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(new URL(path, apiBaseUrl), {
        body: JSON.stringify(input),
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          'tempo-api-key': options.apiKey,
          ...headers,
        },
        method: 'POST',
      })
    } catch {
      throw failure()
    }

    if (!response.ok) throw failure()
    return response.json().catch(() => undefined)
  }

  const validate = async (input: RelayInput) => {
    const response = await post('v1/mpp/validate', input)
    if (!isValidateSuccess(response)) throw failure(response)
  }

  const broadcast = async (input: RelayInput, broadcastOptions: { idempotencyKey: string }) => {
    const response = await post('v1/mpp/broadcast', input, {
      'idempotency-key': broadcastOptions.idempotencyKey,
    })
    if (!isBroadcastSuccess(response)) throw failure(response)
    return response.receipt
  }

  return {
    broadcast,
    validate,
  }
}

function toRelayInput(credential: {
  challenge: Record<string, unknown>
  payload: unknown
  source?: string | undefined
}): RelayInput {
  return {
    challenge: credential.challenge,
    payload: credential.payload,
    ...(credential.source ? { source: credential.source } : {}),
  }
}

function idempotencyKey(input: RelayInput): string {
  const payload = input.payload
  if (
    isRecord(payload) &&
    payload.type === 'transaction' &&
    typeof payload.signature === 'string' &&
    Hex.validate(payload.signature)
  ) {
    const transactionHash = Hash.keccak256(Hex.toBytes(payload.signature), { as: 'Hex' })
    return `mppx_${transactionHash}`
  }

  const hash = Hash.sha256(Bytes.fromString(Json.canonicalize(input)), { as: 'Hex' })
  return `mppx_${hash}`
}

function failure(value?: unknown) {
  const code = relayErrorCodeFrom(value)
  if (code === 'expired') return new PaymentExpiredError()

  const details = code && safeDetails(code)
  return new VerificationFailedError(details ? { details } : undefined)
}

function isValidateSuccess(value: unknown): value is Extract<ValidateResponse, { success: true }> {
  return isRecord(value) && value.success === true
}

function isBroadcastSuccess(
  value: unknown,
): value is Extract<BroadcastResponse, { success: true }> {
  return isRecord(value) && value.success === true && isRelayReceipt(value.receipt)
}

function relayErrorCodeFrom(value: unknown): RelayErrorCode | undefined {
  if (!isRecord(value) || !isRecord(value.error) || !isRelayErrorCode(value.error.code)) return
  return value.error.code
}

function isRelayErrorCode(value: unknown): value is RelayErrorCode {
  return typeof value === 'string' && (relayErrorCode as readonly string[]).includes(value)
}

function safeDetails(code: RelayErrorCode): configure.ErrorDetails | undefined {
  switch (code) {
    case 'already_used':
    case 'broadcast_failed':
    case 'insufficient_funds':
    case 'invalid_payment':
    case 'simulation_failed':
    case 'unsupported':
      return { code }
    case 'temporarily_unavailable':
      return { code, retry: 'same_credential' }
    default:
      return
  }
}

function isRelayReceipt(value: unknown): value is RelayReceipt {
  return (
    isRecord(value) &&
    typeof value.method === 'string' &&
    typeof value.reference === 'string' &&
    typeof value.timestamp === 'string' &&
    (value.externalId === undefined || typeof value.externalId === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
