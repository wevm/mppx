import type { Hex } from 'ox'
import { parseUnits, type Address } from 'viem'

import * as Challenge from '../../../Challenge.js'
import * as Fetch from '../../../client/internal/Fetch.js'
import * as PaymentCredential from '../../../Credential.js'
import type * as Account from '../../../viem/Account.js'
import type * as Client from '../../../viem/Client.js'
import { deserializeSessionReceipt } from '../../session/Receipt.js'
import { parseEvent } from '../../session/Sse.js'
import type { SessionCredentialPayload, SessionReceipt } from '../../session/Types.js'
import * as Ws from '../../session/Ws.js'
import type { ChannelEntry } from '../client/ChannelOps.js'
import { session as sessionPlugin } from '../client/Session.js'
import { uint96 } from '../Types.js'

type WebSocketConstructor = {
  new (url: string | URL, protocols?: string | string[]): WebSocket
}

type ReceiptWaiter = {
  predicate: (receipt: SessionReceipt) => boolean
  reject(error: Error): void
  resolve(receipt: SessionReceipt): void
}

type CloseReadyWaiter = {
  reject(error: Error): void
  resolve(receipt: SessionReceipt): void
}

const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

// Browser-style WebSocket clients may only initiate close with 1000 or 3000-4999.
// Keep protocol/policy close codes on the server side and use an app-defined code here.
const ClientWebSocketProtocolErrorCloseCode = 3008

export type SessionManager = {
  readonly channelId: Hex.Hex | undefined
  readonly cumulative: bigint
  readonly opened: boolean

  open(options?: { deposit?: bigint }): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse>
  sse(
    input: RequestInfo | URL,
    init?: RequestInit & {
      onReceipt?: ((receipt: SessionReceipt) => void) | undefined
      signal?: AbortSignal | undefined
    },
  ): Promise<AsyncIterable<string>>
  ws(
    input: string | URL,
    init?: {
      onReceipt?: ((receipt: SessionReceipt) => void) | undefined
      protocols?: string | string[] | undefined
      signal?: AbortSignal | undefined
    },
  ): Promise<WebSocket>
  close(): Promise<SessionReceipt | undefined>
}

export type PaymentResponse = Response & {
  receipt: SessionReceipt | null
  challenge: Challenge.Challenge | null
  channelId: Hex.Hex | null
  cumulative: bigint
}

/**
 * Creates a session manager that handles the full client payment lifecycle:
 * channel open, incremental vouchers, SSE streaming, and channel close.
 *
 * Internally delegates to the `session()` method for all
 * channel state management and credential creation, and to `Fetch.from`
 * for the 402 challenge/retry flow.
 *
 * ## Session resumption
 *
 * All channel state is held **in memory**. If the client process restarts,
 * the session is lost and a new on-chain channel will be opened on the next
 * request — the previous channel's deposit is orphaned until manually closed.
 *
 * Precompile channel identity is descriptor-based. Recovery requires a persisted
 * channel descriptor; a channel ID alone is not sufficient to resume a TIP-1034
 * channel.
 */
