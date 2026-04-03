import * as Credential from '../../Credential.js'
import * as ChannelStore from './ChannelStore.js'
import { deserializeSessionReceipt } from './Receipt.js'
import { createSessionReceipt } from './Receipt.js'
import type { SessionController } from './Sse.js'
import type { NeedVoucherEvent, SessionCredentialPayload, SessionReceipt } from './Types.js'

export type { SessionController } from './Sse.js'

export type SessionRouteResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt(response?: Response): Response }

export type SessionRoute = (request: Request) => Promise<SessionRouteResult>

export type Socket = {
  close(code?: number, reason?: string): unknown
  send(data: string): unknown
  addEventListener?: (
    type: 'close' | 'error' | 'message',
    listener: ((event: any) => void) | { handleEvent(event: any): void },
  ) => unknown
  removeEventListener?: (
    type: 'close' | 'error' | 'message',
    listener: ((event: any) => void) | { handleEvent(event: any): void },
  ) => unknown
  on?: (type: 'close' | 'error' | 'message', listener: (...args: any[]) => void) => unknown
  off?: (type: 'close' | 'error' | 'message', listener: (...args: any[]) => void) => unknown
}

export type Message =
  | { mpp: 'authorization'; authorization: string }
  | { mpp: 'message'; data: string }
  | { mpp: 'payment-close-request' }
  | { mpp: 'payment-close-ready'; data: SessionReceipt }
  | { mpp: 'payment-error'; status: number; message: string }
  | { mpp: 'payment-need-voucher'; data: NeedVoucherEvent }
  | { mpp: 'payment-receipt'; data: SessionReceipt }

export function formatAuthorizationMessage(authorization: string): string {
  return JSON.stringify({ mpp: 'authorization', authorization } satisfies Message)
}

export function formatApplicationMessage(data: string): string {
  return JSON.stringify({ mpp: 'message', data } satisfies Message)
}

export function formatCloseRequestMessage(): string {
  return JSON.stringify({ mpp: 'payment-close-request' } satisfies Message)
}

export function formatCloseReadyMessage(receipt: SessionReceipt): string {
  return JSON.stringify({ mpp: 'payment-close-ready', data: receipt } satisfies Message)
}

export function formatNeedVoucherMessage(params: NeedVoucherEvent): string {
  return JSON.stringify({ mpp: 'payment-need-voucher', data: params } satisfies Message)
}

export function formatReceiptMessage(receipt: SessionReceipt): string {
  return JSON.stringify({ mpp: 'payment-receipt', data: receipt } satisfies Message)
}

export function formatErrorMessage(parameters: { message: string; status: number }): string {
  return JSON.stringify({ mpp: 'payment-error', ...parameters } satisfies Message)
}

export function parseMessage(raw: string): Message | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.mpp === 'authorization' && typeof parsed.authorization === 'string') {
      return { mpp: 'authorization', authorization: parsed.authorization }
    }
    if (parsed.mpp === 'message' && typeof parsed.data === 'string') {
      return { mpp: 'message', data: parsed.data }
    }
    if (parsed.mpp === 'payment-close-request') {
      return { mpp: 'payment-close-request' }
    }
    if (parsed.mpp === 'payment-close-ready' && parsed.data) {
      return { mpp: 'payment-close-ready', data: parsed.data as SessionReceipt }
    }
    if (
      parsed.mpp === 'payment-error' &&
      typeof parsed.status === 'number' &&
      typeof parsed.message === 'string'
    ) {
      return { mpp: 'payment-error', status: parsed.status, message: parsed.message }
    }
    if (parsed.mpp === 'payment-need-voucher' && parsed.data) {
      return { mpp: 'payment-need-voucher', data: parsed.data as NeedVoucherEvent }
    }
    if (parsed.mpp === 'payment-receipt' && parsed.data) {
      return { mpp: 'payment-receipt', data: parsed.data as SessionReceipt }
    }
    return null
  } catch {
    return null
  }
}

