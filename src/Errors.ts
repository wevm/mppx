import type * as Challenge from './Challenge.js'

/** Default hint messages for payment errors. */
export const Hints = {
  paymentRequired:
    'Use a supported wallet to pay for this resource using one of the supported payment methods returned in the WWW-Authenticate header. See https://mpp.dev/tools/wallet.md',
  malformedCredential:
    'Use a supported wallet to construct valid credentials for one of the supported payment methods returned in the WWW-Authenticate header. See https://mpp.dev/tools/wallet.md',
  methodUnsupported:
    'Use a supported wallet to pay for this resource using one of the supported payment methods returned in the WWW-Authenticate header. See https://mpp.dev/tools/wallet.md',
} as const

/** Appends where to get funds to an error message. */
function withFundingUrl(message: string, fundingUrl: string | undefined) {
  return fundingUrl ? `${message} Add funds at ${fundingUrl}` : message
}

/**
 * Base class for all payment-related errors.
 */
export abstract class PaymentError extends Error {
  /** Safe method-specific context for diagnostics and relay responses. */
  readonly details: Readonly<Record<string, unknown>> | undefined

  /** RFC 9457 Problem Details type URI. */
  abstract readonly type: string

  /** Human-readable summary for RFC 9457 Problem Details. */
  abstract readonly title: string

  /** HTTP status code. */
  readonly status: number = 402

  /** Actionable hint for resolving the error (RFC 9457 extension member). */
  readonly hint: string | undefined

  /**
   * Page where the payer can get the funds this payment needs, such as the MACH onramp
   * (RFC 9457 extension member).
   */
  readonly fundingUrl: string | undefined

  protected constructor(message: string, options: PaymentError.Options = {}) {
    super(message)
    this.details = options.details
    this.fundingUrl = options.fundingUrl
    // Defined manually (non-enumerable, like native `cause`) so consumers on pre-ES2022 libs still typecheck.
    if (options.cause !== undefined)
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
        writable: true,
      })
  }

  /** Converts the error to RFC 9457 Problem Details format. */
  toProblemDetails(challengeId?: string): PaymentError.ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      ...(this.details && Object.keys(this.details).length > 0 && { details: this.details }),
      ...(this.hint && { hint: this.hint }),
      ...(this.fundingUrl && { fundingUrl: this.fundingUrl }),
      ...(challengeId && { challengeId }),
    }
  }
}

export declare namespace PaymentError {
  type Options = {
    /** Underlying error. Never serialized into Problem Details. */
    cause?: unknown
    details?: Record<string, unknown> | undefined
    /** Page where the payer can get the funds this payment needs. */
    fundingUrl?: string | undefined
  }

  type ProblemDetails = {
    /** RFC 9457 Problem Details type URI. */
    type: string
    /** Human-readable summary. */
    title: string
    /** HTTP status code. */
    status: number
    /** Human-readable explanation. */
    detail: string
    /** Safe method-specific diagnostic context. */
    details?: Readonly<Record<string, unknown>>
    /** Actionable hint for resolving the error (RFC 9457 extension member). */
    hint?: string
    /** Page where the payer can get the funds this payment needs (RFC 9457 extension member). */
    fundingUrl?: string
    /** Associated challenge ID, if applicable. */
    challengeId?: string
  }
}

/**
 * Credential is malformed (invalid base64url, bad JSON structure).
 */
export class MalformedCredentialError extends PaymentError {
  override readonly name = 'MalformedCredentialError'
  readonly title = 'Malformed Credential'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/malformed-credential'
  override readonly hint = Hints.malformedCredential

  constructor(options: MalformedCredentialError.Options = {}) {
    const { reason } = options
    super(reason ? `Credential is malformed: ${reason}.` : 'Credential is malformed.')
  }
}

export declare namespace MalformedCredentialError {
  type Options = {
    /** Reason the credential is malformed (e.g., "invalid base64url", "invalid JSON"). */
    reason?: string
  }
}

/**
 * Challenge ID is unknown, expired, or already used.
 */
