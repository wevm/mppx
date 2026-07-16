import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Address, Hex } from 'viem'

import * as Challenge from '../../Challenge.js'
import { resolveEscrow, type ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import {
  deserializeEntry,
  entryKey,
  serializeEntry,
  type ChannelStore,
  type StoredChannel,
} from '../../tempo/session/client/ChannelStore.js'
import {
  isTempoSessionChallenge,
  type TempoSessionChallenge,
} from '../../tempo/session/client/Transports.js'
import type { SessionReceipt } from '../../tempo/session/precompile/Protocol.js'
import * as z from '../../zod.js'

const sessionStateVersion = 1 as const

/** Lifecycle state recorded for a managed CLI session. */
export type SessionStatus = 'opening' | 'open' | 'closing' | 'stale'

/** Account identity required to resume or close a managed session. */
export type SessionAccount = {
  /** Optional mppx account name. */
  name?: string | undefined
  /** Payer wallet address. */
  address: Address
}

/** Payment scope used to isolate preferred sessions and process locks. */
export type SessionScope = {
  payer: Address
  payee: Address
  token: Address
  escrow: Address
  chainId: number
}

/** Durable session record returned by the CLI registry. */
export type ManagedSession = {
  version: typeof sessionStateVersion
  status: SessionStatus
  channel: ChannelEntry
  account: SessionAccount
  endpoint: string
  challenge: TempoSessionChallenge
  receipt?: SessionReceipt | undefined
  spent: bigint
  units: number
  createdAt: string
  updatedAt: string
}

/** Input persisted by {@link SessionRegistry.upsert}. */
export type SessionUpsert = {
  status: SessionStatus
  channel: ChannelEntry
  account: SessionAccount
  endpoint: string
  challenge: Challenge.Challenge
  receipt?: SessionReceipt | undefined
  spent?: bigint | undefined
  units?: number | undefined
}

/** Dynamic context used when adapting the registry to the SDK channel store. */
export type SessionPersistenceContext = Omit<SessionUpsert, 'channel'>

/** Selection policy used by a persistent CLI request. */
export type SessionSelection = 'auto' | 'new' | Hex

/** Held process lock for a session scope. */
export type SessionLock = {
  /** Releases the lock if this process still owns it. */
  release(): Promise<void>
}

/** Filesystem-backed persistent session registry. */
export type SessionRegistry = {
  /** Versioned registry root. */
  readonly root: string
  /** Returns a managed session by full channel ID. */
  get(channelId: string): Promise<ManagedSession | undefined>
  /** Lists managed sessions. */
  list(): Promise<ManagedSession[]>
  /** Creates or monotonically updates a managed session. */
  upsert(input: SessionUpsert): Promise<ManagedSession>
  /** Removes a validated managed session and its preferred mappings. */
  remove(channelId: string): Promise<void>
  /** Returns the preferred channel ID for a payer and payment scope. */
  getPreferred(scope: SessionScope): Promise<Hex | undefined>
  /** Sets the preferred channel after verifying it matches the scope. */
  setPreferred(scope: SessionScope, channelId: string): Promise<void>
  /** Clears the preferred channel, optionally only when it matches `channelId`. */
  clearPreferred(scope: SessionScope, channelId?: string | undefined): Promise<void>
  /** Acquires an exclusive process lock for a payer and payment scope. */
  acquire(scope: SessionScope): Promise<SessionLock>
}

/** Options for {@link createSessionRegistry}. */
export type CreateSessionRegistryOptions = {
  /** Override the versioned state root. */
  stateRoot?: string | undefined
  /** Host identity written to lock files. */
  hostname?: string | undefined
  /** Process ID written to lock files. */
  pid?: number | undefined
  /** Clock used for persisted timestamps. */
  now?: (() => Date) | undefined
  /** Process liveness probe used for same-host lock reclamation. */
  isProcessAlive?: ((pid: number) => boolean) | undefined
}

/** Invalid, corrupt, or inconsistent persistent session state. */
export class SessionStateError extends Error {
  override readonly name = 'SessionStateError'
  readonly code = 'SESSION_STATE_INVALID'
  readonly file?: string | undefined

  constructor(message: string, options: { cause?: unknown; file?: string | undefined } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.file = options.file
  }
}

/** A session scope currently owned by another live process. */
export class SessionBusyError extends Error {
  override readonly name = 'SessionBusyError'
  readonly code = 'SESSION_BUSY'
  readonly exitCode = 75
  readonly scope: string
  readonly owner: { hostname: string; pid: number }

  constructor(scope: string, owner: { hostname: string; pid: number }) {
    super(`Session scope is busy in process ${owner.pid} on ${owner.hostname}.`)
    this.scope = scope
    this.owner = owner
  }
}

const storedChannelSchema = z.object({
  channelId: z.hash(),
  cumulativeAmount: z.string(),
  deposit: z.string(),
  descriptor: z.object({
    payer: z.address(),
    payee: z.address(),
    operator: z.address(),
    token: z.address(),
    salt: z.hash(),
    authorizedSigner: z.address(),
    expiringNonceHash: z.hash(),
  }),
  escrow: z.address(),
  chainId: z.number(),
  opened: z.boolean(),
})
const accountSchema = z.object({
  name: z.optional(z.string()),
  address: z.address(),
})
const receiptSchema = z.object({
  method: z.literal('tempo'),
  intent: z.literal('session'),
  status: z.literal('success'),
  timestamp: z.string(),
  reference: z.string(),
  challengeId: z.string(),
  channelId: z.hash(),
  acceptedCumulative: z.string(),
  spent: z.string(),
  units: z.optional(z.number()),
  txHash: z.optional(z.hash()),
})
const storedSessionSchema = z.object({
  version: z.literal(sessionStateVersion),
  method: z.literal('tempo'),
  intent: z.literal('session'),
  status: z.enum(['opening', 'open', 'closing', 'stale']),
  channel: storedChannelSchema,
  account: accountSchema,
  endpoint: z.string(),
  challenge: Challenge.Schema,
  receipt: z.optional(receiptSchema),
  spent: z.string(),
  units: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const preferredSessionSchema = z.object({
  version: z.literal(sessionStateVersion),
  channelId: z.hash(),
})
const lockOwnerSchema = z.object({
  version: z.literal(sessionStateVersion),
  scope: z.string(),
  hostname: z.string(),
  pid: z.number(),
  token: z.string(),
  createdAt: z.string(),
})

type StoredManagedSession = Omit<
  z.infer<typeof storedSessionSchema>,
  'account' | 'challenge' | 'channel' | 'receipt'
> & {
  account: SessionAccount
  challenge: TempoSessionChallenge
  channel: StoredChannel
  receipt?: SessionReceipt | undefined
}
type PreferredSession = z.infer<typeof preferredSessionSchema>
type LockOwner = z.infer<typeof lockOwnerSchema>

function parseStored<schema extends z.ZodMiniType>(
  schema: schema,
  value: unknown,
  file: string | undefined,
  message: string,
): z.output<schema> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw stateError(file, message, parsed.error)
  return parsed.data
}

type RegistryPaths = {
  root: string
  channels: string
  locks: string
  preferred: string
}

/** Returns the stable payer-qualified key for a persistent session scope. */
export function sessionScopeKey(scope: SessionScope): string {
  const normalized = normalizeScope(scope)
  return [
    normalized.payer,
    normalized.payee,
    normalized.token,
    normalized.escrow,
    normalized.chainId,
  ].join(':')
}

/** Returns the persistent payment scope for a channel. */
export function sessionScope(channel: ChannelEntry): SessionScope {
  return {
    payer: channel.descriptor.payer,
    payee: channel.descriptor.payee,
    token: channel.descriptor.token,
    escrow: channel.escrow,
    chainId: channel.chainId,
  }
}

/** Creates a filesystem-backed CLI session registry. */
export function createSessionRegistry(options: CreateSessionRegistryOptions = {}): SessionRegistry {
  const root = options.stateRoot ?? sessionStateRoot()
  const paths: RegistryPaths = {
    root,
    channels: path.join(root, 'channels'),
    locks: path.join(root, 'locks'),
    preferred: path.join(root, 'preferred'),
  }
  const hostname = options.hostname ?? os.hostname()
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const isProcessAlive = options.isProcessAlive ?? processIsAlive

  async function ensureDirectories(): Promise<void> {
    for (const directory of [paths.root, paths.channels, paths.locks, paths.preferred]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
    }
  }

  async function get(channelId: string): Promise<ManagedSession | undefined> {
    const normalizedId = normalizeChannelId(channelId)
    const file = channelFile(paths, normalizedId)
    const value = await readJson(file)
    if (value === undefined) return undefined
    const record = parseStoredSession(value, file)
    if (record.channel.channelId.toLowerCase() !== normalizedId)
      throw stateError(file, 'Session filename does not match its channel ID.')
    return deserializeSession(record)
  }

  async function list(): Promise<ManagedSession[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(paths.channels, { withFileTypes: true })
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return []
      throw stateError(paths.channels, 'Unable to list managed sessions.', error)
    }

    const records: ManagedSession[] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.includes('.tmp-')) continue
      if (!entry.name.endsWith('.json')) continue
      const channelId = entry.name.slice(0, -'.json'.length)
      normalizeChannelId(channelId)
      const record = await get(channelId)
      if (record) records.push(record)
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async function upsert(input: SessionUpsert): Promise<ManagedSession> {
    await ensureDirectories()
    const channel = sanitizeChannel(input.channel)
    const normalizedId = normalizeChannelId(channel.channelId)
    const file = channelFile(paths, normalizedId)
    const previousValue = await readJson(file)
    const previous =
      previousValue === undefined ? undefined : parseStoredSession(previousValue, file)
    if (previous) assertSameSession(previous, input, file)

    const challenge = parseSessionChallenge(input.challenge, file)
    assertChallengeMatchesChannel(challenge, channel, file)
    const receipt = input.receipt
      ? sanitizeReceipt(input.receipt, channel.channelId, file)
      : undefined
    const previousChannel = previous ? deserializeEntry(previous.channel) : undefined
    const cumulativeAmount = maxBigInt(
      channel.cumulativeAmount,
      previousChannel?.cumulativeAmount ?? 0n,
    )
    const spent = maxBigInt(
      input.spent ?? 0n,
      receipt ? BigInt(receipt.spent) : 0n,
      previous ? BigInt(previous.spent) : 0n,
    )
    if (spent > cumulativeAmount)
      throw stateError(file, 'Session spend exceeds the locally authorized cumulative amount.')

    const storedChannel = sanitizeStoredChannel(
      serializeEntry({ ...channel, cumulativeAmount }),
      file,
    )
    const timestamp = monotonicTimestamp(previous?.updatedAt, now(), file)
    const latestReceipt = selectLatestReceipt(previous?.receipt, receipt)
    const account = sanitizeAccount(input.account, file)
    const record: StoredManagedSession = {
      version: sessionStateVersion,
      method: 'tempo',
      intent: 'session',
      status: input.status,
      channel: storedChannel,
      account: {
        ...(account.name !== undefined
          ? { name: account.name }
          : previous?.account.name !== undefined
            ? { name: previous.account.name }
            : {}),
        address: account.address,
      },
      endpoint: sessionResourceUrl(input.endpoint, file),
      challenge,
      ...(latestReceipt !== undefined && { receipt: latestReceipt }),
      spent: spent.toString(),
      units: Math.max(previous?.units ?? 0, input.units ?? 0, receipt?.units ?? 0),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    const parsed = parseStoredSession(record, file)
    await writeJsonAtomic(file, parsed)
    return deserializeSession(parsed)
  }

  async function getPreferred(scope: SessionScope): Promise<Hex | undefined> {
    const file = preferredFile(paths, scope)
    const value = await readJson(file)
    if (value === undefined) return undefined
    const { channelId } = parseStored(
      preferredSessionSchema,
      value,
      file,
      'Preferred session is invalid.',
    )
    const record = await get(channelId)
    if (!record) throw stateError(file, `Preferred session ${channelId} does not exist.`)
    assertChannelScope(record.channel, scope, file)
    return channelId as Hex
  }

  async function setPreferred(scope: SessionScope, channelId: string): Promise<void> {
    const normalizedId = normalizeChannelId(channelId)
    const record = await get(normalizedId)
    const file = preferredFile(paths, scope)
    if (!record) throw stateError(file, `Session ${normalizedId} does not exist.`)
    assertChannelScope(record.channel, scope, file)
    await writeJsonAtomic(file, {
      version: sessionStateVersion,
      channelId: normalizedId as Hex,
    } satisfies PreferredSession)
  }

  async function clearPreferred(
    scope: SessionScope,
    channelId?: string | undefined,
  ): Promise<void> {
    const file = preferredFile(paths, scope)
    const normalizedId = channelId === undefined ? undefined : normalizeChannelId(channelId)
    const value = await readJson(file)
    if (value === undefined) return
    const current = parseStored(
      preferredSessionSchema,
      value,
      file,
      'Preferred session is invalid.',
    ).channelId
    if (normalizedId && current.toLowerCase() !== normalizedId) return
    await removeFile(file, 'Unable to clear preferred session.')
  }

  async function remove(channelId: string): Promise<void> {
    const normalizedId = normalizeChannelId(channelId)
    const record = await get(normalizedId)
    if (!record) return
    await clearPreferred(sessionScope(record.channel), normalizedId)
    const file = channelFile(paths, normalizedId)
    await removeFile(file, 'Unable to remove session.')
  }

  async function acquireKey(scope: string): Promise<SessionLock> {
    await ensureDirectories()
    const file = lockFile(paths, scope)
    for (let attempt = 0; attempt < 3; attempt++) {
      const owner: LockOwner = {
        version: sessionStateVersion,
        scope,
        hostname,
        pid,
        token: randomUUID(),
        createdAt: now().toISOString(),
      }
      try {
        await createLock(file, owner)
        if (await fileExists(deadLockClaimFile(file))) {
          await removeOwnedLock(file, owner)
          continue
        }
        return {
          async release() {
            await removeOwnedLock(file, owner)
          },
        }
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
      }

      const value = await readJson(file)
      if (value === undefined) continue
      const current = parseStored(lockOwnerSchema, value, file, 'Session lock is invalid.')
      if (current.scope !== scope) throw stateError(file, 'Session lock scope is invalid.')
      if (current.hostname !== hostname || isProcessAlive(current.pid))
        throw new SessionBusyError(scope, current)
      await removeDeadLock(file, current)
    }
    const value = await readJson(file)
    if (value === undefined) throw stateError(file, 'Unable to acquire session lock.')
    const owner = parseStored(lockOwnerSchema, value, file, 'Session lock is invalid.')
    throw new SessionBusyError(scope, owner)
  }

  async function acquire(scope: SessionScope): Promise<SessionLock> {
    return acquireKey(sessionScopeKey(scope))
  }

  return {
    root,
    get,
    list,
    upsert,
    remove,
    getPreferred,
    setPreferred,
    clearPreferred,
    acquire,
  }
}

/** Adapts a persistent registry selection to the session manager's channel store. */
export function toChannelStore(
  registry: SessionRegistry,
  options: {
    scope: SessionScope
    selection: SessionSelection
    context: () => SessionPersistenceContext
    onNewChannel?: ((channel: ChannelEntry) => void) | undefined
  },
): ChannelStore {
  const expectedKey = scopeEntryKey(options.scope)
  let selectedChannelId: Hex | undefined =
    options.selection === 'auto' || options.selection === 'new'
      ? undefined
      : (normalizeChannelId(options.selection) as Hex)

  function assertKey(key: string): void {
    if (key.toLowerCase() !== expectedKey)
      throw new SessionStateError('Session manager requested an unexpected payment scope.')
  }

  async function selected(reusableOnly = true): Promise<ManagedSession | undefined> {
    if (options.selection === 'new' && !selectedChannelId) return undefined
    const channelId = selectedChannelId ?? (await registry.getPreferred(options.scope))
    if (!channelId) return undefined
    const record = await registry.get(channelId)
    if (!record) throw new SessionStateError(`Session ${channelId} does not exist.`)
    assertChannelScope(record.channel, options.scope)
    if (reusableOnly && (record.status !== 'open' || !record.channel.opened)) return undefined
    selectedChannelId = channelId
    return record
  }

  return {
    async get(key) {
      assertKey(key)
      return (await selected())?.channel
    },
    async set(channel) {
      assertKey(entryKey(channel))
      assertChannelScope(channel, options.scope)
      if (selectedChannelId && selectedChannelId.toLowerCase() !== channel.channelId.toLowerCase())
        throw new SessionStateError(
          `Session manager selected ${selectedChannelId}, but attempted to store ${channel.channelId}.`,
        )
      if (!selectedChannelId) options.onNewChannel?.(channel)
      const record = await registry.upsert({ ...options.context(), channel })
      selectedChannelId = record.channel.channelId
      await registry.setPreferred(options.scope, record.channel.channelId)
    },
    async delete(key) {
      assertKey(key)
      const record = await selected(false)
      if (!record) return
      const context = options.context()
      await registry.upsert({
        ...record,
        ...context,
        status: context.status === 'closing' ? 'closing' : 'stale',
        channel: record.channel,
        spent: context.spent ?? record.spent,
        units: context.units ?? record.units,
      })
      if (context.status !== 'closing')
        await registry.clearPreferred(options.scope, record.channel.channelId)
      selectedChannelId = undefined
    },
  }
}

function sessionStateRoot(): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(stateHome, 'mppx', 'sessions', `v${sessionStateVersion}`)
}

function channelFile(paths: RegistryPaths, channelId: string): string {
  return path.join(paths.channels, `${channelId}.json`)
}

function lockFile(paths: RegistryPaths, scope: string): string {
  const digest = createHash('sha256').update(scope).digest('hex')
  return path.join(paths.locks, `${digest}.lock`)
}

function preferredFile(paths: RegistryPaths, scope: SessionScope): string {
  const digest = createHash('sha256').update(sessionScopeKey(scope)).digest('hex')
  return path.join(paths.preferred, `${digest}.json`)
}

function normalizeChannelId(channelId: string): string {
  return parseStored(
    z.hash(),
    channelId,
    undefined,
    `Invalid session channel ID: ${channelId}.`,
  ).toLowerCase()
}

function normalizeAddress(value: unknown, label: string, file?: string | undefined): Address {
  return parseStored(z.address(), value, file, `Invalid ${label}.`).toLowerCase() as Address
}

function normalizeScope(scope: SessionScope): SessionScope {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId < 0)
    throw new SessionStateError('Invalid session chain ID.')
  return {
    payer: normalizeAddress(scope.payer, 'session payer'),
    payee: normalizeAddress(scope.payee, 'session payee'),
    token: normalizeAddress(scope.token, 'session token'),
    escrow: normalizeAddress(scope.escrow, 'session escrow'),
    chainId: scope.chainId,
  }
}

