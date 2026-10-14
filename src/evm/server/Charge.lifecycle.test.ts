import { Challenge, Credential } from 'mppx'
import { evm as clientEvm, Mppx as ClientMppx } from 'mppx/client'
import { evm, Mppx } from 'mppx/server'
import { Types } from 'mppx/x402'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const reference = `0x${'1'.repeat(64)}`
const realm = 'example.test'
const secretKey = 'test-secret-key-test-secret-key-32'

async function fixture(protocol: 'mpp' | 'x402') {
  const payers: (string | undefined)[] = []
  const settlements: Types.PaymentPayload[] = []
  const state = { valid: true, verifications: 0 }
  const method = evm.charge({
    currency: evm.assets.base.USDC,
    onPaymentSuccess: ({ payer }) => void payers.push(payer),
    recipient,
    x402: {
      facilitator: {
        async verify() {
          state.verifications++
          return { isValid: state.valid, invalidReason: 'Authorization is no longer spendable' }
        },
        async settle(paymentPayload) {
          settlements.push(paymentPayload)
          return { success: true, transaction: reference, network: 'eip155:8453' }
        },
      },
    },
  })
  const server = Mppx.create({ methods: [method], realm, secretKey })
  server.onPaymentSuccess(({ payer }) => void payers.push(payer))
  const request = new Request('https://example.test/paid')
  const route = server.charge({ amount: '0.25', scope: 'job' })
  const offered = await route(request)
  if (offered.status !== 402) throw new Error()
  const challenge = await server.challenge.evm.charge({
    amount: '0.25',
    scope: 'job',
    expires: Challenge.fromResponse(offered.challenge).expires,
  })
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
  const routeOptions = { realm, request: { amount: '0.25' }, scope: 'job' }
  async function credential() {
    const serialized = await prepared.createCredential()
    if (protocol === 'mpp') return Credential.deserialize(serialized)
    const paidRequest = new Request(request, {
      headers: { [Types.paymentSignatureHeader]: serialized },
    })
    const transport = method.transport!
    return transport.bindCredential!({
      challenge,
      credential: transport.getCredential(paidRequest)!,
      input: paidRequest,
    })
  }
  return { credential, payers, prepared, protocol, routeOptions, server, settlements, state }
}

describe.each(['mpp', 'x402'] as const)('EVM validation lifecycle (%s)', (protocol) => {
  test('validates without settlement and broadcasts once', async () => {
    const context = await fixture(protocol)
    expect(context.state.verifications).toBe(0)
    expect(context.settlements).toEqual([])
    const credential = await context.credential()
    const first = await context.server.validateCredential(credential, context.routeOptions)
    const second = await context.server.validateCredential(credential, context.routeOptions)
    expect(first.source).toBe(`did:pkh:eip155:8453:${account.address}`)
    expect(second.request.amount).toBe('250000')
    expect(context.state.verifications).toBe(2)
    expect(context.settlements).toEqual([])

    const receipt = await context.server.broadcastCredential(credential, context.routeOptions)
    expect(receipt.reference).toBe(reference)
    expect(context.state.verifications).toBe(3)
    expect(context.settlements).toHaveLength(1)
    expect(context.settlements[0]?.payload).toMatchObject({
      authorization: { from: account.address, to: recipient, value: '250000' },
    })
  })

  test('rechecks facilitator approval at broadcast time', async () => {
    const context = await fixture(protocol)
    const credential = await context.credential()
    await context.server.validateCredential(credential, context.routeOptions)
    context.state.valid = false
    await expect(
      context.server.broadcastCredential(credential, context.routeOptions),
    ).rejects.toThrow('Authorization is no longer spendable')
    expect(context.state.verifications).toBe(2)
    expect(context.settlements).toEqual([])
  })

  test('exposes the recovered payer on payment success', async () => {
    const context = await fixture(protocol)
    const header = protocol === 'mpp' ? 'Authorization' : Types.paymentSignatureHeader
    const paid = await context.server.charge({ amount: '0.25', scope: 'job' })(
      new Request('https://example.test/paid', {
        headers: { [header]: await context.prepared.createCredential() },
      }),
    )
    expect(paid.status).toBe(200)
    await context.server.broadcastCredential(await context.credential(), context.routeOptions)

    expect(context.payers).toEqual(Array(4).fill(account.address))
  })
})
