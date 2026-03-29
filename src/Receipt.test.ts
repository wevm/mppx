import { Receipt } from 'mppx'
import { describe, expect, test } from 'vp/test'

describe('from', () => {
  test('behavior: creates receipt with success status', () => {
    const receipt = Receipt.from({
      method: 'tempo',
      reference: '0x1234',
      status: 'success',
      timestamp: '2025-01-21T12:00:00.000Z',
    })

    expect(receipt).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "0x1234",
        "status": "success",
        "timestamp": "2025-01-21T12:00:00.000Z",
      }
    `)
  })

  test('error: rejects receipt with failed status', () => {
    expect(() =>
      Receipt.from({
        method: 'tempo',
        reference: '0xabcd',
        status: 'failed' as 'success',
        timestamp: '2025-01-21T13:00:00.000Z',
      }),
    ).toThrow()
  })
})

describe('serialize', () => {
  test('behavior: serializes receipt to base64url', () => {
    const receipt = Receipt.from({
      method: 'tempo',
      reference: '0x1234',
      status: 'success',
      timestamp: '2025-01-21T12:00:00.000Z',
    })

    const header = Receipt.serialize(receipt)

    expect(header).toMatchInlineSnapshot(
      `"eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4MTIzNCIsInN0YXR1cyI6InN1Y2Nlc3MiLCJ0aW1lc3RhbXAiOiIyMDI1LTAxLTIxVDEyOjAwOjAwLjAwMFoifQ"`,
    )
  })
})

describe('deserialize', () => {
  test('behavior: deserializes base64url to receipt', () => {
    const encoded =
      'eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4MTIzNCIsInN0YXR1cyI6InN1Y2Nlc3MiLCJ0aW1lc3RhbXAiOiIyMDI1LTAxLTIxVDEyOjAwOjAwLjAwMFoifQ'

    const receipt = Receipt.deserialize(encoded)

    expect(receipt).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "0x1234",
        "status": "success",
        "timestamp": "2025-01-21T12:00:00.000Z",
      }
    `)
  })
})

describe('fromResponse', () => {
  test('behavior: extracts receipt from Payment-Receipt header', () => {
    const encoded =
      'eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4MTIzNCIsInN0YXR1cyI6InN1Y2Nlc3MiLCJ0aW1lc3RhbXAiOiIyMDI1LTAxLTIxVDEyOjAwOjAwLjAwMFoifQ'

    const response = new Response('OK', {
      headers: { 'Payment-Receipt': encoded },
    })

    const receipt = Receipt.fromResponse(response)

    expect(receipt).toMatchInlineSnapshot(`
      {
        "method": "tempo",
        "reference": "0x1234",
        "status": "success",
        "timestamp": "2025-01-21T12:00:00.000Z",
      }
    `)
  })

  test('error: throws when Payment-Receipt header is missing', () => {
    const response = new Response('OK')

    expect(() => Receipt.fromResponse(response)).toThrowErrorMatchingInlineSnapshot(
      `[Error: Missing Payment-Receipt header.]`,
    )
  })
})