export async function serve(options: serve.Options): Promise<void> {
  const { generate, pollIntervalMs = 100, route, socket, store: rawStore, url } = options
  const store = 'getChannel' in rawStore ? rawStore : ChannelStore.fromStore(rawStore)
  const requestUrl = normalizeHttpUrl(url)
  const maxQueuedPaymentMessages = 32

  const abortController = new AbortController()
  let closed = false
  let closeReadySent = false
  let closeRequestHandled = false
  let closeRequested = false
  let streamStarted = false
  let streamTask: Promise<void> | null = null
  let streamContext: {
    challengeId: string
    channelId: SessionCredentialPayload['channelId']
    tickCost: bigint
  } | null = null
  let action = Promise.resolve()
  let queuedActions = 0

  const close = async (code = 1000, reason?: string) => {
    if (closed) return
    closed = true
    abortController.abort()
    unsubscribe()
    await Promise.resolve(socket.close(code, reason))
  }

  const sendCloseReady = async () => {
    if (closeReadySent || !streamContext || closed) return
    closeReadySent = true

    const channel = await store.getChannel(streamContext.channelId)
    if (!channel) throw new Error('channel not found')

    const receipt = createSessionReceipt({
      challengeId: streamContext.challengeId,
      channelId: streamContext.channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
    await send(socket, formatCloseReadyMessage(receipt))
  }

  const runStream = async (context: {
    challengeId: string
    channelId: SessionCredentialPayload['channelId']
    tickCost: bigint
  }) => {
    const charge = () =>
      chargeOrWait({
        amount: context.tickCost,
        channelId: context.channelId,
        emit: (message) => send(socket, message),
        pollIntervalMs,
        signal: abortController.signal,
        store,
      })

    const iterable: AsyncIterable<string> =
      typeof generate === 'function' ? generate({ charge }) : generate

    try {
      for await (const value of iterable) {
        if (abortController.signal.aborted) break
        if (typeof generate !== 'function') await charge()
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
      streamTask = null
    }
  }

  const requestClose = async () => {
    if (closed) return
    if (closeRequestHandled) return
    closeRequestHandled = true
    closeRequested = true
    abortController.abort()
    await streamTask?.catch(() => {})
    await sendCloseReady()
  }

  const processAuthorization = async (authorization: string) => {
    if (closed) return
    const credential = Credential.deserialize<SessionCredentialPayload>(authorization)
    const payload = credential.payload
    if (payload.action === 'close') closeRequested = true

    const result = await route(
      new Request(requestUrl, {
        method: 'POST',
        headers: { Authorization: authorization },
      }),
    )

    if (result.status === 402) {
      const response = result.challenge
      const message =
        (await response.text().catch(() => '')) ||
        response.statusText ||
        'payment verification failed'
      await send(socket, formatErrorMessage({ message, status: response.status }))
      await close(1008, message)
      return
    }

    const response = result.withReceipt(new Response(null, { status: 204 }))
    const receiptHeader = response.headers.get('Payment-Receipt')
    if (!receiptHeader) {
      throw new Error('management response missing Payment-Receipt header')
    }

    const receipt = deserializeSessionReceipt(receiptHeader)
    await send(socket, formatReceiptMessage(receipt))

    if (payload.action === 'close') {
      await close(1000, 'payment session closed')
      return
    }

    if (payload.action === 'topUp') return
    if (streamStarted || closeRequested) return
    streamStarted = true
    streamContext = {
      challengeId: credential.challenge.id,
      channelId: payload.channelId,
      tickCost: BigInt(credential.challenge.request.amount as string),
    }
    // Defer the first application frame until after the client receives the
    // auth receipt and has a chance to install its own message listeners.
    setTimeout(() => {
      if (closeRequested || closed || !streamContext) return
      streamTask = runStream(streamContext)
    }, 0)
  }

  const onMessage = (payload: unknown) => {
    if (closed) return
    const raw = toText(payload)
    if (!raw) return
    const message = parseMessage(raw)
    if (!message) return

    if (message.mpp === 'payment-close-request') {
      closeRequested = true
      abortController.abort()
    }

    const work =
      message.mpp === 'authorization'
        ? () => processAuthorization(message.authorization)
        : message.mpp === 'payment-close-request'
          ? () => requestClose()
          : null

    if (!work) return
    if (queuedActions >= maxQueuedPaymentMessages) {
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

    queuedActions++
    action = action
      .then(async () => {
        try {
          if (closed) return
          await work()
        } finally {
          queuedActions--
        }
      })
      .catch(async (error) => {
        if (!closed) {
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
    if (closed) return
    closed = true
    abortController.abort()
    unsubscribe()
  }

  const unsubscribe = subscribe(socket, {
    close: onClose,
    error: onClose,
    message: onMessage,
  })
}

export declare namespace serve {
  type Options = {
    generate: AsyncIterable<string> | ((stream: SessionController) => AsyncIterable<string>)
    pollIntervalMs?: number | undefined
    route: SessionRoute
    socket: Socket
    store: ChannelStore.ChannelStore | import('../../Store.js').Store
    url: string | URL
  }
}

function normalizeHttpUrl(value: string | URL): string {
  const url = new URL(value.toString())
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return url.toString()
}

async function chargeOrWait(options: {
  amount: bigint
  channelId: SessionCredentialPayload['channelId']
  emit: (message: string) => Promise<void>
  pollIntervalMs: number
  signal: AbortSignal
  store: ChannelStore.ChannelStore
}): Promise<void> {
  const { amount, channelId, emit, pollIntervalMs, signal, store } = options

  let result = await ChannelStore.deductFromChannel(store, channelId, amount)
  if (result.ok) return

  await emit(
    formatNeedVoucherMessage({
      channelId,
      requiredCumulative: (result.channel.spent + amount).toString(),
      acceptedCumulative: result.channel.highestVoucherAmount.toString(),
      deposit: result.channel.deposit.toString(),
    }),
  )

  while (!result.ok) {
    await waitForUpdate(store, channelId, pollIntervalMs, signal)
    result = await ChannelStore.deductFromChannel(store, channelId, amount)
  }
}

async function waitForUpdate(
  store: ChannelStore.ChannelStore,
  channelId: SessionCredentialPayload['channelId'],
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)

  if (store.waitForUpdate) {
    await Promise.race([store.waitForUpdate(channelId), onceAborted(signal)])
    return
  }

  await sleep(pollIntervalMs, signal)
}

function subscribe(
  socket: Socket,
  handlers: {
    close: () => void
    error: () => void
    message: (payload: unknown) => void
  },
) {
  if (socket.addEventListener && socket.removeEventListener) {
    const onMessage = (event: Event | MessageEvent) => {
      const data = (event as MessageEvent).data
      handlers.message(data)
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', handlers.close)
    socket.addEventListener('error', handlers.error)
    return () => {
      socket.removeEventListener?.('message', onMessage)
      socket.removeEventListener?.('close', handlers.close)
      socket.removeEventListener?.('error', handlers.error)
    }
  }

  if (socket.on && socket.off) {
    const onMessage = (data: unknown) => handlers.message(data)
    socket.on('message', onMessage)
    socket.on('close', handlers.close)
    socket.on('error', handlers.error)
    return () => {
      socket.off?.('message', onMessage)
      socket.off?.('close', handlers.close)
      socket.off?.('error', handlers.error)
    }
  }

  throw new Error('unsupported websocket implementation')
}

async function send(socket: Socket, data: string) {
  await Promise.resolve(socket.send(data))
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value)
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value)
  }
  return null
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function onceAborted(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    })
  })
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
}