export class InvalidChallengeError extends PaymentError {
  override readonly name = 'InvalidChallengeError'
  readonly title = 'Invalid Challenge'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/invalid-challenge'

  constructor(options: InvalidChallengeError.Options = {}) {
    const { id, reason } = options
    const idPart = id ? ` "${id}"` : ''
    const reasonPart = reason ? `: ${reason}` : ''
    super(`Challenge${idPart} is invalid${reasonPart}.`)
  }
}

export declare namespace InvalidChallengeError {
  type Options = {
    /** The invalid challenge ID. */
    id?: string
    /** Reason the challenge is invalid (e.g., "expired", "already used", "unknown"). */
    reason?: string
  }
}

/**
 * Payment proof is invalid or verification failed.
 */
export class VerificationFailedError extends PaymentError {
  override readonly name: string = 'VerificationFailedError'
  readonly title = 'Verification Failed'
  readonly type = 'https://paymentauth.org/problems/verification-failed'

  constructor(options: VerificationFailedError.Options = {}) {
    const { details, fundingUrl, reason } = options
    super(
      withFundingUrl(
        reason ? `Payment verification failed: ${reason}.` : 'Payment verification failed.',
        fundingUrl,
      ),
      { details, fundingUrl },
    )
  }
}

export declare namespace VerificationFailedError {
  type Options = {
    /** Safe method-specific diagnostic context. */
    details?: Record<string, unknown> | undefined
    /** Page where the payer can get the funds the payment lacked. */
    fundingUrl?: string | undefined
    /** Reason verification failed (e.g., "invalid signature", "insufficient amount"). */
    reason?: string
  }
}

/**
 * The payment behind a credential is already used or bound elsewhere: the
 * credential was consumed by an earlier request, is being settled by a
 * concurrent one, or its settled transfer is bound to another challenge.
 *
 * Answered with 403 and no challenge (the payment was valid, but policy
 * denies access), since a fresh 402 challenge would invite an auto-paying
 * client to pay again. The problem type stays `verification-failed`.
 */
export class CredentialReplayedError extends VerificationFailedError {
  override readonly name = 'CredentialReplayedError'
  override readonly status = 403

  constructor(options: CredentialReplayedError.Options = {}) {
    const { reason = 'Credential has already been used' } = options
    super({ reason })
  }
}

export declare namespace CredentialReplayedError {
  type Options = {
    /** Reason the credential was rejected (e.g., "Transaction hash has already been used"). */
    reason?: string
  }
}

/**
 * Payment processing failed because of an unexpected internal error.
 *
 * The response stays generic; the original error is only available on `cause`.
 */
export class InternalPaymentError extends PaymentError {
  override readonly name = 'InternalPaymentError'
  readonly title = 'Internal Payment Error'
  override readonly status = 500
  readonly type = 'https://paymentauth.org/problems/internal-payment-error'

  constructor(options: InternalPaymentError.Options = {}) {
    super('An internal payment error occurred.', { cause: options.cause })
  }
}

export declare namespace InternalPaymentError {
  type Options = {
    /** Original error, for server-side hooks and logging. Never sent to clients. */
    cause?: unknown
  }
}

/**
 * Payment requires additional action (e.g., 3DS authentication).
 */
export class PaymentActionRequiredError extends PaymentError {
  override readonly name = 'PaymentActionRequiredError'
  readonly title = 'Payment Action Required'
  readonly type = 'https://paymentauth.org/problems/payment-action-required'

  constructor(options: PaymentActionRequiredError.Options = {}) {
    const { reason } = options
    super(reason ? `Payment requires action: ${reason}.` : 'Payment requires action.')
  }
}

export declare namespace PaymentActionRequiredError {
  type Options = {
    /** Reason action is required (e.g., "requires_action"). */
    reason?: string
  }
}

/**
 * Payment has expired.
 */
export class PaymentExpiredError extends PaymentError {
  override readonly name = 'PaymentExpiredError'
  readonly title = 'Payment Expired'
  readonly type = 'https://paymentauth.org/problems/payment-expired'

