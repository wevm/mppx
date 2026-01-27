import { describe, expect, test } from 'vitest'
import { rpcUrl } from '~test/tempo/prool.js'
import { accounts, chain } from '~test/tempo/viem.js'
import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as Method from '../Method.js'
import * as Methods from '../tempo/client/Method.js'
import * as Intents from '../tempo/Intents.js'
import * as Mpay from './Mpay.js'
import * as Transport from './Transport.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const tempo = Methods.tempo({
  account: accounts[1],
  chainId: chain.id,
  rpcUrl,
})

describe('Mpay.create', () => {
  test('default', () => {
    const mpay = Mpay.create({ methods: [tempo] })

    expect(mpay.methods).toHaveLength(1)
    expect(mpay.methods[0]?.name).toBe('tempo')
    expect(mpay.transport.name).toBe('http')
    expect(typeof mpay.createCredential).toBe('function')
  })

  test('behavior: with mcp transport', () => {
    const mpay = Mpay.create({ methods: [tempo], transport: Transport.mcp() })

    expect(mpay.transport.name).toBe('mcp')
  })

  test('behavior: with multiple methods', () => {
    const stripeBase = Method.from({
      name: 'stripe',
      intents: { charge: Intents.charge },
    })
    const stripeMethod = Method.toClient(stripeBase, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mpay = Mpay.create({ methods: [tempo, stripeMethod] })

    expect(mpay.methods).toHaveLength(2)
    expect(mpay.methods[0]?.name).toBe('tempo')
    expect(mpay.methods[1]?.name).toBe('stripe')
  })
})

describe('createCredential', () => {
  test('behavior: routes to correct method based on challenge', async () => {
    const mpay = Mpay.create({ methods: [tempo] })

    const challenge = Challenge.fromIntent(Intents.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mpay.createCredential(response)

    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })

  test('behavior: throws when method not found', async () => {
    const mpay = Mpay.create({ methods: [tempo] })

    const challenge = Challenge.from({
      id: 'test-id',
      realm,
      method: 'unknown',
      intent: 'charge',
      request: { amount: '1000', currency: '0x1234' },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await expect(mpay.createCredential(response)).rejects.toThrow(
      'No method found for "unknown". Available: tempo',
    )
  })

  test('behavior: routes to correct method with multiple methods', async () => {
    const stripeBase = Method.from({
      name: 'stripe',
      intents: { charge: Intents.charge },
    })

    const stripe = Method.toClient(stripeBase, {
      async createCredential({ challenge }) {
        return Credential.serialize({
          challenge,
          payload: { signature: '0xstripe', type: 'transaction' },
        })
      },
    })

    const mpay = Mpay.create({ methods: [tempo, stripe] })

    const stripeChallenge = Challenge.from({
      id: 'stripe-challenge-id',
      realm,
      method: 'stripe',
      intent: 'charge',
      request: {
        amount: '2000',
        currency: '0xabcd',
        recipient: '0xefgh',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(stripeChallenge),
      },
    })

    const credential = await mpay.createCredential(response)
    const parsed = Credential.deserialize(credential)

    expect(parsed.payload).toEqual({ signature: '0xstripe', type: 'transaction' })
    expect(parsed.challenge.method).toBe('stripe')
  })

  test('behavior: passes context to createCredential', async () => {
    const method = Methods.tempo({
      chainId: chain.id,
      rpcUrl,
    })

    const mpay = Mpay.create({ methods: [method] })

    const challenge = Challenge.fromIntent(Intents.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mpay.createCredential(response, { account: accounts[1] })

    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.source).toContain(accounts[1].address)
  })

  test('behavior: works without context when account provided at creation', async () => {
    const mpay = Mpay.create({ methods: [tempo] })

    const challenge = Challenge.fromIntent(Intents.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    const credential = await mpay.createCredential(response)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
  })

  test('behavior: with mcp transport', async () => {
    const mpay = Mpay.create({ methods: [tempo], transport: Transport.mcp() })

    const challenge = Challenge.fromIntent(Intents.charge, {
      realm,
      secretKey,
      request: {
        amount: '1000',
        currency: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    const mcpResponse: Mcp.Response = {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: Mcp.paymentRequiredCode,
        message: 'Payment Required',
        data: {
          httpStatus: 402,
          challenges: [challenge],
        },
      },
    }

    const credential = await mpay.createCredential(mcpResponse)
    const parsed = Credential.deserialize(credential)
    expect((parsed.payload as { type: string }).type).toBe('transaction')
    expect(parsed.challenge.method).toBe('tempo')
  })
})
