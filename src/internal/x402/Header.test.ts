import * as Header from './Header.js'
import type * as Types from './Types.js'

describe('x402 headers', () => {
  test('round trips PAYMENT-REQUIRED header values', () => {
    const paymentRequired: Types.PaymentRequired = {
      accepts: [
        {
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          extra: {
            assetTransferMethod: 'eip3009',
            name: 'USDC',
            version: '2',
          },
          maxTimeoutSeconds: 60,
          network: 'eip155:84532',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          scheme: 'exact',
        },
      ],
      resource: {
        mimeType: 'application/json',
        url: 'https://api.example.com/premium-data',
      },
      extensions: {
        mppx: {
          info: { method: 'GET' },
          schema: {
            properties: { method: { type: 'string' } },
            required: ['method'],
            type: 'object',
          },
        },
      },
      x402Version: 2,
    }

    const header = Header.encodePaymentRequired(paymentRequired)

    expect(Header.decodePaymentRequired(header)).toEqual(paymentRequired)
  })

  test('round trips PAYMENT-SIGNATURE header values', () => {
    const paymentPayload: Types.PaymentPayload = {
      accepted: {
        amount: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        maxTimeoutSeconds: 60,
        network: 'eip155:84532',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        scheme: 'exact',
      },
      payload: {
        authorization: {
          from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
          nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
          to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          validAfter: '1740672089',
          validBefore: '1740672154',
          value: '10000',
        },
        signature:
          '0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c',
      },
      x402Version: 2,
    }

    const header = Header.encodePaymentSignature(paymentPayload)

    expect(Header.decodePaymentSignature(header)).toEqual(paymentPayload)
  })
})
