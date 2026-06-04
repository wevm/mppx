import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import {
  createSessionReceipt,
  deserializeSessionReceipt,
  formatApplicationMessage,
  formatAuthorizationMessage,
  formatCloseReadyMessage,
  formatCloseRequestMessage,
  formatErrorMessage,
  formatNeedVoucherMessage,
  formatReceiptMessage,
  parseMessage,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
  type ErrorMessageParameters,
  type Message,
  type SessionCredentialContext,
  type SessionReceipt,
} from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import type { SessionController } from './MeteredStream.js'
export type { SessionController } from './MeteredStream.js'
export type { Socket } from './Transports.js'
import { meterIterable } from './MeteredStream.js'
import { send, subscribe, toText, type Socket } from './Transports.js'

/** Public WebSocket payment frame helpers. */
export {
  formatApplicationMessage,
  formatAuthorizationMessage,
  formatCloseReadyMessage,
  formatCloseRequestMessage,
  formatErrorMessage,
  formatNeedVoucherMessage,
  formatReceiptMessage,
  parseMessage,
  type ErrorMessageParameters,
  type Message,
} from '../precompile/Protocol.js'

/** Result returned by an HTTP route before upgrading or authorizing a WebSocket session. */
export type SessionRouteResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt(response?: Response): Response }

/** HTTP route used to perform a WebSocket payment probe. */
export type SessionRoute = (request: Request) => Promise<SessionRouteResult>

type StreamContext = {
  challengeId: string
  channelId: SessionCredentialContext['channelId']
  tickCost: bigint
}

/** Result of verifying one in-band authorization frame through the HTTP payment route. */
type AuthorizationResult =
  | {
      status: 'accepted'
      receipt: SessionReceipt
    }
  | {
      status: 'rejected'
      message: string
      responseStatus: number
    }

/** Mutable server-side runtime state for one paid WebSocket connection. */
type ServeRuntime = {
  /** Whether the socket has been closed or externally disconnected. */
  closed: boolean
  /** Whether a final close-ready receipt has already been sent. */
  closeReadySent: boolean
  /** Whether an in-band close request has already been processed. */
  closeRequestHandled: boolean
  /** Whether the client has requested close and no new stream should start. */
  closeRequested: boolean
  /** Whether application streaming has started for this connection. */
  streamStarted: boolean
  /** Active stream task, when application generation is in progress. */
  streamTask: Promise<void> | null
  /** Active payment context for the stream. */
  streamContext: StreamContext | null
  /** Serialized payment-management action queue. */
  action: Promise<void>
  /** Number of queued payment-management messages waiting behind `action`. */
  queuedActions: number
}

/**
 * Bridge a WebSocket connection to a Tempo session payment flow.
 *
 * Credential verification is performed by routing each in-band authorization
 * frame through `route` as a **synthetic `POST` request** that carries only
 * the `Authorization` header. The synthetic request does not include cookies,
 * bodies, query parameters, or other headers from the original WebSocket
 * upgrade request. Do not wrap `route` with middleware that depends on
 * HTTP-specific context beyond the `Authorization` header.
 */