  constructor(options: PaymentExpiredError.Options = {}) {
    const { expires } = options
    super(expires ? `Payment expired at ${expires}.` : 'Payment has expired.')
  }
}

export declare namespace PaymentExpiredError {
  type Options = {
    /** ISO 8601 expiration timestamp. */
    expires?: string
  }
}

/**
 * A credential was sent, but the payment result could not be confirmed.
 *
 * Reconcile with `credential` (and `transactionHash` when the method can derive it)
 * instead of retrying, which could pay twice.
 */
export class PaymentOutcomeUnknownError extends PaymentError {
  override readonly name = 'PaymentOutcomeUnknownError'
  readonly title = 'Payment Outcome Unknown'
  readonly type = 'https://paymentauth.org/problems/payment-outcome-unknown'

  /** Challenge the credential paid for. */
  readonly challenge: Challenge.Challenge
  /** Serialized credential sent with the paid request. */
  readonly credential: string
  /** On-chain hash the payment will have if it settled, when derivable from the credential. */
  readonly transactionHash: string | undefined

  constructor(options: PaymentOutcomeUnknownError.Options) {
    const { cause, challenge, credential, transactionHash } = options
    super(
      `Payment outcome is unknown after sending a credential for challenge "${challenge.id}". Do not blindly retry.`,
      { cause },
    )
    this.challenge = challenge
    this.credential = credential
    this.transactionHash = transactionHash
  }
}

export declare namespace PaymentOutcomeUnknownError {
  type Options = {
    /** Error thrown by the paid request, when it failed without a response. */
    cause?: unknown
    /** Challenge the credential paid for. */
    challenge: Challenge.Challenge
    /** Serialized credential sent with the paid request. */
    credential: string
    /** On-chain hash the payment will have if it settled. */
    transactionHash?: string | undefined
  }
}

/**
 * A server broadcast a payment transaction, the broadcast failed in a way that does not say whether
 * the node accepted it, and no receipt appeared before settlement stopped polling. The transaction
 * may still be included until `validBefore`.
 *
 * Settle it by looking up the receipt for `transactionHash`: once `validBefore` has passed, the
 * transaction can no longer be included, so one lookup after it is final. This is not a
 * `PaymentError`: HTTP handlers still answer with a generic 500 `InternalPaymentError`, whose
 * `cause` is this error.
 */
export class BroadcastOutcomeUnknownError extends Error {
  override readonly name = 'BroadcastOutcomeUnknownError'

  /** Hash of the broadcast transaction, as it will appear on chain if it is included. */
  readonly transactionHash: `0x${string}`
  /** Unix time in seconds after which the transaction can no longer be included, when it expires. */
  readonly validBefore: number | undefined

  constructor(options: BroadcastOutcomeUnknownError.Options) {
    const { cause, transactionHash, validBefore } = options
    super(
      `Broadcast outcome is unknown for transaction ${transactionHash}. Look up its receipt before retrying.`,
    )
    this.transactionHash = transactionHash
    this.validBefore = validBefore
    // Defined manually (non-enumerable, like native `cause`) so consumers on pre-ES2022 libs still typecheck.
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', { configurable: true, value: cause, writable: true })
  }
}

export declare namespace BroadcastOutcomeUnknownError {
  type Options = {
    /** The broadcast error that left the outcome unknown. */
    cause?: unknown
    /** Hash of the broadcast transaction. */
    transactionHash: `0x${string}`
    /** Unix time in seconds after which the transaction can no longer be included. */
    validBefore?: number | undefined
  }
}

/**
 * A pre-broadcast simulation of a fee-sponsored payment failed, so the payment was not broadcast.
 *
 * `phase` says which simulation failed: `sender` runs the sender's calls before sponsorship, and
 * `sponsored` runs the final envelope billed to `feePayer`. Callers use it, with `sender`,
 * `feePayer` and `paymentToken`, to tell a payer's insufficient balance from a sponsor's without
 * matching node messages. The node's error is the `cause`. This is not a `PaymentError`: HTTP
 * handlers still answer with a generic 500 `InternalPaymentError`, whose `cause` is this error.
 */
