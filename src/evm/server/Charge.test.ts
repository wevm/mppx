import { evm, Mppx } from 'mppx/server'
import { Header as x402_Header, Types as x402_Types, type PaymentPayload } from 'mppx/x402'
import { describe, expect, test } from 'vp/test'

const currency = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const payer = '0x1111111111111111111111111111111111111111'
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const transaction = `0x${'1'.repeat(64)}`

describe('evm charge server', () => {
  test('forwards shared charge config into x402 exact verification', async () => {
    let verified:
      | {
          paymentPayload: PaymentPayload
          paymentRequirements: x402_Types.PaymentRequirements
        }
      | undefined
    let settled:
      | {
          paymentPayload: PaymentPayload
          paymentRequirements: x402_Types.PaymentRequirements
        }
      | undefined

    const mppx = Mppx.create({
      methods: [
        evm({
          currency,
          decimals: 6,
          maxTimeoutSeconds: 30,
          network: 'eip155:84532',
          recipient,
          transfer: {
            name: 'USDC',
            type: 'eip3009',
            version: '2',
          },
          x402: {
            facilitator: {
              async verify(paymentPayload, paymentRequirements) {
                verified = { paymentPayload, paymentRequirements }
                return { isValid: true }
              },
              async settle(paymentPayload, paymentRequirements) {
                settled = { paymentPayload, paymentRequirements }
                return {
                  network: paymentRequirements.network,
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey: 'test-secret',
    })

    const route = mppx.evm.charge({
      amount: '0.25',
      resource: { url: 'https://example.com/paid' },
    })

    const challenge = await route(new Request('https://example.com/paid'))
    expect(challenge.status).toBe(402)
    if (challenge.status !== 402) throw new Error()

    const paymentRequired = x402_Header.decodePaymentRequired(
      challenge.challenge.headers.get(x402_Types.paymentRequiredHeader)!,
    )
    const accepted = paymentRequired.accepts[0]!

    expect(accepted).toEqual({
      amount: '250000',
      asset: currency,
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDC',
        version: '2',
      },
      maxTimeoutSeconds: 30,
      network: 'eip155:84532',
      payTo: recipient,
      scheme: 'exact',
    })

    const paymentSignature = x402_Header.encodePaymentSignature({
      accepted,
      payload: {
        authorization: {
          from: payer,
          nonce: `0x${'2'.repeat(64)}`,
          to: recipient,
          validAfter: '0',
          validBefore: '9999999999',
          value: accepted.amount,
        },
        signature: `0x${'3'.repeat(130)}`,
      },
      resource: paymentRequired.resource,
      x402Version: 2,
    })

    const result = await route(
      new Request('https://example.com/paid', {
        headers: { [x402_Types.paymentSignatureHeader]: paymentSignature },
      }),
    )

    expect(result.status).toBe(200)
    expect(verified?.paymentRequirements).toEqual(accepted)
    expect(verified?.paymentPayload.accepted).toEqual(accepted)
    expect(settled?.paymentRequirements).toEqual(accepted)
    expect(settled?.paymentPayload.accepted).toEqual(accepted)
  })
})