export async function serve(options: serve.Options): Promise<void> {
  const {
    amount: expectedAmount,
    generate,
    pollIntervalMs = 100,
    route,
    socket,
    store: rawStore,
    url,
  } = options
  const store = 'getChannel' in rawStore ? rawStore : ChannelStore.fromStore(rawStore)
  const requestUrl = normalizeHttpUrl(url)
  const maxQueuedPaymentMessages = 32

  const abortController = new AbortController()
  const runtime: ServeRuntime = {
    closed: false,
    closeReadySent: false,
    closeRequestHandled: false,
    closeRequested: false,
    streamStarted: false,
    streamTask: null,
    streamContext: null,
    action: Promise.resolve(),
    queuedActions: 0,
  }

  const close = async (code = 1000, reason?: string) => {
    if (runtime.closed) return
    runtime.closed = true
    abortController.abort()
    unsubscribe()
    await Promise.resolve(socket.close(code, reason))
  }

  const sendCloseReady = async () => {
    if (runtime.closeReadySent || !runtime.streamContext || runtime.closed) return
    runtime.closeReadySent = true

    const channel = await store.getChannel(runtime.streamContext.channelId)
    if (!channel) throw new Error('channel not found')

    const receipt = createSessionReceipt({
      challengeId: runtime.streamContext.challengeId,
      channelId: runtime.streamContext.channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
    await send(socket, formatCloseReadyMessage(receipt))
  }

  const runStream = async (context: StreamContext) => {
    try {
      for await (const value of meterIterable({
        store,
        channelId: context.channelId,
        tickCost: context.tickCost,
        generate,
        pollIntervalMs,
        signal: abortController.signal,
        emitNeedVoucher: (message) => send(socket, message),
        formatNeedVoucher: formatNeedVoucherMessage,
      })) {
        if (abortController.signal.aborted) break
        await send(socket, formatApplicationMessage(value))
      }

      if (!abortController.signal.aborted) await sendCloseReady()
    } catch (error) {
      if (!abortController.signal.aborted) {
        await send(
          socket,
          formatErrorMessage({
            message: error instanceof Error ? error.message : 'websocket session failed',
            status: 500,
          }),
        )
        await close(1011, 'websocket session failed')
      }
    } finally {
      runtime.streamTask = null
    }
  }

  const requestClose = async () => {
    if (runtime.closed) return
    if (runtime.closeRequestHandled) return
    runtime.closeRequestHandled = true
    runtime.closeRequested = true
    abortController.abort()
    await runtime.streamTask?.catch(() => {})
    await sendCloseReady()
  }

  const processAuthorization = async (authorization: string) => {
    if (runtime.closed) return
    const credential = Credential.deserialize(authorization)
    const payload = requireSessionCredentialContext(credential.payload)
    if (payload.action === 'close') runtime.closeRequested = true

    if (expectedAmount && credential.challenge.request.amount !== expectedAmount) {
      await send(
        socket,
        formatErrorMessage({
          message: 'credential amount does not match this endpoint',
          status: 402,
        }),
      )
      await close(1008, 'credential amount does not match this endpoint')
      return
    }

    const authorizationResult = await authorizePaymentFrame({ authorization, requestUrl, route })
    if (authorizationResult.status === 'rejected') {
      await send(
        socket,
        formatErrorMessage({
          message: authorizationResult.message,
          status: authorizationResult.responseStatus,
        }),
      )
      await close(1008, authorizationResult.message)
      return
    }

    const { receipt } = authorizationResult
    await send(socket, formatReceiptMessage(receipt))

    if (payload.action === 'close') {
      await close(1000, 'payment session closed')
      return
    }

    if (payload.action === 'topUp') return
    if (runtime.streamStarted || runtime.closeRequested) return
    runtime.streamStarted = true
    runtime.streamContext = {
      challengeId: credential.challenge.id,
      channelId: payload.channelId,
      tickCost: readSessionChallengeAmount(credential.challenge),
    }
    // Defer the first application frame until after the client receives the
    // auth receipt and has a chance to install its own message listeners.
    setTimeout(() => {
      if (runtime.closeRequested || runtime.closed || !runtime.streamContext) return
      runtime.streamTask = runStream(runtime.streamContext)
    }, 0)
  }

  const onMessage = (payload: unknown) => {
    if (runtime.closed) return
    const raw = toText(payload)
    if (!raw) return
    const message = parseMessage(raw)
    if (!message) return

    if (message.mpp === 'payment-close-request') {
      runtime.closeRequested = true
      abortController.abort()
    }

    const work =
      message.mpp === 'authorization'
        ? () => processAuthorization(message.authorization)
        : message.mpp === 'payment-close-request'
          ? () => requestClose()
          : null

    if (!work) return
    if (runtime.queuedActions >= maxQueuedPaymentMessages) {
      void send(
        socket,
        formatErrorMessage({
          message: 'too many queued payment messages',
          status: 429,
        }),
      ).catch(() => {})
      void close(1008, 'too many queued payment messages')
      return
    }

    runtime.queuedActions++
    runtime.action = runtime.action
      .then(async () => {
        try {
          if (runtime.closed) return
          await work()
        } finally {
          runtime.queuedActions--
        }
      })
      .catch(async (error) => {
        if (!runtime.closed) {
          await send(
            socket,
            formatErrorMessage({
              message: error instanceof Error ? error.message : 'invalid payment message',
              status: 400,
            }),
          )
          await close(1008, 'invalid payment message')
        }
      })
  }

  const onClose = () => {
    if (runtime.closed) return
    runtime.closed = true
    abortController.abort()
    unsubscribe()
  }

  const unsubscribe = subscribe(socket, {
    close: onClose,
    error: onClose,
    message: onMessage,
  })
}

/** Type helpers for {@link serve}. */
export declare namespace serve {
  type Options = {
    /** Expected per-tick amount in raw units. When set, credentials whose
     *  challenge `request.amount` does not match are rejected. Use this to
     *  pin the price when the route is backed by `Mppx.compose()` with
     *  multiple offers — otherwise a client can select the cheapest offer
     *  and still receive the same stream. */
    amount?: string | undefined
    generate: AsyncIterable<string> | ((stream: SessionController) => AsyncIterable<string>)
    pollIntervalMs?: number | undefined
    /** Payment route handler. Receives synthetic `POST` requests with only
     *  the `Authorization` header — no cookies, bodies, or upgrade headers. */
    route: SessionRoute
    socket: Socket
    store: ChannelStore.ChannelStore | import('../../../Store.js').Store
    url: string | URL
  }
}

function normalizeHttpUrl(value: string | URL): string {
  const url = new URL(value.toString())
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return url.toString()
}

/** Inputs used to verify a WebSocket authorization frame through the HTTP route. */
type AuthorizePaymentFrameParameters = {
  /** Serialized `Payment` credential from the WebSocket authorization frame. */
  authorization: string
  /** Normalized HTTP URL used for the synthetic management request. */
  requestUrl: string
  /** HTTP payment route used to verify management credentials. */
  route: SessionRoute
}

/** Verifies a WebSocket authorization frame and returns either a receipt or a payment error. */
async function authorizePaymentFrame(
  parameters: AuthorizePaymentFrameParameters,
): Promise<AuthorizationResult> {
  const result = await parameters.route(
    new Request(parameters.requestUrl, {
      method: 'POST',
      headers: { [Constants.Headers.authorization]: parameters.authorization },
    }),
  )

  if (result.status === 402) {
    const response = result.challenge
    return {
      status: 'rejected',
      message:
        (await response.text().catch(() => '')) ||
        response.statusText ||
        'payment verification failed',
      responseStatus: response.status,
    }
  }

  const response = result.withReceipt(new Response(null, { status: 204 }))
  const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt)
  if (!receiptHeader) throw new Error('management response missing Payment-Receipt header')
  return { status: 'accepted', receipt: deserializeSessionReceipt(receiptHeader) }
}
