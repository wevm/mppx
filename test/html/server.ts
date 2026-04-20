import * as http from 'node:http'

import { Mppx, Request as ServerRequest, Store, stripe, tempo } from 'mppx/server'
import { createClient, http as createHttpTransport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, Actions } from 'viem/tempo'

import { stripePreviewVersion } from '../../src/stripe/internal/constants.js'

export async function startServer(port: number): Promise<HtmlTestServer> {
  const stripePublishableKey = process.env.VITE_STRIPE_PUBLIC_KEY
  const stripeSecretKey = process.env.VITE_STRIPE_SECRET_KEY
  const stripeEnabled = Boolean(stripePublishableKey) && Boolean(stripeSecretKey)

  const account = privateKeyToAccount(generatePrivateKey())
  const client = createClient({
    chain: tempoModerato,
    pollingInterval: 1_000,
    transport: createHttpTransport(),
  })
  for (let attempt = 1; ; attempt++)
    try {
      await Actions.faucet.fundSync(client, { account })
      break
    } catch (error) {
      if (attempt >= 3) throw error
    }

  const createTokenUrl = '/stripe/create-spt'
  const subscriptionAccessKey = Account.fromP256(generatePrivateKey())
  const subscriptionExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()
  const subscriptionStore = Store.memory()
  const tempoMppx = Mppx.create({
    methods: [
      tempo.charge({
        account,
        currency: '0x20c0000000000000000000000000000000000000',
        feePayer: true,
        html: true,
        recipient: account.address,
        testnet: true,
      }),
      tempo.subscription({
        activate: async ({ request, resolved }) => ({
          receipt: {
            method: 'tempo',
            reference: '0xsubscription',
            status: 'success',
            subscriptionId: 'sub_pro',
            timestamp: new Date().toISOString(),
          },
          subscription: {
            amount: request.amount,
            billingAnchor: new Date().toISOString(),
            chainId: request.methodDetails?.chainId,
            currency: request.currency,
            lastChargedPeriod: 0,
            lookupKey: resolved.key,
            periodSeconds: request.periodSeconds,
            recipient: request.recipient,
            reference: '0xsubscription',
            subscriptionExpires: request.subscriptionExpires,
            subscriptionId: 'sub_pro',
            timestamp: new Date().toISOString(),
          },
        }),
        amount: '1',
        chainId: tempoModerato.id,
        currency: '0x20c0000000000000000000000000000000000000',
        html: {
          accessKey: {
            accessKeyAddress: subscriptionAccessKey.address,
            keyType: subscriptionAccessKey.keyType,
          },
        },
        periodSeconds: '2592000',
        recipient: account.address,
        resolve: async () => ({ key: 'user-1:plan:pro' }),
        store: subscriptionStore,
        subscriptionExpires,
        testnet: true,
      }),
    ],
    secretKey: 'test-html-server-secret-key',
  })
  const tempoCustomTextMppx = Mppx.create({
    methods: [
      tempo.charge({
        account,
        currency: '0x20c0000000000000000000000000000000000000',
        feePayer: true,
        html: { text: { pay: 'Buy Now' } },
        recipient: account.address,
        testnet: true,
      }),
    ],
    secretKey: 'test-html-server-secret-key',
  })
  const stripeMppx = stripeEnabled
    ? Mppx.create({
        methods: [
          tempo.charge({
            account,
            currency: '0x20c0000000000000000000000000000000000000',
            feePayer: true,
            html: true,
            recipient: account.address,
            testnet: true,
          }),
          stripe.charge({
            html: {
              createTokenUrl,
              publishableKey: stripePublishableKey!,
            },
            networkId: 'internal',
            paymentMethodTypes: ['card'],
            secretKey: stripeSecretKey!,
          }),
        ],
        secretKey: 'test-html-server-secret-key',
      })
    : undefined

  const server = http.createServer(
    ServerRequest.toNodeListener(async (request) => {
      const url = new URL(request.url)

      if (url.pathname === '/tempo/charge') {
        const result = await tempoMppx.tempo.charge({
          amount: '0.01',
          description: 'Random stock photo',
        })(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ url: 'https://example.com/photo.jpg' }))
      }

      if (url.pathname === '/tempo/charge-custom-text') {
        const result = await tempoCustomTextMppx.tempo.charge({
          amount: '0.01',
          description: 'Random stock photo',
        })(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ url: 'https://example.com/photo.jpg' }))
      }

      if (url.pathname === '/tempo/subscription') {
        const result = await tempoMppx.tempo.subscription({
          description: 'Tempo Pro',
          externalId: 'plan_pro',
        })(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ plan: 'pro' }))
      }

      if (url.pathname === '/stripe/charge') {
        if (!stripeMppx) return new Response('Not Found', { status: 404 })

        const result = await stripeMppx.stripe.charge({
          amount: '1',
          currency: 'usd',
          decimals: 2,
        })(request)

        if (result.status === 402) return result.challenge

        const fortunes = [
          'A beautiful, smart, and loving person will come into your life.',
          'A dubious friend may be an enemy in camouflage.',
          'A faithful friend is a strong defense.',
          'A fresh start will put you on your way.',
          'A golden egg of opportunity falls into your lap this month.',
          'A good time to finish up old tasks.',
          'A hunch is creativity trying to tell you something.',
          'A lifetime of happiness lies ahead of you.',
          'A light heart carries you through all the hard times.',
          'A new perspective will come with the new year.',
        ] as const

        const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]
        return result.withReceipt(Response.json({ fortune }))
      }

      if (url.pathname === createTokenUrl) {
        if (!stripeMppx) return new Response('Not Found', { status: 404 })
        return createSharedPaymentToken(request, stripeSecretKey!)
      }

      if (url.pathname === '/compose') {
        if (!stripeMppx) return new Response('Not Found', { status: 404 })

        const result = await stripeMppx.compose(
          ['tempo/charge', { amount: '0.01', description: 'Composed payment' }],
          ['stripe/charge', { amount: '1', currency: 'usd', decimals: 2 }],
        )(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ ok: true }))
      }

      if (url.pathname === '/compose-duplicates') {
        if (!stripeMppx) return new Response('Not Found', { status: 404 })

        const result = await stripeMppx.compose(
          ['tempo/charge', { amount: '0.01', description: 'Composed payment' }],
          ['stripe/charge', { amount: '1', currency: 'usd', decimals: 2 }],
          ['stripe/charge', { amount: '2', currency: 'usd', decimals: 2 }],
        )(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ ok: true }))
      }

      return new Response('Not Found', { status: 404 })
    }),
  )

  await new Promise<void>((resolve) => server.listen(port, resolve))

  return Object.assign(server, {
    port,
    url: `http://localhost:${port}`,
  }) as HtmlTestServer
}