export class PaymentSimulationError extends Error {
  override readonly name = 'PaymentSimulationError'

  /** Fee payer the sponsored simulation billed. Set only in the `sponsored` phase. */
  readonly feePayer: `0x${string}` | undefined
  /** TIP-20 token of a single `transfer` or `transferWithMemo` call, when the transaction is one. */
  readonly paymentToken: `0x${string}` | undefined
  /** Simulation that failed. */
  readonly phase: PaymentSimulationError.Phase
  /** Sender of the simulated transaction. */
  readonly sender: `0x${string}` | undefined

  constructor(options: PaymentSimulationError.Options) {
    const { cause, feePayer, paymentToken, phase, sender } = options
    super('Payment simulation failed')
    this.feePayer = feePayer
    this.paymentToken = paymentToken
    this.phase = phase
    this.sender = sender
    // Defined manually (non-enumerable, like native `cause`) so consumers on pre-ES2022 libs still typecheck.
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', { configurable: true, value: cause, writable: true })
  }
}

export declare namespace PaymentSimulationError {
  /** `sender`: the sender's calls before sponsorship. `sponsored`: the final sponsored envelope. */
  type Phase = 'sender' | 'sponsored'

  type Options = {
    /** The simulation error. */
    cause?: unknown
    /** Fee payer of the sponsored simulation. */
    feePayer?: `0x${string}` | undefined
    /** TIP-20 token of a single transfer call. */
    paymentToken?: `0x${string}` | undefined
    /** Simulation that failed. */
    phase: Phase
    /** Sender of the simulated transaction. */
    sender?: `0x${string}` | undefined
  }
}

/**
 * The client cannot pay a challenge as offered, and nothing was signed or sent: for example, a
 * simulation before signing reverted because the payer lacks the currency. Automatic payment
 * (`fetch`) then tries the next offered challenge from the same response.
 *
 * Methods throw it only before anything that could move funds, so trying another offer cannot
 * pay twice.
 */
export class ChallengeUnpayableError extends Error {
  override readonly name = 'ChallengeUnpayableError'

  constructor(options: ChallengeUnpayableError.Options = {}) {
    const { cause, reason = describe(cause) } = options
    super(reason ? `Challenge cannot be paid: ${reason}` : 'Challenge cannot be paid.')
    // Defined manually (non-enumerable, like native `cause`) so consumers on pre-ES2022 libs still typecheck.
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', { configurable: true, value: cause, writable: true })
  }
}

function describe(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined
  return (cause as { shortMessage?: string }).shortMessage ?? cause.message
}

export declare namespace ChallengeUnpayableError {
  type Options = {
    /** The error that showed the challenge cannot be paid, such as a reverted simulation. */
    cause?: unknown
    /** Short description of why. Defaults to the cause's message. */
    reason?: string | undefined
  }
}

/**
 * A client withdrew from a Zone to pay a challenge, but the withdrawal did not settle on Tempo
 * before the client stopped waiting. The withdrawal cannot be undone and may still settle.
 *
 * Retry the same challenge with the same `tempo.charge` client to resume waiting without
 * withdrawing again, or find the settlement with `senderTag` on the Zone's portal.
 */
export class ZoneSettlementPendingError extends Error {
  override readonly name = 'ZoneSettlementPendingError'

  /** ID of the challenge the withdrawal pays. */
  readonly challengeId: string
  /** Sender tag of the withdrawal, as the portal's `WithdrawalProcessed` event carries it. */
  readonly senderTag: `0x${string}`
  /** ID of the Zone the withdrawal left. */
  readonly zoneId: number

  constructor(options: ZoneSettlementPendingError.Options) {
    const { cause, challengeId, senderTag, zoneId } = options
    super(
      `Zone ${zoneId} withdrawal ${senderTag} for challenge "${challengeId}" has not settled on Tempo yet. Retry the challenge to resume waiting instead of paying again.`,
    )
    this.challengeId = challengeId
    this.senderTag = senderTag
    this.zoneId = zoneId
    // Defined manually (non-enumerable, like native `cause`) so consumers on pre-ES2022 libs still typecheck.
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', { configurable: true, value: cause, writable: true })
  }
}

