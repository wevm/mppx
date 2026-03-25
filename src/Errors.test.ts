import { describe, expect, test } from 'vp/test'

import {
  AmountExceedsDepositError,
  BadRequestError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidChallengeError,
  InvalidPayloadError,
  InvalidSignatureError,
  MalformedCredentialError,
  PaymentActionRequiredError,
  PaymentExpiredError,
  PaymentInsufficientError,
  PaymentMethodUnsupportedError,
  PaymentRequiredError,
  SignerMismatchError,
  VerificationFailedError,
} from './Errors.js'

function errorSnapshot(error: Error & { type: string; status: number }) {
  return {
    name: error.name,
    message: error.message,
    type: error.type,
    status: error.status,
  }
}

describe('MalformedCredentialError', () => {
  test('default', () => {
    expect(errorSnapshot(new MalformedCredentialError())).toMatchInlineSnapshot(`
      {
        "message": "Credential is malformed.",
        "name": "MalformedCredentialError",
        "status": 402,
        "type": "https://paymentauth.org/problems/malformed-credential",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new MalformedCredentialError({ reason: 'invalid base64url' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Credential is malformed: invalid base64url.",
          "name": "MalformedCredentialError",
          "status": 402,
          "type": "https://paymentauth.org/problems/malformed-credential",
        }
      `)
  })
})

describe('InvalidChallengeError', () => {
  test('default', () => {
    expect(errorSnapshot(new InvalidChallengeError())).toMatchInlineSnapshot(`
      {
        "message": "Challenge is invalid.",
        "name": "InvalidChallengeError",
        "status": 402,
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })

  test('with id', () => {
    expect(errorSnapshot(new InvalidChallengeError({ id: 'abc123' }))).toMatchInlineSnapshot(`
      {
        "message": "Challenge "abc123" is invalid.",
        "name": "InvalidChallengeError",
        "status": 402,
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new InvalidChallengeError({ reason: 'expired' }))).toMatchInlineSnapshot(`
      {
        "message": "Challenge is invalid: expired.",
        "name": "InvalidChallengeError",
        "status": 402,
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })

  test('with id and reason', () => {
    expect(errorSnapshot(new InvalidChallengeError({ id: 'abc123', reason: 'already used' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Challenge "abc123" is invalid: already used.",
          "name": "InvalidChallengeError",
          "status": 402,
          "type": "https://paymentauth.org/problems/invalid-challenge",
        }
      `)
  })
})

describe('VerificationFailedError', () => {
  test('default', () => {
    expect(errorSnapshot(new VerificationFailedError())).toMatchInlineSnapshot(`
      {
        "message": "Payment verification failed.",
        "name": "VerificationFailedError",
        "status": 402,
        "type": "https://paymentauth.org/problems/verification-failed",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new VerificationFailedError({ reason: 'invalid signature' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment verification failed: invalid signature.",
          "name": "VerificationFailedError",
          "status": 402,
          "type": "https://paymentauth.org/problems/verification-failed",
        }
      `)
  })
})

