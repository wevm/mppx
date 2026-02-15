import type { Hex } from 'ox'
import type { Address } from 'viem'
import type * as Challenge from '../../Challenge.js'
import * as Fetch from '../../client/internal/Fetch.js'
import type * as Account from '../../viem/Account.js'
import type * as Client from '../../viem/Client.js'
import { deserializeStreamReceipt } from '../stream/Receipt.js'
import { parseEvent } from '../stream/Sse.js'
import type { StreamReceipt } from '../stream/Types.js'
import type { ChannelEntry } from './ChannelOps.js'
import { session as sessionPlugin } from './Session.js'

export type SessionManager = {
  readonly channelId: Hex.Hex | undefined
  readonly cumulative: bigint
  readonly opened: boolean

  open(options?: { deposit?: bigint }): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse>
  sse(
    input: RequestInfo | URL,
    init?: RequestInit & {
      onReceipt?: ((receipt: StreamReceipt) => void) | undefined
      signal?: AbortSignal | undefined
    },
  ): Promise<AsyncIterable<string>>
  close(): Promise<StreamReceipt | undefined>
}

export type PaymentResponse = Response & {
  receipt: StreamReceipt | null
  challenge: Challenge.Challenge | null
  channelId: Hex.Hex | null
  cumulative: bigint
}

/**
 * Creates a session manager that handles the full client payment lifecycle:
 * channel open, incremental vouchers, SSE streaming, and channel close.
 *
 * Internally delegates to the `session()` MethodIntent plugin for all
 * channel state management and credential creation, and to `Fetch.from`
 * for the 402 challenge/retry flow.
 *
 * ## Session resumption
 *
 * All channel state is held **in memory**. If the client process restarts,
 * the session is lost and a new on-chain channel will be opened on the next
 * request — the previous channel's deposit is orphaned until manually closed.
 *
 * When the server includes a `channelId` in the 402 challenge `methodDetails`,
 * the client will attempt to recover the channel by reading its on-chain state
 * via `getOnChainChannel()`. If the channel has a positive deposit and is not
 * finalized, it resumes from the on-chain settled amount.
 */
export function sessionManager(parameters: sessionManager.Parameters): SessionManager {
  const fetchFn = parameters.fetch ?? globalThis.fetch

  let channel: ChannelEntry | null = null
  let lastChallenge: Challenge.Challenge | null = null
  let lastUrl: RequestInfo | URL | null = null

  const method = sessionPlugin({
    account: parameters.account,
    authorizedSigner: parameters.authorizedSigner,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
    escrowContract: parameters.escrowContract,
    decimals: parameters.decimals,
    maxDeposit: parameters.maxDeposit,
    onChannelUpdate(entry) {
      channel = entry
    },
  })

  const wrappedFetch = Fetch.from({
    fetch: fetchFn,
    methods: [method],
    onChallenge(c) {
      lastChallenge = c
    },
  })

  function toPaymentResponse(response: Response): PaymentResponse {
    const receiptHeader = response.headers.get('Payment-Receipt')
    const receipt = receiptHeader ? deserializeStreamReceipt(receiptHeader) : null
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
          ...fetchInit.headers,
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
                  channel.cumulativeAmount =
                    channel.cumulativeAmount > required ? channel.cumulativeAmount : required

                  const credential = await method.createCredential({
                    challenge: sseChallenge as never,
                    context: {
                      action: 'voucher',
                      channelId: channel.channelId,
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

    async close() {
      if (!channel?.opened || !lastChallenge) return undefined

      const credential = await method.createCredential({
        challenge: lastChallenge as never,
        context: {
          action: 'close',
          channelId: channel.channelId,
          cumulativeAmountRaw: channel.cumulativeAmount.toString(),
        },
      })

      let receipt: StreamReceipt | undefined
      if (lastUrl) {
        const response = await fetchFn(lastUrl, {
          method: 'POST',
          headers: { Authorization: credential },
        })
        const receiptHeader = response.headers.get('Payment-Receipt')
        if (receiptHeader) receipt = deserializeStreamReceipt(receiptHeader)
      }

      return receipt
    },
  }

  return self
}

export declare namespace sessionManager {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers. Defaults to the account address. */
      authorizedSigner?: Address | undefined
      /** Viem client instance. Shorthand for `getClient: () => client`. */
      client?: import('viem').Client | undefined
      /** Token decimals used to convert `maxDeposit` to raw units. Defaults to `6`. */
      decimals?: number | undefined
      /** Escrow contract address. */
      escrowContract?: Address | undefined
      fetch?: typeof globalThis.fetch | undefined
      /** Maximum deposit in human-readable units (e.g. `'10'` for 10 tokens). Converted to raw units via `decimals`. */
      maxDeposit?: string | undefined
    }
}