export declare namespace ZoneSettlementPendingError {
  type Options = {
    /** The error that ended the wait. */
    cause?: unknown
    /** ID of the challenge the withdrawal pays. */
    challengeId: string
    /** Sender tag of the withdrawal. */
    senderTag: `0x${string}`
    /** ID of the Zone the withdrawal left. */
    zoneId: number
  }
}

/**
 * No credential was provided but payment is required.
 */
export class PaymentRequiredError extends PaymentError {
  override readonly name = 'PaymentRequiredError'
  readonly title = 'Payment Required'
  readonly type = 'https://paymentauth.org/problems/payment-required'
  override readonly hint = Hints.paymentRequired

  constructor(options: PaymentRequiredError.Options = {}) {
    const { description } = options
    const parts = ['Payment is required']
    if (description) parts.push(`(${description})`)
    super(`${parts.join(' ')}.`)
  }
}

export declare namespace PaymentRequiredError {
  type Options = {
    /** Human-readable description of the payment. */
    description?: string | undefined
  }
}

/**
 * Credential payload does not match the expected schema.
 */
export class InvalidPayloadError extends PaymentError {
  override readonly name = 'InvalidPayloadError'
  readonly title = 'Invalid Payload'
  readonly type = 'https://paymentauth.org/problems/invalid-payload'

  constructor(options: InvalidPayloadError.Options = {}) {
    const { reason } = options
    super(reason ? `Credential payload is invalid: ${reason}.` : 'Credential payload is invalid.')
  }
}

export declare namespace InvalidPayloadError {
  type Options = {
    /** Reason the payload is invalid (e.g., "missing signature field"). */
    reason?: string
  }
}

/**
 * Request is malformed or contains invalid parameters.
 */
export class BadRequestError extends PaymentError {
  override readonly name = 'BadRequestError'
  readonly title = 'Bad Request'
  override readonly status = 400
  readonly type = 'https://paymentauth.org/problems/bad-request'

  constructor(options: BadRequestError.Options = {}) {
    const { reason } = options
    super(reason ? `Bad request: ${reason}.` : 'Bad request.')
  }
}

export declare namespace BadRequestError {
  type Options = {
    /** Reason the request is invalid. */
    reason?: string
  }
}

/**
 * Payment amount is insufficient (too low).
 */
export class PaymentInsufficientError extends PaymentError {
  override readonly name = 'PaymentInsufficientError'
  readonly title = 'Payment Insufficient'
  readonly type = 'https://paymentauth.org/problems/payment-insufficient'

  constructor(options: PaymentInsufficientError.Options = {}) {
    const { reason } = options
    super(reason ? `Payment insufficient: ${reason}.` : 'Payment amount is insufficient.')
  }
}

export declare namespace PaymentInsufficientError {
  type Options = {
    /** Reason the payment is insufficient (e.g., "expected 1000, received 500"). */
    reason?: string
  }
}

/**
 * Payment method is not supported by the server.
 */
export class PaymentMethodUnsupportedError extends PaymentError {
  override readonly name = 'PaymentMethodUnsupportedError'
  readonly title = 'Method Unsupported'
  override readonly status = 400
  readonly type = 'https://paymentauth.org/problems/method-unsupported'
  override readonly hint = Hints.methodUnsupported

  constructor(options: PaymentMethodUnsupportedError.Options = {}) {
    const { method } = options
    super(
      method ? `Payment method "${method}" is not supported.` : 'Payment method is not supported.',
    )
  }
}

export declare namespace PaymentMethodUnsupportedError {
  type Options = {
    /** The unsupported method identifier. */
    method?: string
  }
}

/**
 * Insufficient balance in the payment channel.
 */
export class InsufficientBalanceError extends PaymentError {
  override readonly name = 'InsufficientBalanceError'
  readonly title = 'Insufficient Balance'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/session/insufficient-balance'

