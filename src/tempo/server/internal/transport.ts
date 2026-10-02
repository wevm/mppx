/**
 * Tempo-specific SSE transport that wraps the base HTTP transport
 * with metering logic (context capture from verified credentials, per-token
 * charging via Sse.serve).
 *
 * @internal
 */
import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Errors from '../../../Errors.js'
import * as Transport from '../../../server/Transport.js'
import type { SessionReceipt } from '../../session/precompile/Protocol.js'
import { requireSessionCredentialContext } from '../../session/precompile/Protocol.js'
import * as ChannelStore from '../../session/server/ChannelStore.js'
import type { SettleChargedSessionChannel } from '../../session/server/Settlement.js'
import * as Sse_core from '../../session/server/Sse.js'
import * as SessionTransports from '../../session/server/Transports.js'
import { captureRequestBodyProbe, shouldChargePlainResponse } from './request-body.js'

const prepaidSessionTick = Symbol('mppx.prepaidSessionTick')
const reservedSessionTick = Symbol('mppx.reservedSessionTick')

/** SSE transport with Tempo session controller. */
export type Sse = Transport.Transport<
  Request,
  Response,
  Transport.ReceiptResponseOf<Transport.Sse<Sse_core.SessionController>>,
  Response | Promise<Response>
>

/** Receipt marker used to avoid double-charging a request already charged during verification. */
export type PrepaidSessionReceipt = SessionReceipt & {
  [prepaidSessionTick]?: true | undefined
  [reservedSessionTick]?: string | undefined
}

/** Marks a session receipt as already charged for the current request. */
export function markPrepaidSessionTick(receipt: SessionReceipt): SessionReceipt {
  Object.defineProperty(receipt, prepaidSessionTick, {
    configurable: false,
    enumerable: false,
    value: true,
  })
  return receipt
}

function hasPrepaidSessionTick(receipt: SessionReceipt): boolean {
  return (receipt as PrepaidSessionReceipt)[prepaidSessionTick] === true
}

function getReservedSessionTick(receipt: SessionReceipt): string | undefined {
  return (receipt as PrepaidSessionReceipt)[reservedSessionTick]
}

/** Reserves one response unit before a protected session handler runs. */
export async function reserveSessionTick(
  store: ChannelStore.ChannelStore,
  receipt: SessionReceipt,
  amount: bigint,
): Promise<SessionReceipt> {
  const reservationId = globalThis.crypto.randomUUID()
  const result = await SessionTransports.reserveCharge({
    amount,
    channelId: receipt.channelId,
    reservationId,
    store,
  })
  if (!result.ok) {
    SessionTransports.throwIfChannelClosed(result.channel)
    const available =
      result.channel.highestVoucherAmount -
      result.channel.spent -
      ChannelStore.reservedStreamAmount(result.channel)
    throw new Errors.InsufficientBalanceError({
      reason: `requested ${amount}, available ${available}`,
    })
  }
  Object.defineProperty(receipt, reservedSessionTick, {
    configurable: true,
    enumerable: false,
    value: reservationId,
  })
  return receipt
}

/** Releases a response-unit reservation when a protected handler fails. */
export async function releaseSessionTick(
  store: ChannelStore.ChannelStore,
  receipt: SessionReceipt,
): Promise<void> {
  const reservationId = getReservedSessionTick(receipt)
  if (!reservationId) return
  await SessionTransports.releaseReservedCharges({
    store,
    channelId: receipt.channelId,
    reservationId,
  })
  delete (receipt as PrepaidSessionReceipt)[reservedSessionTick]
}

/** Keeps a response-unit reservation alive until its receipt is emitted or cancelled. */
export function maintainSessionTick(
  store: ChannelStore.ChannelStore,
  receipt: SessionReceipt,
): (() => void) | undefined {
  const reservationId = getReservedSessionTick(receipt)
  if (!reservationId) return undefined
  return SessionTransports.maintainReservedCharges({
    store,
    channelId: receipt.channelId,
    reservationId,
  })
}

/**
 * Creates a Tempo-metered SSE transport.
 *
 * Wraps an HTTP transport with:
 * - Context capture from credentials (channelId, tickCost)
 * - Per-token charging via Sse.serve for generator/iterable responses
 * - Auto-detection of upstream SSE responses
 * - Fallback to standard HTTP receipt handling for plain Response
 */
