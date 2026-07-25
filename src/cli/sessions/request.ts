import { Errors } from 'incur'
import { createClient, formatUnits, http, type Hex } from 'viem'

import type * as Challenge from '../../Challenge.js'
import { createSqliteChannelStore } from '../../client/node.js'
import type { SqliteScopeLock } from '../../client/node.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { channelKey, entryKey, type ChannelStore } from '../../tempo/session/client/ChannelStore.js'
import {
  canSignDescriptor,
  resolveChallengeContext,
} from '../../tempo/session/client/CredentialState.js'
import { getSessionManagerInternals } from '../../tempo/session/client/internal/SessionManager.js'
import { sessionManager } from '../../tempo/session/client/SessionManager.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import { isEventStream } from '../../tempo/session/precompile/Protocol.js'
import { resolvePersistentAccount } from '../account.js'
import {
  isTestnet,
  printResponseHeaders,
  resolveChain,
  resolveRpcUrl,
  type Network,
} from '../utils.js'

/** CLI options needed to run a persistent Tempo session request. */
export type PersistentSessionRequestOptions = {
  account?: string | undefined
  fail?: boolean | undefined
  include?: boolean | undefined
  network?: Network | undefined
  rpcUrl?: string | undefined
  session: string
  silent: boolean
  verbose: number
}

/** Inputs for a persistent request after challenge selection and confirmation. */
export type PersistentSessionRequestParameters = {
  challenge: TempoSessionChallenge
  challengeResponse: Response
  endpoint: string
  fetch: typeof globalThis.fetch
  fetchInput: RequestInfo | URL
  init: RequestInit
  info(message: string): void
  methodOptions: Record<string, string>
  options: PersistentSessionRequestOptions
}

function sessionDecimals(challenge: Challenge.Challenge): number {
  return typeof challenge.request.decimals === 'number' ? challenge.request.decimals : 6
}

type SessionSelection = 'auto' | 'new' | Hex

/** Resolves `--session` and the `-M channel=` compatibility alias. */
export function resolveSessionSelection(
  session: string,
  channelAlias: string | undefined,
): SessionSelection {
  if (channelAlias && session !== 'auto' && channelAlias.toLowerCase() !== session.toLowerCase())
    throw new Errors.IncurError({
      code: 'SESSION_SELECTION_CONFLICT',
      message: '--session and -M channel= select different sessions.',
      exitCode: 2,
    })
  const value = channelAlias ?? session
  if (value === 'auto' || value === 'new') return value
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase() as Hex
  throw new Errors.IncurError({
    code: 'INVALID_SESSION',
    message: 'Session must be auto, new, or a 32-byte channel ID.',
    exitCode: 2,
  })
}

function selectedChannelStore(parameters: {
  key: string
  selection: SessionSelection
  store: ReturnType<typeof createSqliteChannelStore>
  account: Awaited<ReturnType<typeof resolvePersistentAccount>>['account']
}): ChannelStore {
  const { account, key, selection, store } = parameters
  let selected =
    selection === 'auto' || selection === 'new' ? undefined : store.getChannel(selection)
  if (selection !== 'auto' && selection !== 'new') {
    if (!selected)
      throw new Errors.IncurError({
        code: 'SESSION_NOT_FOUND',
        message: `Session ${selection} was not found.`,
        exitCode: 2,
      })
    if (
      !selected.opened ||
      entryKey(selected) !== key ||
      !canSignDescriptor(account, selected.descriptor)
    )
      throw new Errors.IncurError({
        code: 'SESSION_MISMATCH',
        message: `Session ${selection} cannot be used for this account and challenge.`,
        exitCode: 2,
      })
  }

  return {
    get(requestedKey) {
      if (requestedKey !== key) return store.get(requestedKey)
      if (selection === 'auto') return store.get(requestedKey)
      return selected
    },
    set(entry: ChannelEntry) {
      if (entryKey(entry) === key) selected = entry
      store.set(entry)
    },
    delete(requestedKey) {
      if (requestedKey === key) selected = undefined
      store.delete(requestedKey)
    },
  }
}

