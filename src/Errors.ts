/**
 * Base class for all payment-related errors.
 */
export abstract class PaymentError extends Error {
  /** RFC 9457 Problem Details type URI. */
  abstract readonly type: string

  /** Human-readable summary for RFC 9457 Problem Details. */
  abstract readonly title: string

  /** HTTP status code. */
  readonly status: number = 402

  /** Converts the error to RFC 9457 Problem Details format. */
  toProblemDetails(challengeId?: string): PaymentError.ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      ...(challengeId && { challengeId }),
    }
  }
}

export declare namespace PaymentError {
  type ProblemDetails = {
    /** RFC 9457 Problem Details type URI. */
    type: string
    /** Human-readable summary. */
    title: string
    /** HTTP status code. */
    status: number
    /** Human-readable explanation. */
    detail: string
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
  override readonly name = 'VerificationFailedError'
  readonly title = 'Verification Failed'
  readonly type = 'https://paymentauth.org/problems/verification-failed'

  constructor(options: VerificationFailedError.Options = {}) {
    const { reason } = options
    super(reason ? `Payment verification failed: ${reason}.` : 'Payment verification failed.')
  }
}

export declare namespace VerificationFailedError {
  type Options = {
    /** Reason verification failed (e.g., "invalid signature", "insufficient amount"). */
    reason?: string
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
 * No credential was provided but payment is required.
 */
export class PaymentRequiredError extends PaymentError {
  override readonly name = 'PaymentRequiredError'
  readonly title = 'Payment Required'
  readonly type = 'https://paymentauth.org/problems/payment-required'

  constructor(options: PaymentRequiredError.Options = {}) {
    const { description, realm } = options
    const parts = ['Payment is required']
    if (realm) parts.push(`for "${realm}"`)
    if (description) parts.push(`(${description})`)
    super(`${parts.join(' ')}.`)
  }
}

export declare namespace PaymentRequiredError {
  type Options = {
    /** Human-readable description of the payment. */
    description?: string | undefined
    /** Server realm (e.g., hostname). */
    realm?: string | undefined
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
    const { reason } = options
    super(reason ? `Insufficient balance: ${reason}.` : 'Insufficient balance.')
  }
}

export declare namespace InsufficientBalanceError {
  type Options = {
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