function scopeEntryKey(scope: SessionScope): string {
  const normalized = normalizeScope(scope)
  return [normalized.payee, normalized.token, normalized.escrow, normalized.chainId].join(':')
}

/** Returns the exact HTTP resource URL persisted for session management. */
export function sessionResourceUrl(endpoint: unknown, file?: string | undefined): string {
  if (typeof endpoint !== 'string') throw stateError(file, 'Session endpoint is invalid.')
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch (cause) {
    throw stateError(file, 'Session endpoint is invalid.', cause)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw stateError(file, 'Session endpoint must use HTTP or HTTPS.')
  if (parsed.username || parsed.password)
    throw stateError(file, 'Session endpoint must not contain credentials.')
  const fragment = endpoint.indexOf('#')
  return fragment === -1 ? endpoint : endpoint.slice(0, fragment)
}

function sanitizeAccount(value: unknown, file?: string | undefined): SessionAccount {
  return parseStored(accountSchema, value, file, 'Session account is invalid.') as SessionAccount
}

function sanitizeChannel(channel: ChannelEntry): ChannelEntry {
  const stored = sanitizeStoredChannel(serializeEntry(channel))
  return deserializeEntry(stored)
}

function sanitizeStoredChannel(value: unknown, file?: string | undefined): StoredChannel {
  return parseStored(
    storedChannelSchema,
    value,
    file,
    'Stored session channel is invalid.',
  ) as StoredChannel
}

function parseSessionChallenge(value: unknown, file?: string | undefined): TempoSessionChallenge {
  const parsed = Challenge.Schema.safeParse(value)
  if (!parsed.success || !isTempoSessionChallenge(parsed.data))
    throw stateError(file, 'Stored session challenge is invalid.')
  return parsed.data
}

function sanitizeReceipt(
  value: unknown,
  channelId: string,
  file?: string | undefined,
): SessionReceipt {
  const receipt = parseStored(
    receiptSchema,
    value,
    file,
    'Stored session receipt is invalid.',
  ) as SessionReceipt
  if (receipt.channelId !== channelId.toLowerCase())
    throw stateError(file, 'Stored session receipt has a different channel ID.')
  if (receipt.reference.toLowerCase() !== channelId.toLowerCase())
    throw stateError(file, 'Stored session receipt has a different reference.')
  if (BigInt(receipt.spent) > BigInt(receipt.acceptedCumulative))
    throw stateError(file, 'Stored session receipt spend exceeds its accepted amount.')
  return receipt
}

function parseStoredSession(value: unknown, file: string): StoredManagedSession {
  const candidate = parseStored(storedSessionSchema, value, file, 'Stored session is invalid.')
  const { receipt: candidateReceipt, ...rest } = candidate
  const channel = candidate.channel as StoredChannel
  const account = candidate.account as SessionAccount
  if (account.address.toLowerCase() !== channel.descriptor.payer.toLowerCase())
    throw stateError(file, 'Stored session account does not match the channel payer.')
  const receipt = candidateReceipt
    ? sanitizeReceipt(candidateReceipt, channel.channelId, file)
    : undefined
  const spent = candidate.spent
  const cumulativeAmount = BigInt(channel.cumulativeAmount)
  if (BigInt(spent) > cumulativeAmount)
    throw stateError(file, 'Stored session spend exceeds its cumulative authorization.')
  if (receipt && BigInt(receipt.acceptedCumulative) > cumulativeAmount)
    throw stateError(file, 'Stored receipt exceeds the cumulative authorization.')
  if (Date.parse(candidate.updatedAt) < Date.parse(candidate.createdAt))
    throw stateError(file, 'Stored session timestamps are not monotonic.')
  const endpoint = sessionResourceUrl(candidate.endpoint, file)
  if (endpoint !== candidate.endpoint)
    throw stateError(file, 'Stored session endpoint contains a fragment.')
  const challenge = parseSessionChallenge(candidate.challenge, file)
  assertChallengeMatchesChannel(challenge, deserializeEntry(channel), file)
  return {
    ...rest,
    account,
    channel,
    endpoint,
    challenge,
    ...(receipt && { receipt }),
  }
}

function deserializeSession(record: StoredManagedSession): ManagedSession {
  return {
    version: sessionStateVersion,
    status: record.status,
    channel: deserializeEntry(record.channel),
    account: record.account,
    endpoint: record.endpoint,
    challenge: record.challenge,
    ...(record.receipt && { receipt: record.receipt }),
    spent: BigInt(record.spent),
    units: record.units,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function assertSameSession(
  previous: StoredManagedSession,
  input: SessionUpsert,
  file: string,
): void {
  const channel = sanitizeChannel(input.channel)
  const account = sanitizeAccount(input.account, file)
  const previousChannel = deserializeEntry(previous.channel)
  if (JSON.stringify(channelIdentity(channel)) !== JSON.stringify(channelIdentity(previousChannel)))
    throw stateError(file, 'Session update changed immutable channel identity.')
  if (account.address.toLowerCase() !== previous.account.address.toLowerCase())
    throw stateError(file, 'Session update changed the payer account.')
}

function channelIdentity(channel: ChannelEntry): object {
  return {
    channelId: channel.channelId.toLowerCase(),
    descriptor: Object.fromEntries(
      Object.entries(channel.descriptor).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.toLowerCase() : value,
      ]),
    ),
    escrow: channel.escrow.toLowerCase(),
    chainId: channel.chainId,
  }
}

function assertChallengeMatchesChannel(
  challenge: Challenge.Challenge,
  channel: ChannelEntry,
  file?: string | undefined,
): void {
  const payee = normalizeAddress(challenge.request.recipient, 'challenge recipient', file)
  const token = normalizeAddress(challenge.request.currency, 'challenge currency', file)
  if (payee !== channel.descriptor.payee.toLowerCase())
    throw stateError(file, 'Session challenge payee does not match the channel.')
  if (token !== channel.descriptor.token.toLowerCase())
    throw stateError(file, 'Session challenge token does not match the channel.')
  if (resolveEscrow(challenge).toLowerCase() !== channel.escrow.toLowerCase())
    throw stateError(file, 'Session challenge escrow does not match the channel.')
  if (isObject(challenge.request.methodDetails)) {
    const methodDetails = challenge.request.methodDetails
    if (methodDetails.chainId !== undefined && methodDetails.chainId !== channel.chainId)
      throw stateError(file, 'Session challenge chain does not match the channel.')
  }
}

function assertChannelScope(
  channel: ChannelEntry,
  scope: SessionScope,
  file?: string | undefined,
): void {
  const normalized = normalizeScope(scope)
  if (
    channel.descriptor.payer.toLowerCase() !== normalized.payer ||
    channel.descriptor.payee.toLowerCase() !== normalized.payee ||
    channel.descriptor.token.toLowerCase() !== normalized.token ||
    channel.escrow.toLowerCase() !== normalized.escrow ||
    channel.chainId !== normalized.chainId
  )
    throw stateError(file, 'Session channel does not match the selected payment scope.')
}

function selectLatestReceipt(
  previous: SessionReceipt | undefined,
  next: SessionReceipt | undefined,
): SessionReceipt | undefined {
  if (!previous) return next
  if (!next) return previous
  return Date.parse(next.timestamp) >= Date.parse(previous.timestamp) ? next : previous
}

function monotonicTimestamp(previous: string | undefined, next: Date, file: string): string {
  if (!Number.isFinite(next.getTime())) throw stateError(file, 'Session clock is invalid.')
  const nextTimestamp = next.toISOString()
  if (!previous || Date.parse(nextTimestamp) >= Date.parse(previous)) return nextTimestamp
  return previous
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((maximum, value) => (value > maximum ? value : maximum), 0n)
}

async function readJson(file: string): Promise<unknown | undefined> {
  let source: string
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw stateError(file, 'Unable to read session state.', error)
  }
  try {
    const value: unknown = JSON.parse(source)
    return value
  } catch (cause) {
    throw stateError(file, 'Session state contains invalid JSON.', cause)
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700)
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
    await syncDirectory(path.dirname(file))
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
    if (cause instanceof SessionStateError) throw cause
    throw stateError(file, 'Unable to write session state.', cause)
  }
}