type HtmlTestServer = http.Server<typeof http.IncomingMessage, typeof http.ServerResponse> & {
  port: number
  url: string
}

async function createSharedPaymentToken(request: Request, secretKey: string): Promise<Response> {
  const { paymentMethod, amount, currency, expiresAt, networkId, metadata } =
    (await request.json()) as {
      paymentMethod: string
      amount: string
      currency: string
      expiresAt: number
      networkId?: string
      metadata?: Record<string, string>
    }

  if (metadata?.externalId)
    return Response.json(
      { error: 'metadata.externalId is reserved; use credential externalId instead' },
      { status: 400 },
    )

  const body = new URLSearchParams({
    payment_method: paymentMethod,
    'usage_limits[currency]': currency,
    'usage_limits[max_amount]': amount,
    'usage_limits[expires_at]': expiresAt.toString(),
  })
  if (networkId) body.set('seller_details[network_id]', networkId)
  if (metadata)
    for (const [key, value] of Object.entries(metadata)) body.set(`metadata[${key}]`, value)

  // Test-only endpoint; production SPT flow uses the agent-side issued_tokens API.
  const createSpt = async (bodyParams: URLSearchParams) =>
    fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${secretKey}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': stripePreviewVersion,
      },
      body: bodyParams,
    })

  let response = await createSpt(body)
  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } }
    if ((metadata || networkId) && error.error.message.includes('Received unknown parameter')) {
      const fallbackBody = new URLSearchParams({
        payment_method: paymentMethod,
        'usage_limits[currency]': currency,
        'usage_limits[max_amount]': amount,
        'usage_limits[expires_at]': expiresAt.toString(),
      })
      response = await createSpt(fallbackBody)
    } else return Response.json({ error: error.error.message }, { status: 500 })
  }

  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } }
    return Response.json({ error: error.error.message }, { status: 500 })
  }

  const { id: spt } = (await response.json()) as { id: string }
  return Response.json({ spt })
}