export function sessionManager(parameters: sessionManager.Parameters): SessionManager {
  const fetchFn = parameters.fetch ?? globalThis.fetch
  const WebSocketImpl =
    parameters.webSocket ??
    (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket
  const maxVoucherCumulative =
    parameters.maxDeposit !== undefined
      ? parseUnits(parameters.maxDeposit, parameters.decimals ?? 6)
      : null

  let channel: ChannelEntry | null = null
  let lastChallenge: Challenge.Challenge | null = null
  let lastUrl: RequestInfo | URL | null = null
  let spent = 0n
  let activeSocketChallenge: Challenge.Challenge | null = null
  let activeSocketChannelId: Hex.Hex | null = null
  let activeSocket: WebSocket | null = null
  let closeReadyReceipt: SessionReceipt | null = null
  let closeReadyWaiter: CloseReadyWaiter | null = null
  let expectedSocketCloseAmount: string | null = null
  let receiptWaiter: ReceiptWaiter | null = null
  let wsDeliveredChunks = 0n
  let wsTickCost = 0n

  const method = sessionPlugin({
    account: parameters.account,
    authorizedSigner: parameters.authorizedSigner,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
    escrow: parameters.escrow,
    decimals: parameters.decimals,
    maxDeposit: parameters.maxDeposit,
    onChannelUpdate(entry) {
      if (entry.channelId !== channel?.channelId) spent = 0n
      channel = entry
    },
  })

  const wrappedFetch = Fetch.from({
    fetch: fetchFn,
    methods: [method],
    onChallenge: async (challenge, _helpers) => {
      lastChallenge = challenge
      return undefined
    },
  })

  function updateSpentFromReceipt(receipt: SessionReceipt | null | undefined) {
    if (!receipt || receipt.channelId !== channel?.channelId) return
    assertReceiptWithinLocalState(receipt)
    const next = BigInt(receipt.spent)
    spent = spent > next ? spent : next
  }

  function assertReceiptWithinLocalState(receipt: SessionReceipt) {
    if (!channel || receipt.channelId !== channel.channelId) return
    const acceptedCumulative = BigInt(receipt.acceptedCumulative)
    const receiptSpent = BigInt(receipt.spent)
    if (receiptSpent > acceptedCumulative) {
      throw new Error('receipt spent exceeds accepted cumulative voucher amount')
    }
    if (acceptedCumulative > channel.cumulativeAmount) {
      throw new Error('receipt accepted cumulative exceeds local voucher state')
    }
    if (receiptSpent > channel.cumulativeAmount) {
      throw new Error('receipt spent exceeds local voucher state')
    }
    assertVoucherWithinLocalLimit(acceptedCumulative)
    assertVoucherWithinLocalLimit(receiptSpent)
  }

  function waitForReceipt(predicate: (receipt: SessionReceipt) => boolean = () => true) {
    if (receiptWaiter) throw new Error('receipt wait already in progress')
    return new Promise<SessionReceipt>((resolve, reject) => {
      receiptWaiter = { predicate, resolve, reject }
    })
  }

  function waitForCloseReady() {
    if (closeReadyReceipt) return Promise.resolve(closeReadyReceipt)
    if (closeReadyWaiter) throw new Error('close-ready wait already in progress')
    return new Promise<SessionReceipt>((resolve, reject) => {
      closeReadyWaiter = { resolve, reject }
    })
  }

  function settleReceipt(receipt: SessionReceipt) {
    if (!receiptWaiter) return
    if (!receiptWaiter.predicate(receipt)) return
    const waiter = receiptWaiter
    receiptWaiter = null
    waiter.resolve(receipt)
  }

  function settleCloseReady(receipt: SessionReceipt) {
    closeReadyReceipt = receipt
    if (!closeReadyWaiter) return
    const waiter = closeReadyWaiter
    closeReadyWaiter = null
    waiter.resolve(receipt)
  }

  function rejectReceipt(error: Error) {
    if (!receiptWaiter) return
    const waiter = receiptWaiter
    receiptWaiter = null
    waiter.reject(error)
  }

  function rejectCloseReady(error: Error) {
    if (!closeReadyWaiter) return
    const waiter = closeReadyWaiter
    closeReadyWaiter = null
    waiter.reject(error)
  }

  function getFallbackCloseAmount(challenge: Challenge.Challenge, channelId: Hex.Hex): string {
    if (
      closeReadyReceipt &&
      closeReadyReceipt.challengeId === challenge.id &&
      closeReadyReceipt.channelId === channelId
    ) {
      return closeReadyReceipt.spent
    }

    const cumulative = channel?.channelId === channelId ? channel.cumulativeAmount : 0n

    // For WS sessions, use delivered chunk count × tick cost as a tight spend
    // estimate.  Without this, a socket death before close-ready would cause
    // the client to sign for the full cumulative voucher authorization —
    // potentially orders of magnitude more than what was actually consumed.
    // The estimate may undercount by at most 1 chunk (if the server committed
    // a charge but the socket died before delivering the message).
    if (wsTickCost > 0n) {
      const deliveryEstimate = wsDeliveredChunks * wsTickCost
      const bestSpent = spent > deliveryEstimate ? spent : deliveryEstimate
      return (bestSpent > cumulative ? cumulative : bestSpent).toString()
    }

    // SSE/HTTP: spent is kept in sync by inline receipts, use it directly.
    return spent.toString()
  }

  function assertVoucherWithinLocalLimit(cumulativeAmount: bigint) {
    if (maxVoucherCumulative === null) return
    if (cumulativeAmount <= maxVoucherCumulative) return
    throw new Error(
      `requested voucher amount ${cumulativeAmount} exceeds local maxDeposit ${maxVoucherCumulative}`,
    )
  }

  function toPaymentResponse(response: Response): PaymentResponse {
    const receiptHeader = response.headers.get('Payment-Receipt')
    const receipt = receiptHeader ? deserializeSessionReceipt(receiptHeader) : null
    updateSpentFromReceipt(receipt)
    return Object.assign(response, {
      receipt,
      challenge: lastChallenge,
      channelId: channel?.channelId ?? null,
      cumulative: channel?.cumulativeAmount ?? 0n,
    })
  }

  async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse> {
    lastUrl = input
    const response = await wrappedFetch(input, init)
    return toPaymentResponse(response)
  }

  function createManagedSocket(socket: WebSocket) {
    type EventType = 'close' | 'error' | 'message' | 'open'
    type MessageEvent = { data: string; type: 'message' }
    type Listener = {
      once: boolean
      value: ((event: any) => void) | { handleEvent(event: any): void }
    }
    const listeners = new Map<EventType, Set<Listener>>()
    let emittedClose = false
    let messageBuffer: MessageEvent[] | null = []
    let readyState = socket.readyState

    const add = (
      type: EventType,
      listener: ((event: any) => void) | { handleEvent(event: any): void },
      options?: boolean | AddEventListenerOptions,
    ) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add({
        once: typeof options === 'object' ? options.once === true : false,
        value: listener,
      })
      if (type === 'message' && messageBuffer) {
        const buffered = messageBuffer
        messageBuffer = null
        for (const event of buffered) emit('message', event)
      }
    }

    const remove = (
      type: EventType,
      listener: ((event: any) => void) | { handleEvent(event: any): void },
    ) => {
      const set = listeners.get(type)
      if (!set) return
      for (const entry of set) {
        if (entry.value === listener) set.delete(entry)
      }
    }

    const emit = (type: EventType, event: any) => {
      if (type === 'close') {
        if (emittedClose) return
        emittedClose = true
        readyState = WebSocketReadyState.CLOSED
        messageBuffer = null
      }
      if (type === 'open') readyState = WebSocketReadyState.OPEN

      if (type === 'message' && messageBuffer) {
        messageBuffer.push(event)
        return
      }

      const property = `on${type}` as const
      const handler = (managed as Record<string, unknown>)[property]
      if (typeof handler === 'function') handler(event)

      const set = listeners.get(type)
      if (!set) return
      for (const entry of Array.from(set)) {
        if (typeof entry.value === 'function') entry.value(event)
        else entry.value.handleEvent(event)
        if (entry.once) set.delete(entry)
      }
    }

    const managed = {
      addEventListener: add,
      close(code?: number, reason?: string) {
        socket.close(code, reason)
      },
      get bufferedAmount() {
        return socket.bufferedAmount
      },
      get extensions() {
        return socket.extensions
      },
      on(type: EventType, listener: (...args: any[]) => void) {
        add(type, listener)
      },
      onclose: null as ((event: any) => void) | null,
      onerror: null as ((event: any) => void) | null,
      _onmessage: null as ((event: any) => void) | null,
      get onmessage() {
        return managed._onmessage
      },
      set onmessage(fn: ((event: any) => void) | null) {
        managed._onmessage = fn
        if (fn && messageBuffer) {
          const buffered = messageBuffer
          messageBuffer = null
          for (const event of buffered) emit('message', event)
        }
      },
      onopen: null as ((event: any) => void) | null,
      off(type: EventType, listener: (...args: any[]) => void) {
        remove(type, listener)
      },
      get protocol() {
        return socket.protocol
      },
      get readyState() {
        return readyState
      },
      removeEventListener: remove,
      send(data: string) {
        socket.send(data)
      },
      get url() {
        return socket.url
      },
    }

    return {
      emit,
      socket: managed as unknown as WebSocket,
    }
  }

  const self: SessionManager = {
    get channelId() {
      return channel?.channelId
    },
    get cumulative() {
      return channel?.cumulativeAmount ?? 0n
    },
    get opened() {
      return channel?.opened ?? false
    },

    async open(options) {
      if (channel?.opened) return

      if (!lastChallenge) {
        throw new Error(
          'No challenge available. Make a request first to receive a 402 challenge, or pass a challenge via .fetch()/.sse().',
        )
      }

      const deposit = options?.deposit
      const credential = await method.createCredential({
        challenge: lastChallenge as never,
        context: {
          ...(deposit !== undefined && { depositRaw: deposit.toString() }),
        },
      })

      if (!lastUrl) throw new Error('No URL available — call fetch() or sse() before open().')
      const response = await fetchFn(lastUrl, {
        method: 'POST',
        headers: { Authorization: credential },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const wwwAuth = response.headers.get('WWW-Authenticate') ?? ''
        throw new Error(
          `Open request failed with status ${response.status}${body ? `: ${body}` : ''}${wwwAuth ? ` [WWW-Authenticate: ${wwwAuth}]` : ''}`,
        )
      }
    },

    fetch: doFetch,

    async sse(input, init) {
      const { onReceipt, signal, ...fetchInit } = init ?? {}

      const sseInit = {
        ...fetchInit,
        headers: {
          ...Fetch.normalizeHeaders(fetchInit.headers),
          Accept: 'text/event-stream',
        },
        ...(signal ? { signal } : {}),
      }

      const response = await doFetch(input, sseInit)

      // Snapshot the challenge at SSE open time so concurrent
      // calls don't overwrite it.
      const sseChallenge = lastChallenge

      if (!response.body) throw new Error('Response has no body.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      async function* iterate(): AsyncGenerator<string> {
        let buffer = ''

        try {
          while (true) {
            if (signal?.aborted) break

            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            const parts = buffer.split('\n\n')
            buffer = parts.pop()!

            for (const part of parts) {
              if (!part.trim()) continue

              const event = parseEvent(part)
              if (!event) continue

              switch (event.type) {
                case 'message':
                  yield event.data
                  break

                case 'payment-need-voucher': {
                  if (!channel || !sseChallenge) break
                  const required = BigInt(event.data.requiredCumulative)
                  assertVoucherWithinLocalLimit(required)
                  channel.cumulativeAmount =
                    channel.cumulativeAmount > required
                      ? channel.cumulativeAmount
                      : uint96(required)

                  const credential = await method.createCredential({
                    challenge: sseChallenge as never,
                    context: {
                      action: 'voucher',
                      channelId: channel.channelId,
                      descriptor: channel.descriptor,
                      cumulativeAmountRaw: channel.cumulativeAmount.toString(),
                    },
                  })
                  const voucherResponse = await fetchFn(input, {
                    method: 'POST',
                    headers: { Authorization: credential },
                  })
                  if (!voucherResponse.ok) {
                    throw new Error(`Voucher POST failed with status ${voucherResponse.status}`)
                  }
                  break
                }

                case 'payment-receipt':
                  updateSpentFromReceipt(event.data)
                  onReceipt?.(event.data)
                  break
              }
            }
          }
        } finally {
          reader.releaseLock()
        }
      }

      return iterate()
    },

    async ws(input, init) {
      if (!WebSocketImpl) {
        throw new Error(
          'No WebSocket implementation available. Pass `webSocket` to sessionManager() in this runtime.',
        )
      }

      const { onReceipt, protocols, signal } = init ?? {}
      const wsUrl = new URL(input.toString())
      const httpUrl = new URL(wsUrl.toString())
      if (httpUrl.protocol === 'ws:') httpUrl.protocol = 'http:'
      if (httpUrl.protocol === 'wss:') httpUrl.protocol = 'https:'

      lastUrl = httpUrl.toString()
      const probe = await fetchFn(httpUrl, signal ? { signal } : undefined)
      if (probe.status !== 402) {
        throw new Error(
          `Expected a 402 payment challenge from ${httpUrl}, received ${probe.status} instead.`,
        )
      }

      const challenge = Challenge.fromResponseList(probe).find(
        (item) => item.method === method.name && item.intent === method.intent,
      )
      if (!challenge) {
        throw new Error(
          'No payment challenge received from HTTP endpoint for this WebSocket URL. The server may not require payment or did not advertise a challenge.',
        )
      }
      lastChallenge = challenge

      const credential = await method.createCredential({
        challenge: challenge as never,
        context: {},
      })

      closeReadyReceipt = null
      activeSocketChallenge = challenge
      wsDeliveredChunks = 0n
      wsTickCost = BigInt(challenge.request.amount as string)
      const openCredential = PaymentCredential.deserialize<SessionCredentialPayload>(credential)
      activeSocketChannelId = openCredential.payload.channelId
      const rawSocket = new WebSocketImpl(wsUrl, protocols)
      activeSocket = rawSocket
      const managedSocket = createManagedSocket(rawSocket)

      const failSocketFlow = (message: string) => {
        rejectReceipt(new Error(message))
        rejectCloseReady(new Error(message))
        if (
          rawSocket.readyState === WebSocketReadyState.CONNECTING ||
          rawSocket.readyState === WebSocketReadyState.OPEN
        ) {
          rawSocket.close(ClientWebSocketProtocolErrorCloseCode, message)
        }
      }

      const isExpectedReceipt = (receipt: SessionReceipt) =>
        receipt.challengeId === challenge.id && receipt.channelId === activeSocketChannelId

      const socketOpened = new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          rawSocket.removeEventListener('error', onError)
          managedSocket.emit('open', { type: 'open' })
          resolve()
        }
        const onError = () => {
          rawSocket.removeEventListener('open', onOpen)
          reject(new Error(`WebSocket connection to ${wsUrl} failed to open.`))
        }
        rawSocket.addEventListener('open', onOpen, { once: true })
        rawSocket.addEventListener('error', onError, { once: true })
      })

      rawSocket.addEventListener('close', (event) => {
        if (activeSocket === rawSocket) activeSocket = null
        if (activeSocketChallenge === challenge) activeSocketChallenge = null
        if (activeSocketChannelId === openCredential.payload.channelId) activeSocketChannelId = null
        expectedSocketCloseAmount = null
        rejectReceipt(new Error('WebSocket closed before the payment flow completed.'))
        rejectCloseReady(new Error('WebSocket closed before the payment flow completed.'))
        managedSocket.emit('close', {
          code: (event as CloseEvent).code ?? 1000,
          reason: (event as CloseEvent).reason ?? '',
          type: 'close',
          wasClean: true,
        })
      })

      rawSocket.addEventListener('error', () => {
        managedSocket.emit('error', { type: 'error' })
      })

      rawSocket.addEventListener('message', async (event) => {
        const raw = typeof event.data === 'string' ? event.data : undefined
        if (!raw) return

        const message = Ws.parseMessage(raw)
        if (!message) {
          managedSocket.emit('message', { data: raw, type: 'message' })
          return
        }

        switch (message.mpp) {
          case 'authorization':
            break
          case 'message':
            wsDeliveredChunks += 1n
            managedSocket.emit('message', { data: message.data, type: 'message' })
            break
          case 'payment-close-ready':
            if (!isExpectedReceipt(message.data)) {
              failSocketFlow('received mismatched payment-close-ready frame')
              break
            }
            if (BigInt(message.data.spent) > (channel?.cumulativeAmount ?? 0n)) {
              failSocketFlow('received payment-close-ready beyond local voucher state')
              break
            }
            updateSpentFromReceipt(message.data)
            onReceipt?.(message.data)
            settleCloseReady(message.data)
            managedSocket.emit('close', { code: 1000, reason: 'stream complete', type: 'close' })
            break
          case 'payment-error':
            rejectReceipt(new Error(message.message))
            rejectCloseReady(new Error(message.message))
            break
          case 'payment-need-voucher': {
            if (message.data.channelId !== activeSocketChannelId) {
              failSocketFlow('received mismatched payment-need-voucher frame')
              break
            }
            const required = BigInt(message.data.requiredCumulative)
            try {
              assertVoucherWithinLocalLimit(required)
            } catch (error) {
              failSocketFlow(
                error instanceof Error
                  ? error.message
                  : 'requested voucher amount exceeds local maxDeposit',
              )
              break
            }
            const nextCumulative =
              (channel?.cumulativeAmount ?? 0n) > required
                ? (channel?.cumulativeAmount ?? 0n)
                : required
            if (channel?.channelId === activeSocketChannelId)
              channel.cumulativeAmount = uint96(nextCumulative)

            const voucher = await method.createCredential({
              challenge: challenge as never,
              context: {
                action: 'voucher',
                channelId: activeSocketChannelId,
                descriptor: channel?.descriptor,
                cumulativeAmountRaw: nextCumulative.toString(),
              },
            })
            rawSocket.send(Ws.formatAuthorizationMessage(voucher))
            break
          }
          case 'payment-receipt':
            if (!isExpectedReceipt(message.data)) {
              failSocketFlow('received mismatched payment-receipt frame')
              break
            }
            if (
              expectedSocketCloseAmount !== null &&
              Boolean(message.data.txHash) &&
              (message.data.acceptedCumulative !== expectedSocketCloseAmount ||
                message.data.spent !== expectedSocketCloseAmount)
            ) {
              failSocketFlow('received mismatched payment-close receipt frame')
              break
            }
            updateSpentFromReceipt(message.data)
            onReceipt?.(message.data)
            settleReceipt(message.data)
            break
        }
      })

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            rejectReceipt(new Error('WebSocket payment flow aborted.'))
            rejectCloseReady(new Error('WebSocket payment flow aborted.'))
            rawSocket.close()
          },
          { once: true },
        )
      }

      await socketOpened
      rawSocket.send(Ws.formatAuthorizationMessage(credential))
      await waitForReceipt()
      return managedSocket.socket
    },

    async close() {
      const closeChallenge = activeSocketChallenge ?? lastChallenge
      const closeChannelId = activeSocketChannelId ?? channel?.channelId

      if (!channel?.opened) return undefined

      if (!closeChallenge) {
        throw new Error(
          'Cannot close session: no challenge available. This usually means close() was called on a SessionManager instance that was recreated after the session was opened. Use the same SessionManager instance that opened the session, or make a request first to receive a fresh 402 challenge.',
        )
      }
      if (!closeChannelId) {
        throw new Error(
          'Cannot close session: no channel ID available. The session may not have been fully opened.',
        )
      }

      if (activeSocket?.readyState === WebSocketReadyState.OPEN) {
        const ready =
          closeReadyReceipt ??
          (await (async () => {
            activeSocket.send(Ws.formatCloseRequestMessage())
            return waitForCloseReady()
          })())
        const readySpent = BigInt(ready.spent)
        if (readySpent > (channel.cumulativeAmount > spent ? channel.cumulativeAmount : spent)) {
          throw new Error('close-ready spent exceeds local voucher state')
        }

        const credential = await method.createCredential({
          challenge: closeChallenge as never,
          context: {
            action: 'close',
            channelId: closeChannelId,
            descriptor: channel.descriptor,
            cumulativeAmountRaw: readySpent.toString(),
          },
        })

        const expectedCloseAmount = readySpent.toString()
        expectedSocketCloseAmount = expectedCloseAmount
        try {
          const pendingReceipt = waitForReceipt(
            (receipt) =>
              Boolean(receipt.txHash) &&
              receipt.challengeId === closeChallenge.id &&
              receipt.channelId === closeChannelId &&
              receipt.acceptedCumulative === expectedCloseAmount &&
              receipt.spent === expectedCloseAmount,
          )
          activeSocket.send(Ws.formatAuthorizationMessage(credential))
          const receipt = await pendingReceipt
          activeSocket.close()
          closeReadyReceipt = null
          return receipt
        } finally {
          expectedSocketCloseAmount = null
        }
      }

      const credential = await method.createCredential({
        challenge: closeChallenge as never,
        context: {
          action: 'close',
          channelId: closeChannelId,
          descriptor: channel.descriptor,
          cumulativeAmountRaw: (() => {
            const closeAmount = BigInt(getFallbackCloseAmount(closeChallenge, closeChannelId))
            if (closeAmount > channel.cumulativeAmount) {
              throw new Error('fallback close amount exceeds local voucher state')
            }
            assertVoucherWithinLocalLimit(closeAmount)
            return closeAmount.toString()
          })(),
        },
      })

      if (!lastUrl) {
        throw new Error(
          'Cannot close session: no URL available. This usually means close() was called on a SessionManager instance that was recreated after the session was opened. Use the same SessionManager instance that opened the session, or call fetch()/sse() before close().',
        )
      }

      const response = await fetchFn(lastUrl, {
        method: 'POST',
        headers: { Authorization: credential },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const detail = (() => {
          if (!body) return ''
          if (!response.headers.get('Content-Type')?.includes('application/problem+json')) {
            return body
          }
          try {
            const problem = JSON.parse(body) as { detail?: string }
            return problem.detail ?? body
          } catch {
            return body
          }
        })()
        const wwwAuth = response.headers.get('WWW-Authenticate') ?? ''
        throw new Error(
          `Close request failed with status ${response.status}${detail ? `: ${detail}` : ''}${wwwAuth ? ` [WWW-Authenticate: ${wwwAuth}]` : ''}`,
        )
      }
      const receiptHeader = response.headers.get('Payment-Receipt')
      const receipt = receiptHeader ? deserializeSessionReceipt(receiptHeader) : undefined

      return receipt
    },
  }

  return self
}

export declare namespace sessionManager {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers. Defaults to the account access key address when available, otherwise the account address. */
      authorizedSigner?: Address | undefined
      /** Viem client instance. Shorthand for `getClient: () => client`. */
      client?: import('viem').Client | undefined
      /** Token decimals used to convert `maxDeposit` to raw units. Defaults to `6`. */
      decimals?: number | undefined
      /** TIP20EscrowChannel precompile address override. */
      escrow?: Address | undefined
      fetch?: typeof globalThis.fetch | undefined
      /** Maximum deposit in human-readable units (e.g. `'10'` for 10 tokens). Converted to raw units via `decimals`. */
      maxDeposit?: string | undefined
      /** Optional websocket constructor for runtimes without a global WebSocket. */
      webSocket?: WebSocketConstructor | undefined
    }
}
