import type * as RemoteFeePayer from '../../../tempo/internal/remote-fee-payer.js'
import type { StripeClient } from '../../internal/types.js'

const stripeFeepayerHost = 'mpp.stripe.com'
const stripeFeepayerPath = '/tempo/feepayer'
const url = `https://${stripeFeepayerHost}${stripeFeepayerPath}`

type JsonRpcRequest = Record<string, unknown> & { id?: unknown }

/**
 * Creates an instance of a Stripe feepayer using an authenticated Stripe client.
 *
 * This compatibility path uses the Stripe client so that requests to the feepayer
 * retain their authentication, timeouts, telemetry, and request events.
 */
export function create(client: StripeClient): RemoteFeePayer.Config {
  const requestSender = client._requestSender
  if (!requestSender?._request)
    throw new Error('Stripe hosted fee payer requires a compatible Stripe Node SDK client.')
  return { fetch: createFetch(requestSender), url }
}

function createFetch(
  requestSender: NonNullable<StripeClient['_requestSender']>,
): typeof globalThis.fetch {
  return async (_url, request) => {
    // Remote fee-payer requests must be JSON-RPC POST requests.
    if (request?.method !== 'POST' || typeof request.body !== 'string')
      throw new Error('Stripe hosted fee payer requires a JSON POST request.')

    const body = JSON.parse(request.body) as JsonRpcRequest

    try {
      // Make the request to the feepayer through the Stripe client so that we can reuse auth and telemetry.
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        requestSender._request(
          'POST',
          stripeFeepayerHost,
          stripeFeepayerPath,
          body,
          null,
          {
            headers: { 'Content-Type': 'application/json' },
            settings: { maxNetworkRetries: 0 },
            streaming: true,
          },
          ['mpp_feepayer'],
          (error: unknown, response: unknown) =>
            error ? reject(error) : resolve(response as NodeJS.ReadableStream),
          (_method: string, data: unknown, _headers: unknown, callback: Function) =>
            callback(null, JSON.stringify(data)),
        )
      })

      return new Response(stream as unknown as BodyInit, {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    } catch (error) {
      // Convert Stripe transport failure into the JSON-RPC shape viem expects.
      const stripeError = error as {
        code?: unknown
        message?: unknown
        statusCode?: unknown
      }
      return Response.json(
        {
          error: {
            code: typeof stripeError.code === 'number' ? stripeError.code : -32603,
            message:
              typeof stripeError.message === 'string'
                ? stripeError.message
                : 'Stripe fee-payer request failed',
          },
          id: body.id ?? null,
          jsonrpc: '2.0',
        },
        {
          status: typeof stripeError.statusCode === 'number' ? stripeError.statusCode : 502,
        },
      )
    }
  }
}
