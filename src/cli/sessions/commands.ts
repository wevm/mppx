import { Cli, Errors, z } from 'incur'
import { createClient, http } from 'viem'
import { tempo as tempoMainnet, tempoModerato } from 'viem/tempo/chains'

import { normalizeHeaders } from '../../client/internal/Fetch.js'
import { canSignDescriptor } from '../../tempo/session/client/CredentialState.js'
import * as Chain from '../../tempo/session/precompile/Chain.js'
import * as Channel from '../../tempo/session/precompile/Channel.js'
import { resolvePersistentAccount } from '../account.js'
import { resolveChain, resolveRpcUrl, type Network } from '../utils.js'
import { closeWithSessionManager } from './Manager.js'
import {
  createSessionRegistry,
  SessionBusyError,
  SessionStateError,
  type ManagedSession,
  type SessionPersistenceContext,
  sessionResourceUrl,
  sessionScope,
  toChannelStore,
} from './store.js'

type SessionCloseOptions = {
  account?: string | undefined
  headers?: readonly string[] | undefined
  network?: Network | undefined
  resourceUrl?: string | undefined
  rpcUrl?: string | undefined
}

const sessionOutputSchema = z.object({
  status: z.enum(['opening', 'open', 'closing', 'stale']),
  channelId: z.string(),
  account: z.string().optional(),
  payer: z.string(),
  payee: z.string(),
  authorizedSigner: z.string(),
  token: z.string(),
  escrow: z.string(),
  chainId: z.number(),
  cumulativeAmount: z.string(),
  confirmedSpend: z.string(),
  deposit: z.string(),
  units: z.number(),
  resourceUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const sessionCloseOutputSchema = z.object({
  channelId: z.string(),
  status: z.enum(['closed', 'already-closed']),
  spent: z.string(),
  txHash: z.string().optional(),
})

const sessionBulkCloseOutputSchema = z.object({
  closed: z.array(sessionCloseOutputSchema),
  failed: z.array(z.object({ channelId: z.string(), message: z.string() })),
})

type SessionOutput = z.infer<typeof sessionOutputSchema>
type SessionCloseOutput = z.infer<typeof sessionCloseOutputSchema>

function networkChainId(network: Network): number {
  return network === 'mainnet' ? tempoMainnet.id : tempoModerato.id
}

function networkForChain(chainId: number): Network | undefined {
  if (chainId === tempoMainnet.id) return 'mainnet'
  if (chainId === tempoModerato.id) return 'testnet'
  return undefined
}

function parseHeaders(values: readonly string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const value of values ?? []) {
    const index = value.indexOf(':')
    if (index === -1)
      throw new Errors.IncurError({
        code: 'INVALID_HEADER',
        message: `Invalid header format: ${value}`,
        exitCode: 2,
      })
    headers[value.slice(0, index).trim()] = value.slice(index + 1).trim()
  }
  return headers
}

function outputSession(record: ManagedSession): SessionOutput {
  return {
    status: record.status,
    channelId: record.channel.channelId,
    ...(record.account.name && { account: record.account.name }),
    payer: record.channel.descriptor.payer,
    payee: record.channel.descriptor.payee,
    authorizedSigner: record.channel.descriptor.authorizedSigner,
    token: record.channel.descriptor.token,
    escrow: record.channel.escrow,
    chainId: record.channel.chainId,
    cumulativeAmount: record.channel.cumulativeAmount.toString(),
    confirmedSpend: record.spent.toString(),
    deposit: record.channel.deposit.toString(),
    units: record.units,
    resourceUrl: record.endpoint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Normalizes persistent session failures for CLI output. */
export function sessionCommandError(error: unknown, fallbackCode: string): never {
  if (error instanceof Errors.IncurError) throw error
  if (error instanceof SessionBusyError)
    throw new Errors.IncurError({
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      cause: error,
    })
  if (error instanceof SessionStateError)
    throw new Errors.IncurError({
      code: error.code,
      message: error.message,
      exitCode: 65,
      cause: error,
    })
  throw new Errors.IncurError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    exitCode: 75,
    ...(error instanceof Error && { cause: error }),
  })
}

async function resolveCloseAccount(record: ManagedSession, accountOverride?: string | undefined) {
  const accountName = accountOverride ?? record.account.name
  const resolved = await resolvePersistentAccount(accountName)
  if (!canSignDescriptor(resolved.account, record.channel.descriptor))
    throw new Errors.IncurError({
      code: 'SESSION_ACCOUNT_MISMATCH',
      message: `Account ${resolved.account.address} cannot sign for session ${record.channel.channelId}.`,
      exitCode: 2,
    })
  return resolved
}

async function resolveCloseClient(
  chainId: number,
  options: Pick<SessionCloseOptions, 'network' | 'rpcUrl'>,
) {
  if (options.network && networkChainId(options.network) !== chainId)
    throw new Errors.IncurError({
      code: 'CHAIN_MISMATCH',
      message: `Session uses chainId ${chainId}, not ${options.network}.`,
      exitCode: 2,
    })
  const network = options.network ?? networkForChain(chainId)
  const rpcUrl = resolveRpcUrl(options.rpcUrl, { network })
  const chain = await resolveChain({ network, rpcUrl })
  if (chain.id !== chainId)
    throw new Errors.IncurError({
      code: 'CHAIN_MISMATCH',
      message: `Session uses chainId ${chainId}, but RPC is chainId ${chain.id}.`,
      exitCode: 2,
    })
  return createClient({ chain, transport: http(rpcUrl) })
}

const sessions = Cli.create('sessions', {
  description: 'Manage persistent payment sessions (list, view, close)',
})
  .command('list', {
    description: 'List persistent payment sessions',
    options: z.object({
      account: z.string().optional().describe('Filter by account name'),
      network: z.enum(['mainnet', 'testnet']).optional().describe('Filter by Tempo network'),
    }),
    output: z.object({ sessions: z.array(sessionOutputSchema) }),
    alias: { account: 'a' },
    async run(c) {
      try {
        const records = (await createSessionRegistry().list())
          .filter((record) => {
            if (c.options.account && record.account.name !== c.options.account) return false
            if (c.options.network && record.channel.chainId !== networkChainId(c.options.network))
              return false
            return true
          })
          .map(outputSession)
        const result = { sessions: records }
        if (c.format === 'json' && c.formatExplicit) return c.ok(result)
        if (records.length === 0) console.log('No sessions.')
        for (const [index, record] of records.entries()) {
          if (index > 0) console.log('')
          printSession(record)
        }
        return undefined as never
      } catch (error) {
        return sessionCommandError(error, 'SESSION_LIST_FAILED')
      }
    },
  })
  .command('view', {
    description: 'View a persistent payment session',
    args: z.object({ channelId: z.string().describe('Full session channel ID') }),
    output: sessionOutputSchema,
    async run(c) {
      try {
        const record = await createSessionRegistry().get(c.args.channelId)
        if (!record)
          throw new Errors.IncurError({
            code: 'SESSION_NOT_FOUND',
            message: `Session ${c.args.channelId} was not found.`,
            exitCode: 2,
          })
        const result = outputSession(record)
        if (c.format === 'json' && c.formatExplicit) return c.ok(result)
        printSession(result)
        return undefined as never
      } catch (error) {
        return sessionCommandError(error, 'SESSION_VIEW_FAILED')
      }
    },
  })
  .command('close', {
    description: 'Cooperatively close persistent payment sessions',
    usage: [{ suffix: '<channel-id> [options]' }, { suffix: '--all --yes [options]' }],
    args: z.object({ channelId: z.string().optional().describe('Full session channel ID') }),
    options: z.object({
      account: z.string().optional().describe('Account name'),
      all: z.boolean().optional().default(false).describe('Close every matching session'),
      header: z.array(z.string()).optional().describe('Add close request header (repeatable)'),
      network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
      rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
      url: z.string().optional().describe('Override the stored resource URL'),
      yes: z.boolean().optional().default(false).describe('Confirm closing every session'),
    }),
    output: z.union([sessionCloseOutputSchema, sessionBulkCloseOutputSchema]),
    alias: { account: 'a', header: 'H', rpcUrl: 'r' },
    async run(c) {
      if (c.options.all && c.args.channelId)
        return c.error({
          code: 'INVALID_SESSION_CLOSE',
          message: 'Specify a channel ID or --all, not both.',
          exitCode: 2,
        })
      if (!c.options.all && !c.args.channelId)
        return c.error({
          code: 'INVALID_SESSION_CLOSE',
          message: 'Specify a channel ID or --all.',
          exitCode: 2,
        })
      if (c.options.all && !c.options.yes)
        return c.error({
          code: 'CONFIRMATION_REQUIRED',
          message: 'Closing all sessions requires --yes.',
          exitCode: 2,
        })
      if (c.options.all && (c.options.header || c.options.rpcUrl || c.options.url))
        return c.error({
          code: 'INVALID_SESSION_CLOSE',
          message: '--header, --rpc-url, and --url only apply to a single session.',
          exitCode: 2,
        })

      const registry = createSessionRegistry()
      async function closeSession(
        channelId: string,
        options: SessionCloseOptions = {},
      ): Promise<SessionCloseOutput> {
        const candidate = await registry.get(channelId)
        if (!candidate)
          throw new Errors.IncurError({
            code: 'SESSION_NOT_FOUND',
            message: `Session ${channelId} was not found.`,
            exitCode: 2,
          })
        const scope = sessionScope(candidate.channel)
        const lock = await registry.acquire(scope)
        try {
          const record = await registry.get(channelId)
          if (!record)
            throw new Errors.IncurError({
              code: 'SESSION_NOT_FOUND',
              message: `Session ${channelId} was not found.`,
              exitCode: 2,
            })
          const resolvedAccount = await resolveCloseAccount(record, options.account)
          const client = await resolveCloseClient(record.channel.chainId, options)
          const expectedId = Channel.computeId({
            ...record.channel.descriptor,
            escrow: record.channel.escrow,
            chainId: record.channel.chainId,
          })
          if (expectedId.toLowerCase() !== record.channel.channelId.toLowerCase())
            throw new Errors.IncurError({
              code: 'SESSION_STATE_INVALID',
              message: 'Stored descriptor does not derive the session channel ID.',
              exitCode: 65,
            })

          const state = await Chain.getChannelState(
            client as never,
            record.channel.channelId,
            record.channel.escrow,
          )
          if (state.deposit === 0n) {
            await registry.remove(record.channel.channelId)
            return {
              channelId: record.channel.channelId,
              status: 'already-closed',
              spent: record.spent.toString(),
            }
          }

          const endpoint = sessionResourceUrl(options.resourceUrl ?? record.endpoint)
          const account = {
            ...(resolvedAccount.source === 'keychain' && { name: resolvedAccount.accountName }),
            address: resolvedAccount.account.address,
          }
          const closingContext = (challenge = record.challenge): SessionPersistenceContext => ({
            status: 'closing',
            account,
            endpoint,
            challenge,
            ...(record.receipt && { receipt: record.receipt }),
            spent: record.spent,
            units: record.units,
          })
          const closing = await registry.upsert({
            ...closingContext(),
            channel: record.channel,
          })
          const headers = parseHeaders(options.headers)
          let latestChallenge = closing.challenge
          const closeFetch: typeof globalThis.fetch = async (input, init) =>
            globalThis.fetch(input, {
              ...init,
              headers: { ...headers, ...normalizeHeaders(init?.headers) },
            })
          const result = await closeWithSessionManager({
            channel: closing.channel,
            challenge: closing.challenge,
            fetch: closeFetch,
            input: endpoint,
            spent: closing.spent,
            async onChallenge(challenge) {
              latestChallenge = challenge
              await registry.upsert({
                ...closingContext(challenge),
                channel: closing.channel,
              })
            },
            manager: {
              account: resolvedAccount.account,
              client,
              channelStore: toChannelStore(registry, {
                scope,
                selection: closing.channel.channelId,
                context: () => closingContext(latestChallenge),
              }),
            },
          })
          await registry.remove(closing.channel.channelId)
          return {
            channelId: closing.channel.channelId,
            status: 'closed',
            spent: result.receipt.spent,
            txHash: result.receipt.txHash,
          }
        } finally {
          await lock.release()
        }
      }

      try {
        if (c.options.all) {
          const records = (await registry.list()).filter(
            (record) =>
              (!c.options.account || record.account.name === c.options.account) &&
              (!c.options.network || record.channel.chainId === networkChainId(c.options.network)),
          )
          const closed: SessionCloseOutput[] = []
          const failed: { channelId: string; message: string }[] = []
          for (const record of records) {
            try {
              closed.push(
                await closeSession(record.channel.channelId, {
                  account: c.options.account,
                  network: c.options.network,
                }),
              )
            } catch (error) {
              failed.push({
                channelId: record.channel.channelId,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const result = { closed, failed }
          if (failed.length > 0) {
            for (const failure of failed)
              process.stderr.write(`${failure.channelId}: ${failure.message}\n`)
            process.exitCode = 1
          }
          if (c.format === 'json' && c.formatExplicit) return c.ok(result)
          for (const item of closed) console.log(`${item.channelId}  ${item.status}  ${item.spent}`)
          for (const failure of failed)
            console.log(`${failure.channelId}  failed  ${failure.message}`)
          return undefined as never
        }

        const result = await closeSession(c.args.channelId!, {
          account: c.options.account,
          headers: c.options.header,
          network: c.options.network,
          resourceUrl: c.options.url,
          rpcUrl: c.options.rpcUrl,
        })
        if (c.format === 'json' && c.formatExplicit) return c.ok(result)
        console.log(`${result.channelId}  ${result.status}  ${result.spent}`)
        if (result.txHash) console.log(`  transaction  ${result.txHash}`)
        return undefined as never
      } catch (error) {
        return sessionCommandError(error, 'SESSION_CLOSE_FAILED')
      }
    },
  })

function printSession(record: SessionOutput): void {
  console.log(record.channelId)
  console.log(`  status              ${record.status}`)
  console.log(`  cumulative amount   ${record.cumulativeAmount}`)
  console.log(`  confirmed spend     ${record.confirmedSpend}`)
  console.log(`  deposit             ${record.deposit}`)
  console.log(`  chain               ${record.chainId}`)
  console.log(`  payer               ${record.payer}`)
  console.log(`  payee               ${record.payee}`)
  console.log(`  token               ${record.token}`)
  console.log(`  resource            ${record.resourceUrl}`)
}

export default sessions
