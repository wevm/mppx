import { Challenge, Credential, Receipt } from 'mpay'
import { Mpay as Mpay_client, stripe as stripe_client } from 'mpay/client'
import { Mpay as Mpay_server, stripe as stripe_server } from 'mpay/server'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'

const stripeSecretKey = process.env.VITE_STRIPE_SECRET_KEY

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

let httpServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => httpServer?.close())

async function createTestSpt(parameters: {
  paymentMethod: string
  amount: string
  currency: string
  networkId: string | undefined
  expiresAt: number
}) {
  const body = new URLSearchParams({
    payment_method: parameters.paymentMethod,
    'usage_limits[currency]': parameters.currency,
    'usage_limits[max_amount]': parameters.amount,
    'usage_limits[expires_at]': parameters.expiresAt.toString(),
  })
  const response = await fetch(
    'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${stripeSecretKey!}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  )
  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } }
    throw new Error(`Failed to create SPT: ${error.error.message}`)
  }
  const { id } = (await response.json()) as { id: string }
  return id
}

describe.skipIf(!stripeSecretKey)('stripe', () => {
  const server = Mpay_server.create({
    methods: [stripe_server.charge({ secretKey: stripeSecretKey!, networkId: 'profile_test' })],
    realm,
    secretKey,
  })

  const clientCharge = stripe_client.charge({
    createSpt: createTestSpt,
    paymentMethod: 'pm_card_visa',
  })

  describe('intent: charge; type: spt', () => {
    test('default', async () => {
      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [clientCharge],
      })
      expect(challenge.method).toBe('stripe')
      expect(challenge.intent).toBe('charge')
      expect(challenge.request.amount).toBe('100')
      expect(challenge.realm).toBe(realm)

      const credential = await clientCharge.createCredential({ challenge, context: {} })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect({
          ...receipt,
          reference: '[reference]',
          timestamp: '[timestamp]',
        }).toMatchInlineSnapshot(`
          {
            "method": "stripe",
            "reference": "[reference]",
            "status": "success",
            "timestamp": "[timestamp]",
          }
        `)
      }
    })

    test('behavior: rejects invalid SPT', async () => {
      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      const challenge = Challenge.fromResponse(response)

      const credential = Credential.from({
        challenge,
        payload: { spt: 'spt_invalid_token' },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Stripe PaymentIntent failed')
      }
    })

    test('behavior: rejects expired challenge', async () => {
      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: 'usd',
            decimals: 2,
            expires: new Date(Date.now() - 1000).toISOString(),
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response)

      const credential = Credential.from({
        challenge,
        payload: { spt: 'spt_does_not_matter' },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toMatch(/^Payment expired at /)
      }
    })

    test('behavior: rejects malformed credential payload (missing spt)', async () => {
      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      const challenge = Challenge.fromResponse(response)

      const credential = Credential.from({
        challenge,
        payload: {},
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
      }
    })

    test('behavior: receipt format stability', async () => {
      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      const challenge = Challenge.fromResponse(response, {
        methods: [clientCharge],
      })

      const credential = await clientCharge.createCredential({ challenge, context: {} })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect(receipt.status).toBe('success')
        expect(receipt.method).toBe('stripe')
        expect(receipt.reference).toMatch(/^pi_/)
        expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      }
    })
  })

  describe('intent: charge; type: spt; via Mpay', () => {
    test('default', async () => {
      const mpay = Mpay_client.create({
        polyfill: false,
        methods: [clientCharge],
      })

      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mpay.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect({
          ...receipt,
          reference: '[reference]',
          timestamp: '[timestamp]',
        }).toMatchInlineSnapshot(`
          {
            "method": "stripe",
            "reference": "[reference]",
            "status": "success",
            "timestamp": "[timestamp]",
          }
        `)
      }
    })

    test('behavior: full mpay.fetch() auto flow', async () => {
      const mpay = Mpay_client.create({
        polyfill: false,
        methods: [clientCharge],
      })

      httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mpay.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')
      expect(receipt.method).toBe('stripe')
      expect(receipt.reference).toMatch(/^pi_/)
    })
  })
})
