import { Challenge } from 'mpay'
import { Response } from 'mpay/server'
import { describe, expect, test } from 'vitest'
import * as Errors from '../Errors.js'

const challenge = Challenge.from({
  id: 'abc123',
  intent: 'charge',
  method: 'tempo',
  realm: 'api.example.com',
  request: { amount: '1000000' },
})

describe('requirePayment', () => {
  test('returns 402 Response with WWW-Authenticate header', () => {
    const response = Response.requirePayment({ challenge })

    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toBe(Challenge.serialize(challenge))
  })

  test('includes problem details in body when error provided', async () => {
    const error = new Errors.PaymentRequiredError()

    const response = Response.requirePayment({ challenge, error })

    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const body = await response.json()
    expect(body).toEqual(error.toProblemDetails(challenge.id))
  })
})
