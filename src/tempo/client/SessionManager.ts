import type { Hex } from 'ox'
import type { Address } from 'viem'

import type * as Challenge from '../../Challenge.js'
import * as Fetch from '../../client/internal/Fetch.js'
import type * as Account from '../../viem/Account.js'
import type * as Client from '../../viem/Client.js'
import { deserializeSessionReceipt } from '../session/Receipt.js'
import { parseEvent } from '../session/Sse.js'
import type { SessionReceipt } from '../session/Types.js'
import type { ChannelEntry } from './ChannelOps.js'
import { session as sessionPlugin, UnrecoverableRestoreError } from './Session.js'

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
 * All channel state is held **in memory** by default. Persistence is
 * **caller-owned**: if you want to survive process restarts, save the current
 * `channelId`, cumulative amount, and optionally `spent`, then pass them back
 * via `restore` when constructing a new manager.
 *
 * When the server includes a `channelId` in the 402 challenge `methodDetails`,
 * the client will attempt to recover the channel by reading its on-chain state
 * via `getOnChainChannel()`. If the channel has a positive deposit and is not
 * finalized, it resumes from the on-chain settled amount.
 *
 * Restored sessions are treated as already open for getters, fetch, SSE, and
 * voucher continuation. However, `.close()` still depends on a fresh request
 * after restart because the manager must first receive a new 402 challenge and
 * remember the request URL (`lastChallenge` / `lastUrl`) before it can create
 * and submit a close credential.
 */
