import { Challenge, Credential, Receipt } from 'mppx'
import { evm as evm_client, Mppx as ClientMppx } from 'mppx/client'
import { Types as evm_Types } from 'mppx/evm'
import { evm, Mppx } from 'mppx/server'
import { Types as x402_Types, type PaymentPayload } from 'mppx/x402'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

const currency = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const transaction = `0x${'1'.repeat(64)}`
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)

describe('evm charge server', () => {
  test('settles native Payment-auth authorization credentials', async () => {
    let facilitated:
      | {
          paymentPayload: PaymentPayload
          paymentRequirements: x402_Types.PaymentRequirements
        }
      | undefined

    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          facilitator: {
            async verify(paymentPayload, paymentRequirements) {
              facilitated = { paymentPayload, paymentRequirements }
              return { isValid: true }
            },
            async settle(paymentPayload, paymentRequirements) {
              facilitated = { paymentPayload, paymentRequirements }
              return {
                network: paymentRequirements.network,
                success: true,
                transaction,
              }
            },
          },
        }),
      ],
      secretKey: 'test-secret',
    })
    const client = ClientMppx.create({
      methods: [
        evm_client({
          account,
          currencies: [evm_client.assets.baseSepolia.USDC],
          maxAmount: '0.25',
        }),
      ],
      polyfill: false,
    })
    const route = mppx.evm.charge({ amount: '0.25' })

    const first = await route(new Request('https://example.com/paid'))
    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(first.challenge)
    expect(challenge.method).toBe('evm')
    expect(challenge.intent).toBe('charge')
    expect(challenge.request).toEqual({
      amount: '250000',
      currency,
      methodDetails: {
        chainId: 84532,
        credentialTypes: ['authorization'],
        decimals: 6,
      },
      recipient,
    })

    const authorization = await client.createCredential(first.challenge)
    const credential = Credential.deserialize<evm_Types.AuthorizationPayload>(authorization)
    expect(credential.payload.type).toBe('authorization')
    expect(credential.payload.nonce).toBe(evm_Types.challengeHash(challenge))
    expect(credential.payload.to).toBe(recipient)
    expect(credential.payload.value).toBe('250000')

    const result = await route(
      new Request('https://example.com/paid', {
        headers: { Authorization: authorization },
      }),
    )

    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error()
    const response = result.withReceipt(Response.json({ ok: true }))
    const receipt = Receipt.fromResponse(response)
    expect(receipt).toMatchObject({
      chainId: 84532,
      challengeId: challenge.id,
      method: 'evm',
      reference: transaction,
      status: 'success',
    })
    expect(facilitated?.paymentRequirements).toEqual({
      amount: '250000',
      asset: currency,
      extra: {
        assetTransferMethod: evm_Types.eip3009,
        name: 'USDC',
        version: '2',
      },
      maxTimeoutSeconds: 300,
      network: evm_Types.networkOf(84532),
      payTo: recipient,
      scheme: 'exact',
    })
    expect(facilitated?.paymentPayload.payload).toEqual({
      authorization: {
        from: credential.payload.from,
        nonce: credential.payload.nonce,
        to: credential.payload.to,
        validAfter: credential.payload.validAfter,
        validBefore: credential.payload.validBefore,
        value: credential.payload.value,
      },
      signature: credential.payload.signature,
    })
  })
})
