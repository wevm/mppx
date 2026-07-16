import { Errors } from 'incur'
import type { Hex } from 'ox'
import { createClient, formatUnits, http } from 'viem'

import type * as Challenge from '../../Challenge.js'
import {
  canSignDescriptor,
  resolveChallengeContext,
} from '../../tempo/session/client/CredentialState.js'
import { getSessionManagerInternals } from '../../tempo/session/client/internal/SessionManager.js'
import { sessionManager } from '../../tempo/session/client/SessionManager.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import { isEventStream, type SessionReceipt } from '../../tempo/session/precompile/Protocol.js'
import { resolvePersistentAccount } from '../account.js'
import {
  isTestnet,
  printResponseHeaders,
  resolveChain,
  resolveRpcUrl,
  type Network,
} from '../utils.js'
import {
  createSessionRegistry,
  type ManagedSession,
  type SessionPersistenceContext,
  type SessionRegistry,
  type SessionSelection,
  type SessionStatus,
  SessionBusyError,
  sessionResourceUrl,
  sessionScope,
  sessionScopeKey,
  toChannelStore,
} from './store.js'

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
  registry?: SessionRegistry | undefined
}

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
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase() as Hex.Hex
  throw new Errors.IncurError({
    code: 'INVALID_SESSION',
    message: 'Session must be auto, new, or a 32-byte channel ID.',
    exitCode: 2,
  })
}