export function sessionManager(parameters: sessionManager.Parameters): SessionManager {
  const fetchFn = parameters.fetch ?? globalThis.fetch
  const restore = parameters.restore

  if (restore) {
    if (restore.cumulativeAmount < 0n) {
      throw new Error('restore.cumulativeAmount must be >= 0n')
    }
    if (restore.spent !== undefined && restore.spent < 0n) {
      throw new Error('restore.spent must be >= 0n')
    }
    if (restore.spent !== undefined && restore.spent > restore.cumulativeAmount) {
      throw new Error('restore.spent must be <= restore.cumulativeAmount')
    }
  }

  let channel: ChannelEntry | null = null
  let restored: sessionManager.Restore | null = restore ?? null
  let lastChallenge: Challenge.Challenge | null = null
  let lastUrl: RequestInfo | URL | null = null
  let spent = restore?.spent ?? restore?.cumulativeAmount ?? 0n

  function restoreContext() {
    if (!restored || channel) return undefined
    return {
      channelId: restored.channelId,
      cumulativeAmountRaw: restored.cumulativeAmount.toString(),
    }
  }

  function activeChannelId() {
    return channel?.channelId ?? restored?.channelId
  }

  function activeCumulative() {
    return channel?.cumulativeAmount ?? restored?.cumulativeAmount
  }

  const method = sessionPlugin({
    account: parameters.account,
    authorizedSigner: parameters.authorizedSigner,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
    escrowContract: parameters.escrowContract,
    decimals: parameters.decimals,
    maxDeposit: parameters.maxDeposit,
    onChannelUpdate(entry) {
      const previousChannelId = channel?.channelId ?? restored?.channelId
      if (entry.channelId !== previousChannelId) {
        spent = 0n
      } else if (restored) {
        spent = spent < entry.cumulativeAmount ? spent : entry.cumulativeAmount
      }
      channel = entry
      restored = null
    },
  })

  const wrappedFetch = Fetch.from({
    fetch: fetchFn,
    methods: [method],
    onChallenge: async (challenge, helpers) => {
      lastChallenge = challenge
      const context = restoreContext()
      if (context) {
        try {
          return await helpers.createCredential(context)
        } catch (error) {
          if (error instanceof UnrecoverableRestoreError) {
            restored = null
          }
          throw error
        }
      }
      return undefined
    },
  })

  function updateSpentFromReceipt(receipt: SessionReceipt | null | undefined) {
    const activeChannelId = channel?.channelId ?? restored?.channelId
    if (!receipt || receipt.channelId !== activeChannelId) return
    const next = BigInt(receipt.spent)
    spent = spent > next ? spent : next
  }

  function toPaymentResponse(response: Response): PaymentResponse {
    const receiptHeader = response.headers.get('Payment-Receipt')
    const receipt = receiptHeader ? deserializeSessionReceipt(receiptHeader) : null
    updateSpentFromReceipt(receipt)
    return Object.assign(response, {
      receipt,
      challenge: lastChallenge,
      channelId: channel?.channelId ?? restored?.channelId ?? null,
      cumulative: channel?.cumulativeAmount ?? restored?.cumulativeAmount ?? 0n,
    })
  }

  async function throwForBadSseResponse(response: PaymentResponse): Promise<never> {
    const contentType = response.headers.get('Content-Type') ?? ''
    const body = await response.text().catch(() => '')
    throw new Error(
      `SSE request failed with status ${response.status}${contentType ? ` (${contentType})` : ''}${body ? `: ${body}` : ''}`,
    )
  }

  async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse> {
    lastUrl = input
    const response = await wrappedFetch(input, init)
    return toPaymentResponse(response)
  }

  const self: SessionManager = {
    get channelId() {
      return channel?.channelId ?? restored?.channelId
    },
    get cumulative() {
      return channel?.cumulativeAmount ?? restored?.cumulativeAmount ?? 0n
    },
    get opened() {
      return channel?.opened ?? !!restored
    },

    async open(options) {
      if (channel?.opened || restored) return

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
      const headers = new Headers(fetchInit.headers)
      headers.set('Accept', 'text/event-stream')

      const sseInit = {
        ...fetchInit,
        headers,
        ...(signal ? { signal } : {}),
      }

      const response = await doFetch(input, sseInit)

      if (!response.ok) {
        await throwForBadSseResponse(response)
      }

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
                  const channelId = activeChannelId()
                  const currentCumulative = activeCumulative()
                  if (!channelId || currentCumulative === undefined || !sseChallenge) break
                  const required = BigInt(event.data.requiredCumulative)
                  const nextCumulative = currentCumulative > required ? currentCumulative : required

                  if (channel) channel.cumulativeAmount = nextCumulative
                  else if (restored) restored.cumulativeAmount = nextCumulative

                  const credential = await method.createCredential({
                    challenge: sseChallenge as never,
                    context: {
                      action: 'voucher',
                      channelId,
                      cumulativeAmountRaw: nextCumulative.toString(),
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

    async close() {
      if ((!channel?.opened && !restored) || !lastChallenge) return undefined

      const activeChannelId = channel?.channelId ?? restored?.channelId
      if (!activeChannelId) return undefined

      const credential = await method.createCredential({
        challenge: lastChallenge as never,
        context: {
          action: 'close',
          channelId: activeChannelId,
          cumulativeAmountRaw: spent.toString(),
        },
      })

      let receipt: SessionReceipt | undefined
      if (lastUrl) {
        const response = await fetchFn(lastUrl, {
          method: 'POST',
          headers: { Authorization: credential },
        })
        const receiptHeader = response.headers.get('Payment-Receipt')
        if (receiptHeader) receipt = deserializeSessionReceipt(receiptHeader)
      }

      if (channel && activeChannelId === channel.channelId) {
        channel = {
          ...channel,
          opened: false,
        }
      }

      if (!channel && restored && activeChannelId === restored.channelId) {
        restored = null
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
      /**
       * Restores an already-open session channel after process restart.
       * Persistence remains caller-owned: save these values externally and pass
       * them back into a new manager instance when resuming.
       *
       * Note: `.close()` is still unavailable immediately after restart until a
       * fresh request provides a new challenge and request URL.
       */
      restore?: Restore | undefined
    }

  type Restore = {
    /** Previously opened channel to resume. */
    channelId: Hex.Hex
    /** Latest known cumulative voucher amount in raw units. */
    cumulativeAmount: bigint
    /** Latest known spent amount in raw units. Defaults to `cumulativeAmount`. */
    spent?: bigint | undefined
  }
}