async function createLock(file: string, owner: LockOwner): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await syncDirectory(path.dirname(file))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (handle) await fs.unlink(file).catch(() => undefined)
    throw error
  }
}

async function removeDeadLock(file: string, expected: LockOwner): Promise<void> {
  const claim = deadLockClaimFile(file)
  try {
    await fs.link(file, claim)
  } catch (error) {
    if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOENT')) return
    throw stateError(file, 'Unable to claim dead lock.', error)
  }

  try {
    const currentValue = await readJson(claim)
    if (currentValue === undefined) return
    const current = parseStored(lockOwnerSchema, currentValue, claim, 'Session lock is invalid.')
    if (current.token !== expected.token) return
    await removeFile(file, 'Unable to reclaim dead lock.')
  } finally {
    await removeFile(claim, 'Unable to release dead lock claim.')
  }
}

function deadLockClaimFile(file: string): string {
  return `${file}.reclaim`
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw stateError(file, 'Unable to inspect session lock.', error)
  }
}

async function removeOwnedLock(file: string, expected: LockOwner): Promise<void> {
  const currentValue = await readJson(file)
  if (currentValue === undefined) return
  const current = parseStored(lockOwnerSchema, currentValue, file, 'Session lock is invalid.')
  if (current.token !== expected.token) return
  await removeFile(file, 'Unable to release session lock.')
}

async function removeFile(file: string, message: string): Promise<void> {
  try {
    await fs.unlink(file)
    await syncDirectory(path.dirname(file))
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw stateError(file, message, error)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false
    if (hasCode(error, 'EPERM')) return true
    throw error
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function stateError(file: string | undefined, message: string, cause?: unknown): SessionStateError {
  return new SessionStateError(message, { ...(cause !== undefined && { cause }), file })
}