function sessionDecimals(challenge: Challenge.Challenge): number {
  return typeof challenge.request.decimals === 'number' ? challenge.request.decimals : 6
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

function validateReceipt(
  receipt: SessionReceipt | null | undefined,
  parameters: {
    challenge: Challenge.Challenge
    channelId: string
    cumulative: bigint
  },
): SessionReceipt | undefined {
  if (!receipt) return undefined
  if (receipt.challengeId !== parameters.challenge.id)
    throw new Error('Session receipt challenge does not match the paid request.')
  if (receipt.channelId.toLowerCase() !== parameters.channelId.toLowerCase())
    throw new Error('Session receipt channel does not match the selected channel.')
  const accepted = BigInt(receipt.acceptedCumulative)
  const spent = BigInt(receipt.spent)
  if (accepted > parameters.cumulative)
    throw new Error('Session receipt exceeds the local cumulative authorization.')
  if (spent > accepted) throw new Error('Session receipt spend exceeds its accepted authorization.')
  return receipt
}

function sameChannel(record: ManagedSession, channelId: string): boolean {
  return record.channel.channelId.toLowerCase() === channelId.toLowerCase()
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

/** Runs one manager-backed request while holding the payer and payment-scope lock. */
export async function runPersistentSessionRequest(
  parameters: PersistentSessionRequestParameters,
): Promise<void> {
  const { options } = parameters
  const resolvedAccount = await resolvePersistentAccount(options.account)
  const rpcUrl = resolveRpcUrl(options.rpcUrl, { network: options.network })
  const chain = await resolveChain({ network: options.network, rpcUrl })
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

  const scope = {
    payer: resolvedAccount.account.address,
    payee: challengeContext.payee,
    token: challengeContext.token,
    escrow: challengeContext.escrow,
    chainId: challengeContext.chainId,
  }
  const selection = resolveSessionSelection(options.session, parameters.methodOptions.channel)
  const registry = parameters.registry ?? createSessionRegistry()
  const lock = await registry.acquire(scope).catch((cause: unknown) => {
    if (cause instanceof SessionBusyError)
      throw new Errors.IncurError({
        code: cause.code,
        message: cause.message,
        exitCode: cause.exitCode,
        cause,
      })
    throw cause
  })

  try {
    const selectedId =
      selection === 'auto'
        ? await registry.getPreferred(scope)
        : selection === 'new'
          ? undefined
          : selection
    const selected = selectedId ? await registry.get(selectedId) : undefined
    if (selectedId && !selected)
      throw new Errors.IncurError({
        code: 'SESSION_NOT_FOUND',
        message: `Session ${selectedId} was not found.`,
        exitCode: 2,
      })
    if (selected && selection !== 'auto') {
      if (
        selected.status !== 'open' ||
        !selected.channel.opened ||
        sessionScopeKey(sessionScope(selected.channel)) !== sessionScopeKey(scope) ||
        !canSignDescriptor(resolvedAccount.account, selected.channel.descriptor)
      )
        throw new Errors.IncurError({
          code: 'SESSION_MISMATCH',
          message: `Session ${selected.channel.channelId} cannot be used for this account and challenge.`,
          exitCode: 2,
        })
    }

    const reusable = selected?.status === 'open' && selected.channel.opened ? selected : undefined
    let status: SessionStatus = reusable ? 'open' : 'opening'
    let latestChallenge = parameters.challenge
    let latestReceipt = reusable?.receipt
    let spent = reusable?.spent ?? 0n
    let units = reusable?.units ?? 0
    const endpoint = sessionResourceUrl(parameters.endpoint)
    const account = {
      ...(resolvedAccount.source === 'keychain' && { name: resolvedAccount.accountName }),
      address: resolvedAccount.account.address,
    }
    const persistenceContext = (): SessionPersistenceContext => ({
      status,
      account,
      endpoint,
      challenge: latestChallenge,
      ...(latestReceipt && { receipt: latestReceipt }),
      spent,
      units,
    })
    const channelStore = toChannelStore(registry, {
      scope,
      selection,
      context: persistenceContext,
      onNewChannel() {
        status = 'opening'
        latestReceipt = undefined
        spent = 0n
        units = 0
      },
    })
    const { signal, ...baseInit } = parameters.init
    const requestInit = {
      ...baseInit,
      ...(signal && { signal }),
      onReceipt(receipt: SessionReceipt) {
        latestReceipt = receipt
        spent = spent > BigInt(receipt.spent) ? spent : BigInt(receipt.spent)
        units = Math.max(units, receipt.units ?? 0)
      },
    }
    if (parameters.challengeResponse.status !== 402 || parameters.challengeResponse.bodyUsed)
      throw new Error('Session manager requires an unconsumed 402 challenge response.')
    let replayPending = true
    const manager = sessionManager({
      account: resolvedAccount.account,
      bootstrap: false,
      client,
      channelStore,
      decimals: sessionDecimals(parameters.challenge),
      maxDeposit: resolveSessionMaxDeposit(
        parameters.challenge,
        parameters.methodOptions,
        isTestnet(chain),
      ),
      fetch: async (input, init) => {
        if (!replayPending) return parameters.fetch(input, init)
        replayPending = false
        return parameters.challengeResponse
      },
    })
    if (reusable)
      getSessionManagerInternals(manager).rehydrate({
        channel: reusable.channel,
        challenge: parameters.challenge,
        input: parameters.fetchInput,
        spent: reusable.spent,
      })
    const { onReceipt, ...managerInit } = requestInit
    const response = await manager.fetch(parameters.fetchInput, managerInit)

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
    latestChallenge = response.challenge ?? parameters.challenge
    const channelId = manager.channelId
    if (!channelId) throw new Error('Session manager did not select a channel.')
    latestReceipt =
      validateReceipt(response.receipt, {
        challenge: latestChallenge,
        channelId,
        cumulative: manager.cumulative,
      }) ?? latestReceipt

    if (isEventStream(response)) {
      const stream = getSessionManagerInternals(manager).consumeSseResponse(
        parameters.fetchInput,
        response,
        { onReceipt, signal: parameters.init.signal ?? undefined },
      )
      for await (const chunk of stream) writeSseChunk(chunk)
    } else {
      process.stdout.write(Buffer.from(await response.arrayBuffer()))
    }

    const record = await registry.get(channelId)
    if (!record || !sameChannel(record, channelId))
      throw new Error(`Session ${channelId} was not persisted.`)
    if (latestReceipt) {
      const validatedReceipt = validateReceipt(latestReceipt, {
        challenge: latestChallenge,
        channelId,
        cumulative: manager.cumulative,
      })
      if (!validatedReceipt) throw new Error('Session receipt validation failed.')
      latestReceipt = validatedReceipt
      spent = spent > BigInt(validatedReceipt.spent) ? spent : BigInt(validatedReceipt.spent)
      units = Math.max(units, validatedReceipt.units ?? 0)
      status = 'open'
    }
    await registry.upsert({
      status,
      channel: record.channel,
      account,
      endpoint,
      challenge: latestChallenge,
      ...(latestReceipt && { receipt: latestReceipt }),
      spent,
      units,
    })

    if (!options.silent) {
      parameters.info(`Session retained ${channelId}\n`)
      parameters.info(`Close with: mppx sessions close ${channelId}\n`)
    }
  } finally {
    await lock.release()
  }
}