export function sse(
  options: sse.Options & {
    settleCharged?: SettleChargedSessionChannel | undefined
    store: ChannelStore.ChannelStore
  },
): Sse {
  const { pollingInterval, poll } = options

  // When `poll` is true, strip `waitForUpdate` so the SSE charge loop
  // falls back to polling. This is needed for runtimes like Cloudflare Workers
  // where resolving promises across request contexts is not supported.
  const store = (() => {
    if (!poll) return options.store
    const { waitForUpdate: _, ...store } = options.store
    return store
  })()

  const base = Transport.http()
  return Transport.from<
    Request,
    Response,
    Transport.ReceiptResponseOf<Sse>,
    Response | Promise<Response>
  >({
    name: 'sse',

    captureRequest(request) {
      return (
        base.captureRequest?.(request) ?? {
          headers: new Headers(request.headers),
          hasBody: request.body !== null,
          method: request.method,
          url: new URL(request.url),
        }
      )
    },

    getCredential(request) {
      return base.getCredential(request)
    },

    respondChallenge(options) {
      return base.respondChallenge(options) as Response
    },

    cancelReceipt({ receipt }) {
      return releaseSessionTick(store, receipt as SessionReceipt)
    },

    maintainReceipt({ receipt }) {
      return maintainSessionTick(store, receipt as SessionReceipt)
    },

    respondReceipt({ credential, envelope, receipt, response, challengeId, input, signal }) {
      const verifiedCredential = envelope?.credential ?? credential
      const verifiedChallengeId = envelope?.challenge.id ?? challengeId
      const verifiedRequest = envelope?.request ?? verifiedCredential.challenge.request
      const payload = requireSessionCredentialContext(
        verifiedCredential.payload,
        'No SSE context available',
      )
      const channelId = payload.channelId
      const tickCost = BigInt(verifiedCredential.challenge.request.amount as string)
      const unitType =
        typeof verifiedRequest.unitType === 'string' ? verifiedRequest.unitType : undefined
      const reservedTick = getReservedSessionTick(receipt as SessionReceipt)
      const settleCharged = options.settleCharged
      const settleCommittedCharge = settleCharged
        ? async (channel: ChannelStore.State) => {
            try {
              await settleCharged(channel)
            } catch {
              // The response is already paid; settlement can be retried independently.
            }
          }
        : undefined

      // Auto-detect upstream SSE responses and parse them into an
      // AsyncIterable so they flow through the metered pipeline.
      // This lets proxy consumers simply pass `result.withReceipt(upstreamRes)`
      // and get per-event charging automatically.
      const resolved =
        response instanceof Response && Sse_core.isEventStream(response) && response.body
          ? Sse_core.iterateData(response, { skip: (d) => d === '[DONE]' })
          : response

      if (isAsyncGeneratorFunction(resolved) || isAsyncIterable(resolved)) {
        // Pass async generator functions directly so Sse.serve gives them
        // a SessionController for manual charge(). Pass raw AsyncIterables
        // as-is so Sse.serve auto-charges per yielded value.
        const generate = resolveMeteredGenerate(resolved, unitType)
        const stream = Sse_core.serve({
          store,
          channelId,
          challengeId: verifiedChallengeId,
          tickCost,
          pollIntervalMs: pollingInterval,
          generate,
          onChargeCommitted: settleCommittedCharge,
          prepaidUnits: hasPrepaidSessionTick(receipt as SessionReceipt) ? 1 : 0,
          ...(reservedTick ? { reservationId: reservedTick, reservedUnits: 1 } : {}),
          signal: input.signal,
        })
        return Sse_core.toResponse(stream)
      }

      const baseResponse = base.respondReceipt({
        credential: verifiedCredential,
        envelope,
        input,
        receipt,
        response: response as Response,
        challengeId: verifiedChallengeId,
      })

      const request = envelope?.capturedRequest ?? captureRequestBodyProbe(input)
      if (!shouldChargePlainResponse(request, payload)) {
        return baseResponse
      }

      const currentReceipt = receipt as SessionReceipt
      if (hasPrepaidSessionTick(currentReceipt)) {
        return baseResponse
      }
      const insufficientResponse = (available: bigint) => {
        const error = new Errors.InsufficientBalanceError({
          reason: `requested ${tickCost}, available ${available}`,
        })
        return new Response(
          JSON.stringify(error.toProblemDetails(verifiedCredential.challenge.id)),
          {
            status: error.status,
            headers: {
              [Constants.Headers.wwwAuthenticate]: Challenge.serialize(
                verifiedCredential.challenge,
              ),
              'Cache-Control': 'no-store',
              'Content-Type': 'application/problem+json',
            },
          },
        )
      }
      const available = BigInt(currentReceipt.acceptedCumulative) - BigInt(currentReceipt.spent)
      if (!reservedTick && available < tickCost) return insufficientResponse(available)

      const chargePlainResponse = async () => {
        if (reservedTick) {
          await SessionTransports.commitReservedCharges({
            store,
            channelId,
            reservationId: reservedTick,
            signal,
          })
          const channel = await store.getChannel(channelId)
          if (!channel) throw new Error('channel not found')
          return { channel, ok: true } as const
        }
        const result = await ChannelStore.deductFromChannel(store, channelId, tickCost)
        if (result.ok) void settleCommittedCharge?.(result.channel)
        return result
      }

      // Non-SSE response (e.g. upstream returned JSON instead of event-stream).
      // Complete the deduction before exposing success headers or content.
      return chargePlainResponse().then((result) => {
        if (!result.ok)
          return insufficientResponse(
            result.channel.highestVoucherAmount -
              result.channel.spent -
              ChannelStore.reservedStreamAmount(result.channel),
          )

        const chargedReceipt: SessionReceipt = {
          ...currentReceipt,
          acceptedCumulative: result.channel.highestVoucherAmount.toString(),
          spent: result.channel.spent.toString(),
          units: result.channel.units,
        }
        const paidResponse = base.respondReceipt({
          credential: verifiedCredential,
          envelope,
          input,
          receipt: chargedReceipt,
          response: response as Response,
          challengeId: verifiedChallengeId,
        })
        if (reservedTick) {
          const timer = setTimeout(() => {
            void SessionTransports.finalizeCommittedCharges({
              store,
              channelId,
              reservationId: reservedTick,
            })
              .then((channel) => settleCommittedCharge?.(channel))
              .catch(() => undefined)
          }, 0)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        }
        return paidResponse
      })
    },
  })
}