describe('PaymentExpiredError', () => {
  test('default', () => {
    expect(errorSnapshot(new PaymentExpiredError())).toMatchInlineSnapshot(`
      {
        "message": "Payment has expired.",
        "name": "PaymentExpiredError",
        "status": 402,
        "type": "https://paymentauth.org/problems/payment-expired",
      }
    `)
  })

  test('with expires', () => {
    expect(errorSnapshot(new PaymentExpiredError({ expires: '2025-01-26T12:00:00Z' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment expired at 2025-01-26T12:00:00Z.",
          "name": "PaymentExpiredError",
          "status": 402,
          "type": "https://paymentauth.org/problems/payment-expired",
        }
      `)
  })
})

describe('PaymentRequiredError', () => {
  test('default', () => {
    expect(errorSnapshot(new PaymentRequiredError())).toMatchInlineSnapshot(`
      {
        "message": "Payment is required.",
        "name": "PaymentRequiredError",
        "status": 402,
        "type": "https://paymentauth.org/problems/payment-required",
      }
    `)
  })

  test('with description', () => {
    expect(errorSnapshot(new PaymentRequiredError({ description: 'API access fee' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment is required (API access fee).",
          "name": "PaymentRequiredError",
          "status": 402,
          "type": "https://paymentauth.org/problems/payment-required",
        }
      `)
  })
})

describe('InvalidPayloadError', () => {
  test('default', () => {
    expect(errorSnapshot(new InvalidPayloadError())).toMatchInlineSnapshot(`
      {
        "message": "Credential payload is invalid.",
        "name": "InvalidPayloadError",
        "status": 402,
        "type": "https://paymentauth.org/problems/invalid-payload",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new InvalidPayloadError({ reason: 'missing signature field' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Credential payload is invalid: missing signature field.",
          "name": "InvalidPayloadError",
          "status": 402,
          "type": "https://paymentauth.org/problems/invalid-payload",
        }
      `)
  })
})

describe('BadRequestError', () => {
  test('default', () => {
    expect(errorSnapshot(new BadRequestError())).toMatchInlineSnapshot(`
      {
        "message": "Bad request.",
        "name": "BadRequestError",
        "status": 400,
        "type": "https://paymentauth.org/problems/bad-request",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new BadRequestError({ reason: 'cannot combine hash type with feePayer' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Bad request: cannot combine hash type with feePayer.",
          "name": "BadRequestError",
          "status": 400,
          "type": "https://paymentauth.org/problems/bad-request",
        }
      `)
  })
})

describe('PaymentInsufficientError', () => {
  test('default', () => {
    expect(errorSnapshot(new PaymentInsufficientError())).toMatchInlineSnapshot(`
      {
        "message": "Payment amount is insufficient.",
        "name": "PaymentInsufficientError",
        "status": 402,
        "type": "https://paymentauth.org/problems/payment-insufficient",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new PaymentInsufficientError({ reason: 'expected 1000, received 500' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment insufficient: expected 1000, received 500.",
          "name": "PaymentInsufficientError",
          "status": 402,
          "type": "https://paymentauth.org/problems/payment-insufficient",
        }
      `)
  })
})

describe('PaymentMethodUnsupportedError', () => {
  test('default', () => {
    expect(errorSnapshot(new PaymentMethodUnsupportedError())).toMatchInlineSnapshot(`
      {
        "message": "Payment method is not supported.",
        "name": "PaymentMethodUnsupportedError",
        "status": 400,
        "type": "https://paymentauth.org/problems/method-unsupported",
      }
    `)
  })

  test('with method', () => {
    expect(errorSnapshot(new PaymentMethodUnsupportedError({ method: 'bitcoin' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment method "bitcoin" is not supported.",
          "name": "PaymentMethodUnsupportedError",
          "status": 400,
          "type": "https://paymentauth.org/problems/method-unsupported",
        }
      `)
  })
})

describe('InsufficientBalanceError', () => {
  test('default', () => {
    expect(errorSnapshot(new InsufficientBalanceError())).toMatchInlineSnapshot(`
      {
        "message": "Insufficient balance.",
        "name": "InsufficientBalanceError",
        "status": 402,
        "type": "https://paymentauth.org/problems/session/insufficient-balance",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new InsufficientBalanceError({ reason: 'requested 500, available 100' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Insufficient balance: requested 500, available 100.",
          "name": "InsufficientBalanceError",
          "status": 402,
          "type": "https://paymentauth.org/problems/session/insufficient-balance",
        }
      `)
  })
})

describe('InvalidSignatureError', () => {
  test('default', () => {
    expect(errorSnapshot(new InvalidSignatureError())).toMatchInlineSnapshot(`
      {
        "message": "Invalid signature.",
        "name": "InvalidSignatureError",
        "status": 402,
        "type": "https://paymentauth.org/problems/session/invalid-signature",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new InvalidSignatureError({ reason: 'ECDSA recovery failed' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Invalid signature: ECDSA recovery failed.",
          "name": "InvalidSignatureError",
          "status": 402,
          "type": "https://paymentauth.org/problems/session/invalid-signature",
        }
      `)
  })
})

describe('SignerMismatchError', () => {
  test('default', () => {
    expect(errorSnapshot(new SignerMismatchError())).toMatchInlineSnapshot(`
      {
        "message": "Signer is not authorized for this channel.",
        "name": "SignerMismatchError",
        "status": 402,
        "type": "https://paymentauth.org/problems/session/signer-mismatch",
      }
    `)
  })
})

describe('AmountExceedsDepositError', () => {
  test('default', () => {
    expect(errorSnapshot(new AmountExceedsDepositError())).toMatchInlineSnapshot(`
      {
        "message": "Voucher amount exceeds channel deposit.",
        "name": "AmountExceedsDepositError",
        "status": 402,
        "type": "https://paymentauth.org/problems/session/amount-exceeds-deposit",
      }
    `)
  })
})

describe('DeltaTooSmallError', () => {
  test('default', () => {
    expect(errorSnapshot(new DeltaTooSmallError())).toMatchInlineSnapshot(`
      {
        "message": "Amount increase below minimum voucher delta.",
        "name": "DeltaTooSmallError",
        "status": 402,
        "type": "https://paymentauth.org/problems/session/delta-too-small",
      }
    `)
  })
})

describe('ChannelNotFoundError', () => {
  test('default', () => {
    expect(errorSnapshot(new ChannelNotFoundError())).toMatchInlineSnapshot(`
      {
        "message": "No channel with this ID exists.",
        "name": "ChannelNotFoundError",
        "status": 410,
        "type": "https://paymentauth.org/problems/session/channel-not-found",
      }
    `)
  })
})

describe('ChannelClosedError', () => {
  test('default', () => {
    expect(errorSnapshot(new ChannelClosedError())).toMatchInlineSnapshot(`
      {
        "message": "Channel is closed.",
        "name": "ChannelClosedError",
        "status": 410,
        "type": "https://paymentauth.org/problems/session/channel-finalized",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new ChannelClosedError({ reason: 'channel is finalized on-chain' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Channel closed: channel is finalized on-chain.",
          "name": "ChannelClosedError",
          "status": 410,
          "type": "https://paymentauth.org/problems/session/channel-finalized",
        }
      `)
  })
})

describe('PaymentActionRequiredError', () => {
  test('default', () => {
    expect(errorSnapshot(new PaymentActionRequiredError())).toMatchInlineSnapshot(`
      {
        "message": "Payment requires action.",
        "name": "PaymentActionRequiredError",
        "status": 402,
        "type": "https://paymentauth.org/problems/payment-action-required",
      }
    `)
  })

  test('with reason', () => {
    expect(errorSnapshot(new PaymentActionRequiredError({ reason: 'requires_action' })))
      .toMatchInlineSnapshot(`
        {
          "message": "Payment requires action: requires_action.",
          "name": "PaymentActionRequiredError",
          "status": 402,
          "type": "https://paymentauth.org/problems/payment-action-required",
        }
      `)
  })

  test('toProblemDetails', () => {
    const error = new PaymentActionRequiredError({ reason: 'Stripe PaymentIntent requires action' })
    expect(error.toProblemDetails('ch_123')).toMatchInlineSnapshot(`
      {
        "challengeId": "ch_123",
        "detail": "Payment requires action: Stripe PaymentIntent requires action.",
        "status": 402,
        "title": "Payment Action Required",
        "type": "https://paymentauth.org/problems/payment-action-required",
      }
    `)
  })
})

describe('toProblemDetails', () => {
  test('without challengeId', () => {
    const error = new MalformedCredentialError({ reason: 'invalid JSON' })
    expect(error.toProblemDetails()).toMatchInlineSnapshot(`
      {
        "detail": "Credential is malformed: invalid JSON.",
        "status": 402,
        "title": "Malformed Credential",
        "type": "https://paymentauth.org/problems/malformed-credential",
      }
    `)
  })

  test('with challengeId', () => {
    const error = new InvalidChallengeError({ id: 'abc123', reason: 'expired' })
    expect(error.toProblemDetails('abc123')).toMatchInlineSnapshot(`
      {
        "challengeId": "abc123",
        "detail": "Challenge "abc123" is invalid: expired.",
        "status": 402,
        "title": "Invalid Challenge",
        "type": "https://paymentauth.org/problems/invalid-challenge",
      }
    `)
  })
})
