import { Challenge, Credential, Receipt } from 'mppx'
import { evm as evm_client, Mppx as ClientMppx } from 'mppx/client'
import { Types as evm_Types } from 'mppx/evm'
import { evm, Mppx } from 'mppx/server'
import { Header as x402_Header, Types as x402_Types, type PaymentPayload } from 'mppx/x402'
import { privateKeyToAccount } from 'viem/accounts'
import { usdc } from 'viem/tokens'
import { describe, expect, test } from 'vp/test'

const currency = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const transaction = `0x${'1'.repeat(64)}`
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)

describe('evm charge server', () => {
  test('resolves viem token currency config', async () => {
    const mppx = Mppx.create({
      methods: [
        evm({
          authorization: { name: 'USD Coin', version: '2' },
          chainId: 84532,
          currency: usdc,
          recipient,
          x402: {
            facilitator: {
              async verify() {
                return { isValid: true }
              },
              async settle() {
                return {
                  network: evm_Types.networkOf(84532),
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey: 'test-secret-key-test-secret-key-32',
    })
    const route = mppx.evm.charge({ amount: '0.25' })

    const first = await route(new Request('https://example.com/paid'))

    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error()
    const challenge = Challenge.fromResponse(first.challenge)
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
  })

  test('requires chain ID for viem token currency config', () => {
    expect(() =>
      evm({
        authorization: { name: 'USD Coin', version: '2' },
        currency: usdc,
        recipient,
        settle: async () => ({ reference: transaction }),
      }),
    ).toThrow('EVM authorization requires `chainId`.')
  })

  test('rejects viem token currency unavailable on configured chain', () => {
    expect(() =>
      evm({
        authorization: { name: 'USD Coin', version: '2' },
        chainId: 999_999,
        currency: usdc,
        recipient,
        settle: async () => ({ reference: transaction }),
      }),
    ).toThrow('EVM currency is not available on chain ID 999999.')
  })

  test('requires authorization metadata for viem token currency config', () => {
    expect(() =>
      evm({
        chainId: 84532,
        currency: usdc,
        recipient,
        settle: async () => ({ reference: transaction }),
      }),
    ).toThrow('EVM authorization requires `authorization` metadata.')
  })

  test('infers native charge defaults from known asset metadata', async () => {
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.base.USDC,
          recipient,
          settle: async () => ({ reference: transaction }),
        }),
      ],
      secretKey: 'test-secret-key-test-secret-key-32',
    })
    const route = mppx.evm.charge({ amount: '0.25' })

    const response = await route(new Request('https://example.com/paid'))

    expect(response.status).toBe(402)
    if (response.status !== 402) throw new Error()
    const challenge = Challenge.fromResponse(response.challenge)
    expect(challenge.request).toEqual({
      amount: '250000',
      currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      methodDetails: {
        chainId: 8453,
        credentialTypes: ['authorization'],
        decimals: 6,
      },
      recipient,
    })
  })

  test('requires authorization metadata for known assets without EIP-3009 transfer metadata', () => {
    const permit2Asset = evm.assets.define({
      address: currency,
      decimals: 6,
      network: 'eip155:84532',
      transfer: {
        type: 'permit2',
      },
    })

    expect(() =>
      evm({
        currency: permit2Asset,
        recipient,
        settle: async () => ({ reference: transaction }),
      }),
    ).toThrow('EVM authorization requires `authorization` metadata.')
  })

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
          x402: {
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
          },
        }),
      ],
      secretKey: 'test-secret-key-test-secret-key-32',
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

    const forgedPayload: evm_Types.AuthorizationPayload = {
      ...credential.payload,
      nonce: `0x${'2'.repeat(64)}`,
      signature: await account.signTypedData({
        domain: evm_Types.authorizationDomain({
          authorization: { name: 'USDC', version: '2' },
          chainId: 84532,
          currency,
        }),
        message: {
          from: credential.payload.from as `0x${string}`,
          nonce: `0x${'2'.repeat(64)}` as `0x${string}`,
          to: credential.payload.to as `0x${string}`,
          validAfter: BigInt(credential.payload.validAfter),
          validBefore: BigInt(credential.payload.validBefore),
          value: BigInt(credential.payload.value),
        },
        primaryType: 'TransferWithAuthorization',
        types: evm_Types.authorizationTypes,
      }),
    }
    const forgedAuthorization = Credential.serialize(
      Credential.from({
        challenge,
        payload: forgedPayload,
        ...(credential.source ? { source: credential.source } : {}),
      }),
    )

    const forgedResult = await route(
      new Request('https://example.com/paid', {
        headers: {
          Authorization: forgedAuthorization,
          [x402_Types.paymentSignatureHeader]: 'ignored-for-native-authorization',
        },
      }),
    )
    expect(forgedResult.status).toBe(402)

    const paymentRequired = x402_Header.decodePaymentRequired(
      first.challenge.headers.get(x402_Types.paymentRequiredHeader)!,
    )
    const x402Authorization = Credential.serialize(
      Credential.from({
        challenge,
        payload: {
          accepted: paymentRequired.accepts[0]!,
          extensions: paymentRequired.extensions,
          payload: {
            authorization: {
              from: account.address,
              nonce: `0x${'3'.repeat(64)}`,
              to: recipient,
              validAfter: '0',
              validBefore: '9999999999',
              value: paymentRequired.accepts[0]!.amount,
            },
            signature: `0x${'4'.repeat(130)}`,
          },
          resource: paymentRequired.resource,
          x402Version: 2,
        } satisfies PaymentPayload,
      }),
    )

    const x402InAuthorizationResult = await route(
      new Request('https://example.com/paid', {
        headers: { Authorization: x402Authorization },
      }),
    )
    expect(x402InAuthorizationResult.status).toBe(402)
  })
})
