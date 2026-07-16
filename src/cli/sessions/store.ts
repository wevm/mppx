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
import { isSessionReceipt, type SessionReceipt } from '../../tempo/session/precompile/Protocol.js'

const sessionStateVersion = 1 as const
const sessionStatuses = new Set<SessionStatus>(['opening', 'open', 'closing', 'stale'])
const channelIdPattern = /^0x[0-9a-fA-F]{64}$/
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const amountPattern = /^\d+$/

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
  challenge: Challenge.Challenge
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

type StoredManagedSession = {
  version: typeof sessionStateVersion
  method: 'tempo'
  intent: 'session'
  status: SessionStatus
  channel: StoredChannel
  account: SessionAccount
  endpoint: string
  challenge: Challenge.Challenge
  receipt?: SessionReceipt | undefined
  spent: string
  units: number
  createdAt: string
  updatedAt: string
}

type PreferredIndex = {
  version: typeof sessionStateVersion
  sessions: Record<string, Hex>
}

type LockOwner = {
  version: typeof sessionStateVersion
  scope: string
  hostname: string
  pid: number
  token: string
  createdAt: string
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

/** Creates a filesystem-backed CLI session registry. */
export function createSessionRegistry(options: CreateSessionRegistryOptions = {}): SessionRegistry {
  const root = options.stateRoot ?? sessionStateRoot()
  const paths: RegistryPaths = {
    root,
    channels: path.join(root, 'channels'),
    locks: path.join(root, 'locks'),
    preferred: path.join(root, 'preferred.json'),
  }
  const hostname = options.hostname ?? os.hostname()
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const isProcessAlive = options.isProcessAlive ?? processIsAlive

  async function ensureDirectories(): Promise<void> {
    for (const directory of [paths.root, paths.channels, paths.locks]) {
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
      status: parseStatus(input.status, file),
      channel: storedChannel,
      account: {
        ...(account.name !== undefined
          ? { name: account.name }
          : previous?.account.name !== undefined
            ? { name: previous.account.name }
            : {}),
        address: account.address,
      },
      endpoint: sanitizeEndpoint(input.endpoint, file),
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

  async function readPreferred(): Promise<PreferredIndex> {
    const value = await readJson(paths.preferred)
    if (value === undefined) return { version: sessionStateVersion, sessions: {} }
    return parsePreferredIndex(value, paths.preferred)
  }

  async function mutatePreferred(update: (index: PreferredIndex) => boolean): Promise<void> {
    const lock = await acquireKey('preferred-index')
    try {
      const index = await readPreferred()
      if (update(index)) await writeJsonAtomic(paths.preferred, index)
    } finally {
      await lock.release()
    }
  }

  async function getPreferred(scope: SessionScope): Promise<Hex | undefined> {
    const key = sessionScopeKey(scope)
    const channelId = (await readPreferred()).sessions[key]
    if (!channelId) return undefined
    const record = await get(channelId)
    if (!record) throw stateError(paths.preferred, `Preferred session ${channelId} does not exist.`)
    assertRecordScope(record, scope, paths.preferred)
    return channelId
  }

  async function setPreferred(scope: SessionScope, channelId: string): Promise<void> {
    const normalizedId = normalizeChannelId(channelId)
    const record = await get(normalizedId)
    if (!record) throw stateError(paths.preferred, `Session ${normalizedId} does not exist.`)
    assertRecordScope(record, scope, paths.preferred)
    const key = sessionScopeKey(scope)
    await mutatePreferred((index) => {
      if (index.sessions[key]?.toLowerCase() === normalizedId) return false
      index.sessions[key] = normalizedId as Hex
      return true
    })
  }

  async function clearPreferred(
    scope: SessionScope,
    channelId?: string | undefined,
  ): Promise<void> {
    const key = sessionScopeKey(scope)
    const normalizedId = channelId === undefined ? undefined : normalizeChannelId(channelId)
    await mutatePreferred((index) => {
      const current = index.sessions[key]
      if (!current || (normalizedId && current.toLowerCase() !== normalizedId)) return false
      delete index.sessions[key]
      return true
    })
  }

  async function remove(channelId: string): Promise<void> {
    const normalizedId = normalizeChannelId(channelId)
    const record = await get(normalizedId)
    if (!record) return
    await mutatePreferred((index) => {
      let changed = false
      for (const [key, value] of Object.entries(index.sessions)) {
        if (value.toLowerCase() !== normalizedId) continue
        delete index.sessions[key]
        changed = true
      }
      return changed
    })
    const file = channelFile(paths, normalizedId)
    try {
      await fs.unlink(file)
      await syncDirectory(paths.channels)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw stateError(file, 'Unable to remove session.', error)
    }
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
        return {
          async release() {
            const currentValue = await readJson(file)
            if (currentValue === undefined) return
            const current = parseLockOwner(currentValue, file)
            if (current.token !== owner.token) return
            try {
              await fs.unlink(file)
              await syncDirectory(paths.locks)
            } catch (error) {
              if (!hasCode(error, 'ENOENT'))
                throw stateError(file, 'Unable to release session lock.', error)
            }
          },
        }
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
      }

      const value = await readJson(file)
      if (value === undefined) continue
      const current = parseLockOwner(value, file)
      if (current.scope !== scope) throw stateError(file, 'Session lock scope is invalid.')
      if (current.hostname !== hostname || isProcessAlive(current.pid))
        throw new SessionBusyError(scope, current)
      await removeDeadLock(file, current)
    }
    const value = await readJson(file)
    if (value === undefined) throw stateError(file, 'Unable to acquire session lock.')
    const owner = parseLockOwner(value, file)
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
    assertRecordScope(record, options.scope)
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

function normalizeChannelId(channelId: string): string {
  if (!channelIdPattern.test(channelId))
    throw new SessionStateError(`Invalid session channel ID: ${channelId}.`)
  return channelId.toLowerCase()
}

function normalizeAddress(value: unknown, label: string, file?: string | undefined): Address {
  if (typeof value !== 'string' || !addressPattern.test(value))
    throw new SessionStateError(`Invalid ${label}.`, { file })
  return value.toLowerCase() as Address
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

function sanitizeEndpoint(endpoint: unknown, file?: string | undefined): string {
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
  if (!isObject(value)) throw stateError(file, 'Session account is invalid.')
  if (value.name !== undefined && typeof value.name !== 'string')
    throw stateError(file, 'Session account name is invalid.')
  return {
    ...(typeof value.name === 'string' && { name: value.name }),
    address: normalizeAddress(value.address, 'session account address', file),
  }
}

function sanitizeChannel(channel: ChannelEntry): ChannelEntry {
  const stored = sanitizeStoredChannel(serializeEntry(channel))
  return deserializeEntry(stored)
}

function sanitizeStoredChannel(value: unknown, file?: string | undefined): StoredChannel {
  if (!isObject(value)) throw stateError(file, 'Stored session channel is invalid.')
  if (!isObject(value.descriptor)) throw stateError(file, 'Stored channel descriptor is invalid.')
  const descriptor = value.descriptor
  const channelId = normalizeChannelId(readString(value.channelId, 'channel ID', file)) as Hex
  const cumulativeAmount = readAmount(value.cumulativeAmount, 'cumulative amount', file)
  const deposit = readAmount(value.deposit, 'deposit', file)
  if (!Number.isSafeInteger(value.chainId) || (value.chainId as number) < 0)
    throw stateError(file, 'Stored channel chain ID is invalid.')
  if (typeof value.opened !== 'boolean')
    throw stateError(file, 'Stored channel open state is invalid.')
  return {
    channelId,
    cumulativeAmount,
    deposit,
    descriptor: {
      payer: normalizeAddress(descriptor.payer, 'channel payer', file),
      payee: normalizeAddress(descriptor.payee, 'channel payee', file),
      operator: normalizeAddress(descriptor.operator, 'channel operator', file),
      token: normalizeAddress(descriptor.token, 'channel token', file),
      salt: readHash(descriptor.salt, 'channel salt', file),
      authorizedSigner: normalizeAddress(
        descriptor.authorizedSigner,
        'channel authorized signer',
        file,
      ),
      expiringNonceHash: readHash(
        descriptor.expiringNonceHash,
        'channel expiring nonce hash',
        file,
      ),
    },
    escrow: normalizeAddress(value.escrow, 'channel escrow', file),
    chainId: value.chainId as number,
    opened: value.opened,
  }
}

function parseSessionChallenge(value: unknown, file?: string | undefined): Challenge.Challenge {
  const parsed = Challenge.Schema.safeParse(value)
  if (!parsed.success || parsed.data.method !== 'tempo' || parsed.data.intent !== 'session')
    throw stateError(file, 'Stored session challenge is invalid.')
  return parsed.data
}

function sanitizeReceipt(
  value: unknown,
  channelId: string,
  file?: string | undefined,
): SessionReceipt {
  if (!isSessionReceipt(value)) throw stateError(file, 'Stored session receipt is invalid.')
  if (value.channelId.toLowerCase() !== channelId.toLowerCase())
    throw stateError(file, 'Stored session receipt has a different channel ID.')
  if (value.reference.toLowerCase() !== channelId.toLowerCase())
    throw stateError(file, 'Stored session receipt has a different reference.')
  readAmount(value.acceptedCumulative, 'receipt accepted cumulative amount', file)
  readAmount(value.spent, 'receipt spent amount', file)
  if (BigInt(value.spent) > BigInt(value.acceptedCumulative))
    throw stateError(file, 'Stored session receipt spend exceeds its accepted amount.')
  if (value.units !== undefined && (!Number.isSafeInteger(value.units) || value.units < 0))
    throw stateError(file, 'Stored session receipt units are invalid.')
  if (!isTimestamp(value.timestamp)) throw stateError(file, 'Stored receipt timestamp is invalid.')
  return {
    method: 'tempo',
    intent: 'session',
    status: 'success',
    timestamp: value.timestamp,
    reference: value.reference,
    challengeId: value.challengeId,
    channelId: normalizeChannelId(value.channelId) as Hex,
    acceptedCumulative: value.acceptedCumulative,
    spent: value.spent,
    ...(value.units !== undefined && { units: value.units }),
    ...(value.txHash !== undefined && {
      txHash: readHash(value.txHash, 'receipt transaction hash', file),
    }),
  }
}

function parseStoredSession(value: unknown, file: string): StoredManagedSession {
  if (!isObject(value)) throw stateError(file, 'Stored session is not an object.')
  if (value.version !== sessionStateVersion)
    throw stateError(file, 'Stored session version is unsupported.')
  if (value.method !== 'tempo' || value.intent !== 'session')
    throw stateError(file, 'Stored session method is invalid.')
  const channel = sanitizeStoredChannel(value.channel, file)
  const account = sanitizeAccount(value.account, file)
  if (account.address.toLowerCase() !== channel.descriptor.payer.toLowerCase())
    throw stateError(file, 'Stored session account does not match the channel payer.')
  const receipt = value.receipt
    ? sanitizeReceipt(value.receipt, channel.channelId, file)
    : undefined
  const spent = readAmount(value.spent, 'session spent amount', file)
  const cumulativeAmount = BigInt(channel.cumulativeAmount)
  if (BigInt(spent) > cumulativeAmount)
    throw stateError(file, 'Stored session spend exceeds its cumulative authorization.')
  if (receipt && BigInt(receipt.acceptedCumulative) > cumulativeAmount)
    throw stateError(file, 'Stored receipt exceeds the cumulative authorization.')
  if (!Number.isSafeInteger(value.units) || (value.units as number) < 0)
    throw stateError(file, 'Stored session units are invalid.')
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt))
    throw stateError(file, 'Stored session timestamps are invalid.')
  if (Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string))
    throw stateError(file, 'Stored session timestamps are not monotonic.')
  const endpoint = sanitizeEndpoint(value.endpoint, file)
  if (endpoint !== value.endpoint)
    throw stateError(file, 'Stored session endpoint contains a fragment.')
  const challenge = parseSessionChallenge(value.challenge, file)
  assertChallengeMatchesChannel(challenge, deserializeEntry(channel), file)
  return {
    version: sessionStateVersion,
    method: 'tempo',
    intent: 'session',
    status: parseStatus(value.status, file),
    channel,
    account,
    endpoint,
    challenge,
    ...(receipt && { receipt }),
    spent,
    units: value.units as number,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
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

function parsePreferredIndex(value: unknown, file: string): PreferredIndex {
  if (!isObject(value) || value.version !== sessionStateVersion || !isObject(value.sessions))
    throw stateError(file, 'Preferred session index is invalid.')
  const sessions: Record<string, Hex> = {}
  for (const [key, channelId] of Object.entries(value.sessions)) {
    if (!isScopeKey(key)) throw stateError(file, `Preferred session scope ${key} is invalid.`)
    sessions[key] = normalizeChannelId(readString(channelId, 'preferred channel ID', file)) as Hex
  }
  return { version: sessionStateVersion, sessions }
}

function parseLockOwner(value: unknown, file: string): LockOwner {
  if (!isObject(value) || value.version !== sessionStateVersion)
    throw stateError(file, 'Session lock is invalid.')
  if (
    typeof value.scope !== 'string' ||
    typeof value.hostname !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.token !== 'string' ||
    !isTimestamp(value.createdAt)
  )
    throw stateError(file, 'Session lock is invalid.')
  return {
    version: sessionStateVersion,
    scope: value.scope,
    hostname: value.hostname,
    pid: value.pid as number,
    token: value.token,
    createdAt: value.createdAt,
  }
}

function parseStatus(value: unknown, file?: string | undefined): SessionStatus {
  if (typeof value !== 'string' || !sessionStatuses.has(value as SessionStatus))
    throw stateError(file, 'Session status is invalid.')
  return value as SessionStatus
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

function assertChannelScope(channel: ChannelEntry, scope: SessionScope): void {
  const normalized = normalizeScope(scope)
  if (
    channel.descriptor.payer.toLowerCase() !== normalized.payer ||
    channel.descriptor.payee.toLowerCase() !== normalized.payee ||
    channel.descriptor.token.toLowerCase() !== normalized.token ||
    channel.escrow.toLowerCase() !== normalized.escrow ||
    channel.chainId !== normalized.chainId
  )
    throw new SessionStateError('Session channel does not match the selected payment scope.')
}

function assertRecordScope(
  record: ManagedSession,
  scope: SessionScope,
  file?: string | undefined,
): void {
  try {
    assertChannelScope(record.channel, scope)
  } catch (cause) {
    throw stateError(file, 'Preferred session does not match its payment scope.', cause)
  }
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

function isScopeKey(value: string): boolean {
  const parts = value.split(':')
  if (parts.length !== 5) return false
  const chainId = Number(parts[4])
  return (
    value === value.toLowerCase() &&
    addressPattern.test(parts[0] ?? '') &&
    addressPattern.test(parts[1] ?? '') &&
    addressPattern.test(parts[2] ?? '') &&
    addressPattern.test(parts[3] ?? '') &&
    /^\d+$/.test(parts[4] ?? '') &&
    Number.isSafeInteger(chainId) &&
    chainId >= 0
  )
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
  const currentValue = await readJson(file)
  if (currentValue === undefined) return
  const current = parseLockOwner(currentValue, file)
  if (current.token !== expected.token) return
  try {
    await fs.unlink(file)
    await syncDirectory(path.dirname(file))
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw stateError(file, 'Unable to reclaim dead lock.', error)
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

function readString(value: unknown, label: string, file?: string | undefined): string {
  if (typeof value !== 'string') throw stateError(file, `Stored ${label} is invalid.`)
  return value
}

function readAmount(value: unknown, label: string, file?: string | undefined): string {
  if (typeof value !== 'string' || !amountPattern.test(value))
    throw stateError(file, `Stored ${label} is invalid.`)
  return value
}

function readHash(value: unknown, label: string, file?: string | undefined): Hex {
  if (typeof value !== 'string' || !channelIdPattern.test(value))
    throw stateError(file, `Stored ${label} is invalid.`)
  return value.toLowerCase() as Hex
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
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