/** Type helpers for the Tempo SSE transport adapter. */
export declare namespace sse {
  type Options = {
    /**
     * When true, the charge loop uses polling instead of `waitForUpdate()`.
     *
     * Required for runtimes like Cloudflare Workers where resolving promises
     * across request contexts is not supported. Without this flag, a mid-stream
     * voucher POST (Request B) would resolve a waiter created in the streaming
     * request context (Request A), causing a Workers error.
     *
     * @default false
     */
    poll?: boolean | undefined
    /** Polling interval (in milliseconds). @default 10 */
    pollingInterval?: number | undefined
  }
}

type DefaultServeGenerate = AsyncIterable<string> | (() => AsyncIterable<string>)

/** Default SSE serve: iterates values and emits `event: message` per value. */
export function defaultServe(options: {
  generate: DefaultServeGenerate
  challengeId: string
}): Response {
  const iterable = typeof options.generate === 'function' ? options.generate() : options.generate
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const value of iterable) {
          controller.enqueue(encoder.encode(Sse_core.formatMessageEvent(value)))
        }
      } catch (e) {
        controller.error(e)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

function isAsyncGeneratorFunction(
  value: unknown,
): value is (...args: unknown[]) => AsyncIterable<string> {
  if (typeof value !== 'function') return false
  return value.constructor?.name === 'AsyncGeneratorFunction'
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in (value as object)
}

function resolveMeteredGenerate(
  value: AsyncIterable<string> | ((...args: unknown[]) => AsyncIterable<string>),
  unitType: string | undefined,
): Sse_core.serve.Options['generate'] {
  if (isAsyncGeneratorFunction(value)) return value as Sse_core.serve.Options['generate']
  if (unitType !== 'request') return value as AsyncIterable<string>

  const iterable = value as AsyncIterable<string>
  return async function* chargeOnce(stream) {
    let charged = false
    for await (const chunk of iterable) {
      if (!charged) {
        await stream.charge()
        charged = true
      }
      yield chunk
    }
  }
}