/** @internal Resolves the manager deposit cap in human-readable token units. */
export function resolveSessionMaxDeposit(
  challenge: Challenge.Challenge,
  methodOptions: Record<string, string>,
  testnet: boolean,
): string | undefined {
  if (methodOptions.deposit !== undefined) return methodOptions.deposit
  const suggested = challenge.request.suggestedDeposit
  if (typeof suggested === 'string')
    return formatUnits(BigInt(suggested), sessionDecimals(challenge))
  return testnet ? '10' : undefined
}

function writeSseChunk(chunk: string): void {
  if (chunk.trim() === '[DONE]') return
  if (chunk.length === 0) {
    process.stdout.write('\n')
    return
  }
  try {
    const parsed = JSON.parse(chunk) as {
      token?: string
      choices?: { delta?: { content?: string } }[]
    }
    process.stdout.write(parsed.token ?? parsed.choices?.[0]?.delta?.content ?? chunk)
  } catch {
    process.stdout.write(chunk)
  }
}

/**
 * Runs one persistent session request through MPPx's normal SQLite store and
 * server bootstrap path. Session selection is payment-scope based; the CLI
 * does not maintain a second channel registry or rehydration implementation.
 */
export async function runPersistentSessionRequest(
  parameters: PersistentSessionRequestParameters,
): Promise<void> {
  const { options } = parameters
  const rpcUrl = resolveRpcUrl(options.rpcUrl, { network: options.network })
  const chain = await resolveChain({ network: options.network, rpcUrl })
  const resolvedAccount = await resolvePersistentAccount(options.account)
  const client = createClient({ chain, transport: http(rpcUrl) })
  const challengeContext = await resolveChallengeContext({
    challenge: parameters.challenge,
    getClient: async () => client,
  })
  if (challengeContext.chainId !== chain.id)
    throw new Errors.IncurError({
      code: 'CHAIN_MISMATCH',
      message: `Challenge requires chainId ${challengeContext.chainId}, but RPC is chainId ${chain.id}.`,
      exitCode: 2,
    })
  const key = channelKey(challengeContext)
  const selection = resolveSessionSelection(options.session, parameters.methodOptions.channel)
  const channelStore = createSqliteChannelStore({
    namespace: new URL(parameters.endpoint).origin,
    payer: resolvedAccount.account.address,
    requestUrl: parameters.endpoint,
  })
  let lock: SqliteScopeLock | undefined

  try {
    lock = await channelStore.acquire(key)
    if (parameters.challengeResponse.status !== 402 || parameters.challengeResponse.bodyUsed)
      throw new Error('Session manager requires an unconsumed 402 challenge response.')

    let replayPending = true
    const managerFetch: typeof globalThis.fetch = async (input, init) => {
      if (init?.method === 'HEAD') return parameters.fetch(input, init)
      if (!replayPending) return parameters.fetch(input, init)
      replayPending = false
      return parameters.challengeResponse
    }
    const manager = sessionManager({
      account: resolvedAccount.account,
      bootstrap: selection === 'auto',
      client,
      channelStore: selectedChannelStore({
        account: resolvedAccount.account,
        key,
        selection,
        store: channelStore,
      }),
      decimals: sessionDecimals(parameters.challenge),
      maxDeposit: resolveSessionMaxDeposit(
        parameters.challenge,
        parameters.methodOptions,
        isTestnet(chain),
      ),
      fetch: managerFetch,
    })
    const response = await manager.fetch(parameters.fetchInput, parameters.init)

    if (options.fail && response.status >= 400)
      throw new Errors.IncurError({
        code: 'HTTP_ERROR',
        message: `HTTP error ${response.status}`,
        exitCode: 22,
      })
    if (response.status === 402)
      throw new Errors.IncurError({
        code: 'PAYMENT_REJECTED',
        message: 'Payment rejected.',
        exitCode: 75,
      })

    printResponseHeaders(response, {
      include: false,
      verbose: options.include ? Math.max(options.verbose, 2) : options.verbose,
      silent: options.silent,
    })
    if (isEventStream(response)) {
      const stream = getSessionManagerInternals(manager).consumeSseResponse(
        parameters.fetchInput,
        response,
        { signal: parameters.init.signal ?? undefined },
      )
      for await (const chunk of stream) writeSseChunk(chunk)
    } else {
      process.stdout.write(Buffer.from(await response.arrayBuffer()))
    }

    if (!options.silent && manager.channelId)
      parameters.info(`Session retained ${manager.channelId}\n`)
  } finally {
    lock?.release()
    channelStore.close()
  }
}