  constructor(options: InsufficientBalanceError.Options = {}) {
    const { fundingUrl, reason } = options
    super(
      withFundingUrl(
        reason ? `Insufficient balance: ${reason}.` : 'Insufficient balance.',
        fundingUrl,
      ),
      { fundingUrl },
    )
  }
}

export declare namespace InsufficientBalanceError {
  type Options = {
    /** Page where the payer can get the funds, such as the MACH onramp. */
    fundingUrl?: string | undefined
    /** Reason for insufficient balance. */
    reason?: string
  }
}

/**
 * Voucher or close request signature is invalid.
 */
export class InvalidSignatureError extends PaymentError {
  override readonly name = 'InvalidSignatureError'
  readonly title = 'Invalid Signature'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/session/invalid-signature'

  constructor(options: InvalidSignatureError.Options = {}) {
    const { reason } = options
    super(reason ? `Invalid signature: ${reason}.` : 'Invalid signature.')
  }
}

export declare namespace InvalidSignatureError {
  type Options = {
    reason?: string
  }
}

/**
 * Recovered signer is not authorized for this channel.
 */
export class SignerMismatchError extends PaymentError {
  override readonly name = 'SignerMismatchError'
  readonly title = 'Signer Mismatch'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/session/signer-mismatch'

  constructor(options: SignerMismatchError.Options = {}) {
    const { reason } = options
    super(reason ? `Signer mismatch: ${reason}.` : 'Signer is not authorized for this channel.')
  }
}

export declare namespace SignerMismatchError {
  type Options = {
    reason?: string
  }
}

/**
 * Voucher cumulative amount exceeds the channel deposit.
 */
export class AmountExceedsDepositError extends PaymentError {
  override readonly name = 'AmountExceedsDepositError'
  readonly title = 'Amount Exceeds Deposit'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/session/amount-exceeds-deposit'

  constructor(options: AmountExceedsDepositError.Options = {}) {
    const { reason } = options
    super(reason ? `Amount exceeds deposit: ${reason}.` : 'Voucher amount exceeds channel deposit.')
  }
}

export declare namespace AmountExceedsDepositError {
  type Options = {
    reason?: string
  }
}

/**
 * Voucher amount increase is below the minimum delta.
 */
export class DeltaTooSmallError extends PaymentError {
  override readonly name = 'DeltaTooSmallError'
  readonly title = 'Delta Too Small'
  override readonly status = 402
  readonly type = 'https://paymentauth.org/problems/session/delta-too-small'

  constructor(options: DeltaTooSmallError.Options = {}) {
    const { reason } = options
    super(reason ? `Delta too small: ${reason}.` : 'Amount increase below minimum voucher delta.')
  }
}

export declare namespace DeltaTooSmallError {
  type Options = {
    reason?: string
  }
}

/**
 * No channel with this ID exists.
 */
export class ChannelNotFoundError extends PaymentError {
  override readonly name = 'ChannelNotFoundError'
  readonly title = 'Channel Not Found'
  override readonly status = 410
  readonly type = 'https://paymentauth.org/problems/session/channel-not-found'

  constructor(options: ChannelNotFoundError.Options = {}) {
    const { reason } = options
    super(reason ? `Channel not found: ${reason}.` : 'No channel with this ID exists.')
  }
}

export declare namespace ChannelNotFoundError {
  type Options = {
    reason?: string
  }
}

/**
 * Channel is closed or finalized.
 */
export class ChannelClosedError extends PaymentError {
  override readonly name = 'ChannelClosedError'
  readonly title = 'Channel Closed'
  override readonly status = 410
  readonly type = 'https://paymentauth.org/problems/session/channel-finalized'

  constructor(options: ChannelClosedError.Options = {}) {
    const { reason } = options
    super(reason ? `Channel closed: ${reason}.` : 'Channel is closed.')
  }
}

export declare namespace ChannelClosedError {
  type Options = {
    /** Reason the channel is closed. */
    reason?: string
  }
}
