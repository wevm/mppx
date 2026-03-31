import * as http from 'node:http'

import { Mppx, Request as ServerRequest, stripe, tempo } from 'mppx/server'
import { createClient, http as createHttpTransport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

export async function startServer(port: number): Promise<HtmlTestServer> {
  const stripePublishableKey = process.env.VITE_STRIPE_PUBLIC_KEY
  if (!stripePublishableKey) throw new Error('Missing VITE_STRIPE_PUBLIC_KEY')
  const stripeSecretKey = process.env.VITE_STRIPE_SECRET_KEY
  if (!stripeSecretKey) throw new Error('Missing VITE_STRIPE_SECRET_KEY')

  const createTokenUrl = '/stripe/create-spt'
  const stripeMppx = Mppx.create({
    methods: [
      stripe.charge({
        html: {
          createTokenUrl,
          publishableKey: stripePublishableKey,
        },
        networkId: 'internal',
        paymentMethodTypes: ['card'],
        secretKey: stripeSecretKey,
      }),
    ],
    secretKey: 'test-html-server-secret-key',
  })
  let tempoChargePromise: Promise<(request: Request) => Promise<any>> | undefined

  async function getTempoCharge() {
    if (!tempoChargePromise) {
      tempoChargePromise = (async () => {
        const account = privateKeyToAccount(generatePrivateKey())
        const tempoClient = createClient({
          chain: tempoModerato,
          pollingInterval: 1_000,
          transport: createHttpTransport(process.env.MPPX_RPC_URL),
        })

        for (let attempt = 1; ; attempt++) {
          try {
            await Actions.faucet.fundSync(tempoClient, { account })
            break
          } catch (error) {
            if (attempt >= 3) throw error
          }
        }

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
          ],
          secretKey: 'test-html-server-secret-key',
        })

        return tempoMppx.tempo.charge({
          amount: '0.01',
          description: 'Random stock photo',
        })
      })()
    }

    return await tempoChargePromise
  }

  const server = http.createServer(
    ServerRequest.toNodeListener(async (request) => {
      const url = new URL(request.url)

      if (url.pathname === '/tempo/charge') {
        const tempoCharge = await getTempoCharge()
        const result = await tempoCharge(request)

        if (result.status === 402) return result.challenge

        return result.withReceipt(Response.json({ url: 'https://example.com/photo.jpg' }))
      }

      if (url.pathname === createTokenUrl) return createSharedPaymentToken(request, stripeSecretKey)

      if (url.pathname === '/stripe/charge') {
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
