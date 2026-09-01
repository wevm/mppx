import type * as Challenge from '../Challenge.js'
import type { MaybePromise } from '../internal/types.js'
import type * as Method from '../Method.js'
import * as Receipt from '../Receipt.js'

/**
 * Caller-owned view of a paid application response.
 *
 * Settlement evidence lives on the HTTP response (`Payment-Receipt`). This
 * helper does not create credentials, retry, or change payment behavior.
 */
export type View = {
  /** Parsed `Payment-Receipt` when present and well-formed. */
  receipt: Receipt.Receipt | undefined
  /** Paid application response, including protocol recovery wrapping. */
  response: Response
}

/**
 * Inputs for caller-owned validation of a paid application response.
 *
 * The `response` is a clone when cloning is possible, so a validator can read
 * the body without consuming the value returned to the caller.
 */
export type Payload<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> =
  View & {
    /** Challenge that produced the credential, when known. */
    challenge?: Challenge.Challenge | undefined
    /** Serialized credential sent on the paid retry, when known. */
    credential?: string | undefined
    /** Client method that created the credential, when known. */
    method?: methods[number] | undefined
  }

/** Caller-owned validator. Throw to reject the application output. */
export type Validate<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = (
  payload: Payload<methods>,
) => MaybePromise<void>

/**
 * Paid application output failed caller validation after settlement.
 *
 * This is not a payment protocol error: the credential was already sent.
 * Callers can still read {@link InvalidError.response} and
 * {@link InvalidError.receipt}.
 */
export class InvalidError extends Error {
  override readonly name = 'PaidResponseInvalidError'
  /** Challenge used for the paid retry, when known. */
  readonly challenge: Challenge.Challenge | undefined
  /** Credential sent on the paid retry, when known. */
  readonly credential: string | undefined
  /** Parsed receipt when the paid response carried one. */
  readonly receipt: Receipt.Receipt | undefined
  /** Paid response whose application output failed validation. */
  readonly response: Response

  constructor(options: InvalidError.Options) {
    const message = options.message ?? messageFromCause(options.cause)
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.challenge = options.challenge
    this.credential = options.credential
    this.receipt = options.receipt
    this.response = options.response
  }
}

export declare namespace InvalidError {
  type Options = {
    challenge?: Challenge.Challenge | undefined
    cause?: unknown
    credential?: string | undefined
    message?: string | undefined
    receipt?: Receipt.Receipt | undefined
    response: Response
  }
}

/** Returns whether `value` is a {@link InvalidError}. */
export function isInvalidError(value: unknown): value is InvalidError {
  return value instanceof InvalidError
}

/**
 * Reads settlement evidence from a paid response without throwing when the
 * receipt header is missing or malformed.
 */
export function receiptOf(response: Response): Receipt.Receipt | undefined {
  try {
    return Receipt.fromResponse(response)
  } catch {
    return undefined
  }
}

/**
 * Detached view of a paid response: the HTTP response plus any parseable
 * receipt. Does not consume the body.
 */
export function view(response: Response): View {
  return { receipt: receiptOf(response), response }
}

/**
 * Runs a caller-owned validator against a paid response without retrying
 * payment. On failure, throws {@link InvalidError} bound to this invocation's
 * response and payment context. Validator-thrown errors, including a prebuilt
 * {@link InvalidError}, are preserved only as `cause`.
 *
 * @example
 * ```ts
 * import { PaidResponse } from 'mppx/client'
 *
 * const response = await mppx.fetch('/resource')
 * await PaidResponse.validate(response, async ({ response, receipt }) => {
 *   const body = await response.json()
 *   if (typeof body.id !== 'string') throw new Error('missing id')
 *   if (!receipt) throw new Error('missing receipt')
 * })
 * ```
 */
export async function validate<
  const methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[],
>(
  response: Response,
  validator: Validate<methods>,
  context?: validate.Context<methods> | undefined,
): Promise<Response> {
  const receipt = observedReceipt(response, context)
  let validatorResponse: Response
  try {
    validatorResponse = response.clone()
  } catch (cause) {
    throw bindInvalidError({
      cause,
      context,
      message: 'Paid application response could not be cloned for caller validation.',
      receipt,
      response,
    })
  }

  try {
    await validator({
      ...(context?.challenge ? { challenge: context.challenge } : {}),
      ...(context?.credential ? { credential: context.credential } : {}),
      ...(context?.method ? { method: context.method } : {}),
      receipt,
      response: validatorResponse,
    })
  } catch (cause) {
    throw bindInvalidError({ cause, context, receipt, response })
  }
  return response
}

export declare namespace validate {
  type Context<methods extends readonly Method.AnyClient[] = readonly Method.AnyClient[]> = {
    challenge?: Challenge.Challenge | undefined
    credential?: string | undefined
    method?: methods[number] | undefined
    /** Observed settlement evidence. When present, recovery wrappers cannot replace it. */
    receipt?: Receipt.Receipt | undefined
  }
}

function messageFromCause(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return `Paid application response failed caller validation: ${cause.message}`
  }
  return 'Paid application response failed caller validation.'
}

function observedReceipt(
  response: Response,
  context?: validate.Context | undefined,
): Receipt.Receipt | undefined {
  if (context && Object.hasOwn(context, 'receipt')) return context.receipt
  return receiptOf(response)
}

function bindInvalidError(parameters: {
  cause?: unknown
  context?: validate.Context | undefined
  message?: string | undefined
  receipt: Receipt.Receipt | undefined
  response: Response
}): InvalidError {
  return new InvalidError({
    cause: parameters.cause,
    ...(parameters.context?.challenge ? { challenge: parameters.context.challenge } : {}),
    ...(parameters.context?.credential ? { credential: parameters.context.credential } : {}),
    ...(parameters.message ? { message: parameters.message } : {}),
    receipt: parameters.receipt,
    response: parameters.response,
  })
}
