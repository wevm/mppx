import { Hex } from 'ox'
import { type Address, encodeFunctionData, parseUnits } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis } from 'viem/tempo'
import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as defaults from '../internal/defaults.js'
import { escrowAbi } from '../stream/Chain.js'
import * as Channel from '../stream/Channel.js'
import { deserializeStreamReceipt } from '../stream/Receipt.js'
import { parseEvent } from '../stream/Sse.js'
import type { StreamCredentialPayload, StreamReceipt } from '../stream/Types.js'
import { signVoucher } from '../stream/Voucher.js'

type ChannelState = {
  channelId: Hex.Hex
  salt: Hex.Hex
  cumulativeAmount: bigint
  escrowContract: Address
  chainId: number
  opened: boolean
}

export type Session = {
  readonly channelId: Hex.Hex | undefined
  readonly cumulative: bigint
  readonly opened: boolean

  open(options?: { deposit?: bigint }): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  sse(
    input: RequestInfo | URL,
    init?: RequestInit & {
      onReceipt?: ((receipt: StreamReceipt) => void) | undefined
      signal?: AbortSignal | undefined
    },
  ): Promise<AsyncIterable<string>>
  close(): Promise<StreamReceipt | undefined>
}

export function session(parameters: session.Parameters): Session {
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  const fetchFn = parameters.fetch ?? globalThis.fetch
  const decimals = parameters.decimals ?? 6
  const maxDeposit =
    parameters.maxDeposit !== undefined ? parseUnits(parameters.maxDeposit, decimals) : undefined

  let channel: ChannelState | null = null
  let lastChallenge: Challenge.Challenge | null = null
  let lastUrl: RequestInfo | URL | null = null
  let openPromise: Promise<void> | null = null

  function resolveEscrow(challenge: Challenge.Challenge, chainId: number): Address {
    const md = challenge.request.methodDetails as { escrowContract?: string } | undefined
    const challengeEscrow = md?.escrowContract as Address | undefined
    const escrow =
      challengeEscrow ??
      parameters.escrowContract ??
      ((defaults.escrowContract as Record<number, string>)[chainId] as Address | undefined)
    if (!escrow)
      throw new Error(
        'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
      )
    return escrow
  }

  function resolveChainId(challenge: Challenge.Challenge): number {
    const md = challenge.request.methodDetails as { chainId?: number } | undefined
    return md?.chainId ?? 0
  }

  async function doOpen(challenge: Challenge.Challenge, deposit: bigint): Promise<void> {
    const chainId = resolveChainId(challenge)
    const client = await getClient({ chainId })
    const account = getAccount(client)
    const escrowContract = resolveEscrow(challenge, chainId)
    const payee = challenge.request.recipient as Address
    const currency = challenge.request.currency as Address
    const amount = BigInt(challenge.request.amount as string)

    const salt = Hex.random(32)
    const channelId = Channel.computeId({
      authorizedSigner: account.address,
      chainId,
      deposit,
      escrowContract,
      payee,
      payer: account.address,
      salt,
      token: currency,
    })

    const approveData = encodeFunctionData({
      abi: Abis.tip20,
      functionName: 'approve',
      args: [escrowContract, deposit],
    })
    const openData = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [payee, currency, deposit, salt, account.address],
    })

    const md = challenge.request.methodDetails as { feePayer?: boolean } | undefined
    const prepared = await prepareTransactionRequest(client, {
      account,
      calls: [
        { to: currency, data: approveData },
        { to: escrowContract, data: openData },
      ],
      ...(md?.feePayer && { feePayer: true }),
    } as never)
    prepared.gas = prepared.gas! + 5_000n
    const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount: amount },
      escrowContract,
      chainId,
    )

    const payload: StreamCredentialPayload = {
      action: 'open',
      type: 'transaction',
      channelId,
      transaction,
      authorizedSigner: account.address,
      cumulativeAmount: amount.toString(),
      signature,
    }

    const credential = Credential.serialize({
      challenge,
      payload,
      source: `did:pkh:eip155:${chainId}:${account.address}`,
    })

    // Send the open credential to the server. The server broadcasts the
    // on-chain open tx and verifies the initial voucher before responding.
    // Channel state is set only *after* the server confirms success — otherwise
    // a failed open (e.g. AmountExceedsDeposit) would leave the client
    // believing the channel is open when it isn't.
    const response = await fetchFn(lastUrl!, {
      method: 'POST',
      headers: { Authorization: credential },
    })
    if (!response.ok) {
      throw new Error(`Open request failed with status ${response.status}`)
    }

    channel = {
      channelId,
      salt,
      cumulativeAmount: amount,
      escrowContract,
      chainId,
      opened: true,
    }
  }

  async function ensureOpen(challenge: Challenge.Challenge): Promise<void> {
    if (channel?.opened) return

    lastChallenge = challenge

    // Resolve the deposit for the channel open. Priority:
    //   1. Server-suggested deposit (from challenge), capped at maxDeposit
    //   2. maxDeposit alone (when server doesn't suggest one)
    // We intentionally do NOT fall back to `amount` — that's a single tick
    // cost, far too small for a useful channel deposit.
    const suggestedDepositRaw = (challenge.request as { suggestedDeposit?: string })
      .suggestedDeposit
    const suggestedDeposit = suggestedDepositRaw ? BigInt(suggestedDepositRaw) : undefined
    const deposit = (() => {
      if (suggestedDeposit !== undefined && maxDeposit !== undefined)
        return suggestedDeposit < maxDeposit ? suggestedDeposit : maxDeposit
      return suggestedDeposit ?? maxDeposit
    })()

    if (!deposit) throw new Error('Cannot auto-open: no deposit amount available.')

    if (!openPromise) {
      openPromise = doOpen(challenge, deposit).finally(() => {
        openPromise = null
      })
    }
    return openPromise
  }

  async function buildVoucherCredential(
    challenge: Challenge.Challenge,
    cumulativeAmount: bigint,
  ): Promise<string> {
    if (!channel) throw new Error('No open channel.')
    const client = await getClient({ chainId: channel.chainId })
    const account = getAccount(client)

    const signature = await signVoucher(
      client,
      account,
      { channelId: channel.channelId, cumulativeAmount },
      channel.escrowContract,
      channel.chainId,
    )

    const payload: StreamCredentialPayload = {
      action: 'voucher',
      channelId: channel.channelId,
      cumulativeAmount: cumulativeAmount.toString(),
      signature,
    }

    return Credential.serialize({
      challenge,
      payload,
      source: `did:pkh:eip155:${channel.chainId}:${account.address}`,
    })
  }

  async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    lastUrl = input

    if (channel?.opened && lastChallenge) {
      const amount = BigInt(lastChallenge.request.amount as string)
      channel.cumulativeAmount += amount

      const credential = await buildVoucherCredential(lastChallenge, channel.cumulativeAmount)
      return fetchFn(input, {
        ...init,
        headers: { ...init?.headers, Authorization: credential },
      })
    }

    const response = await fetchFn(input, init)
    if (response.status !== 402) return response

    const challenge = Challenge.fromResponse(response)
    lastChallenge = challenge

    if (maxDeposit === undefined && !channel?.opened) {
      throw new Error(
        'Received 402 but no `maxDeposit` configured and no channel open. Call `.open()` first or set `maxDeposit`.',
      )
    }

    await ensureOpen(challenge)

    return fetchFn(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: await buildVoucherCredential(challenge, channel!.cumulativeAmount),
      },
    })
  }

  const self: Session = {
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

      const deposit = options?.deposit ?? maxDeposit
      if (!deposit) throw new Error('No deposit amount provided.')

      await doOpen(lastChallenge, deposit)
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
      }

      const response = await doFetch(input, sseInit)

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

                case 'mpay-need-voucher': {
                  if (!channel || !lastChallenge) break
                  const required = BigInt(event.data.requiredCumulative)
                  channel.cumulativeAmount =
                    channel.cumulativeAmount > required ? channel.cumulativeAmount : required

                  const credential = await buildVoucherCredential(
                    lastChallenge,
                    channel.cumulativeAmount,
                  )
                  await fetchFn(input, {
                    method: 'POST',
                    headers: { Authorization: credential },
                  })
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

      const client = await getClient({ chainId: channel.chainId })
      const account = getAccount(client)

      const signature = await signVoucher(
        client,
        account,
        { channelId: channel.channelId, cumulativeAmount: channel.cumulativeAmount },
        channel.escrowContract,
        channel.chainId,
      )

      const payload: StreamCredentialPayload = {
        action: 'close',
        channelId: channel.channelId,
        cumulativeAmount: channel.cumulativeAmount.toString(),
        signature,
      }

      const credential = Credential.serialize({
        challenge: lastChallenge,
        payload,
        source: `did:pkh:eip155:${channel.chainId}:${account.address}`,
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

      channel = { ...channel, opened: false }
      return receipt
    },
  }

  return self
}

export declare namespace session {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Token decimals used to convert `maxDeposit` to raw units. Defaults to `6`. */
      decimals?: number | undefined
      escrowContract?: Address | undefined
      fetch?: typeof globalThis.fetch | undefined
      /** Maximum deposit in human-readable units (e.g. `'10'` for 10 tokens). Converted to raw units via `decimals`. */
      maxDeposit?: string | undefined
    }
}
