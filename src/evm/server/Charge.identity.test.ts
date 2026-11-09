import { Challenge } from 'mppx'
import { evm as clientEvm, Mppx as ClientMppx } from 'mppx/client'
import type * as Identity from 'mppx/identity'
import { evm, Mppx } from 'mppx/server'
import { Types } from 'mppx/x402'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, test } from 'vp/test'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const reference = `0x${'1'.repeat(64)}`

async function pay(protocol: 'mpp' | 'x402') {
  const settlements: unknown[] = []
  const checked: string[] = []
  const method = evm.charge({
    currency: evm.assets.base.USDC,
    recipient,
    x402: {
      facilitator: {
        verify: async () => ({ isValid: true }),
        async settle(paymentPayload) {
          settlements.push(paymentPayload)
          return { success: true, transaction: reference, network: 'eip155:8453' }
        },
      },
    },
  })
  const check: Identity.PaymentCheck = {
    requires: [],
    verify({ challenge }) {
      checked.push(challenge.id)
      return { status: 'valid', value: true }
    },
  }
  const server = Mppx.create({
    methods: [method],
    realm: 'example.test',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const route = server.charge({ amount: '0.25', identity: { payment: check } })
  const request = new Request('https://example.test/paid')
  const offered = await route(request)
  if (offered.status !== 402) throw new Error()
  const response =
    protocol === 'mpp'
      ? offered.challenge
      : new Response(null, {
          status: 402,
          headers: {
            [Types.paymentRequiredHeader]: offered.challenge.headers.get(
              Types.paymentRequiredHeader,
            )!,
          },
        })
  const client = ClientMppx.create({
    methods: [
      clientEvm.charge({ account, currencies: [clientEvm.assets.base.USDC], networks: [8453] }),
    ],
    polyfill: false,
  })
  const prepared = await client.preparePayment(response)
  const credential = await prepared.createCredential()
  const header = protocol === 'mpp' ? 'Authorization' : Types.paymentSignatureHeader
  const result = await route(new Request(request, { headers: { [header]: credential } }))
  return { checked, offered: Challenge.fromResponse(offered.challenge), result, settlements }
}

test('a payment check runs against the Challenge an MPP Credential answers', async () => {
  const { checked, offered, result, settlements } = await pay('mpp')
  expect(result.status).toBe(200)
  expect(checked).toEqual([offered.id])
  expect(settlements).toHaveLength(1)
})

test('a route with a payment check rejects x402 Credentials before settlement', async () => {
  const { checked, result, settlements } = await pay('x402')
  expect(result.status).toBe(402)
  expect(result.status === 402 && result.rejection).toMatchObject({
    status: 'invalid',
    reason: "This route's identity payment check does not accept x402 credentials.",
  })
  expect(checked).toEqual([])
  expect(settlements).toEqual([])
})
