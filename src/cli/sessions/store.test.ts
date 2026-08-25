import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Address, Hex } from 'viem'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))

import type * as Challenge from '../../Challenge.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { entryKey } from '../../tempo/session/client/ChannelStore.js'
import type { SessionReceipt } from '../../tempo/session/precompile/Protocol.js'
import sessions from './commands.js'
import {
  createSessionRegistry,
  SessionBusyError,
  SessionStateError,
  sessionScopeKey,
  toChannelStore,
  type SessionPersistenceContext,
  type SessionRegistry,
  type SessionScope,
} from './store.js'

const payer = '0x1111111111111111111111111111111111111111' as Address
const payee = '0x2222222222222222222222222222222222222222' as Address
const token = '0x3333333333333333333333333333333333333333' as Address
const escrow = '0x4444444444444444444444444444444444444444' as Address
const operator = '0x0000000000000000000000000000000000000000' as Address
const channelId = `0x${'aa'.repeat(32)}` as Hex
const mainnetChannelId = `0x${'bb'.repeat(32)}` as Hex

let temporaryDirectory: string
let stateRoot: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mppx-sessions-'))
  vi.stubEnv('XDG_STATE_HOME', temporaryDirectory)
  stateRoot = path.join(temporaryDirectory, 'mppx', 'sessions', 'v1')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(temporaryDirectory, { force: true, recursive: true })
})

function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    channelId,
    cumulativeAmount: 10n,
    deposit: 100n,
    descriptor: {
      payer,
      payee,
      operator,
      token,
      salt: `0x${'55'.repeat(32)}`,
      authorizedSigner: payer,
      expiringNonceHash: `0x${'66'.repeat(32)}`,
    },
    escrow,
    chainId: 42431,
    opened: true,
    ...overrides,
  }
}

function challenge(id = 'challenge-1', chainId = 42431): Challenge.Challenge {
  return {
    id,
    realm: 'api.example.test',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1',
      currency: token,
      recipient: payee,
      methodDetails: { chainId, escrowContract: escrow },
    },
  }
}

function receipt(overrides: Partial<SessionReceipt> = {}): SessionReceipt {
  return {
    method: 'tempo',
    intent: 'session',
    status: 'success',
    timestamp: '2026-07-16T00:01:00.000Z',
    reference: channelId,
    challengeId: 'challenge-1',
    channelId,
    acceptedCumulative: '10',
    spent: '2',
    units: 3,
    ...overrides,
  }
}

function scope(overrides: Partial<SessionScope> = {}): SessionScope {
  return { payer, payee, token, escrow, chainId: 42431, ...overrides }
}

function registryOptions(
  overrides: Parameters<typeof createSessionRegistry>[0] = {},
): Parameters<typeof createSessionRegistry>[0] {
  return { stateRoot, ...overrides }
}

async function serveSessions(argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  await sessions.serve(argv, {
    stdout(value: string) {
      output += value
    },
    exit(code: number) {
      exitCode = code
    },
  })
  return { exitCode, output }
}

async function seedCommandSessions(registry: SessionRegistry) {
  await registry.upsert({
    status: 'open',
    channel: channel({
      cumulativeAmount: 9_007_199_254_740_993_123_456_789n,
      deposit: 9_999_999_999_999_999_999_999_999n,
    }),
    account: { name: 'testnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=testnet&sql=select%201',
    challenge: challenge('testnet-challenge'),
    spent: 1_234_567_890_123_456_789n,
    units: 7,
  })
  await registry.upsert({
    status: 'closing',
    channel: channel({ channelId: mainnetChannelId, chainId: 4217, cumulativeAmount: 20n }),
    account: { name: 'mainnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=mainnet',
    challenge: challenge('mainnet-challenge', 4217),
    spent: 5n,
    units: 2,
  })
}

function commandRegistry() {
  const timestamps = [new Date('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:01:00.000Z')]
  return createSessionRegistry(registryOptions({ now: () => timestamps.shift()! }))
}

describe('createSessionRegistry', () => {
  test('uses XDG_STATE_HOME for the versioned state root', () => {
    const registry = createSessionRegistry()
    expect(registry.root).toBe(stateRoot)
  })

  test('persists sanitized state atomically with private permissions', async () => {
    const times = [new Date('2026-07-16T00:00:00.000Z'), new Date('2026-07-15T00:00:00.000Z')]
    const registry = createSessionRegistry(
      registryOptions({ now: () => times.shift() ?? new Date('2026-07-17T00:00:00.000Z') }),
    )
    const firstChannel = Object.assign(channel(), { privateKey: 'do-not-store' })
    const firstAccount = Object.assign(
      { name: 'testnet', address: payer },
      { privateKey: 'do-not-store' },
    )

    const first = await registry.upsert({
      status: 'opening',
      channel: firstChannel,
      account: firstAccount,
      endpoint: 'https://api.example.test/query?chainId=testnet&sql=select%201#response',
      challenge: challenge(),
      receipt: receipt(),
      spent: 2n,
      units: 3,
    })
    const second = await registry.upsert({
      status: 'open',
      channel: channel({ cumulativeAmount: 8n }),
      account: { address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet&sql=select%201#ignored',
      challenge: challenge('challenge-2'),
      spent: 1n,
      units: 1,
    })

    expect(first.endpoint).toBe('https://api.example.test/query?chainId=testnet&sql=select%201')
    expect(second).toMatchObject({
      status: 'open',
      account: { name: 'testnet', address: payer },
      spent: 2n,
      units: 3,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })
    expect(second.channel.cumulativeAmount).toBe(10n)
    expect(second.receipt).toEqual(receipt())

    const file = path.join(stateRoot, 'channels', `${channelId}.json`)
    const source = await fs.readFile(file, 'utf8')
    const stored: unknown = JSON.parse(source)
    expect(stored).toMatchObject({
      version: 1,
      method: 'tempo',
      intent: 'session',
      channel: { cumulativeAmount: '10', deposit: '100' },
      spent: '2',
      units: 3,
    })
    expect(source).not.toContain('privateKey')
    expect((await fs.stat(stateRoot)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(stateRoot, 'channels'))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(
      (await fs.readdir(path.join(stateRoot, 'channels'))).filter((name) => name.includes('.tmp-')),
    ).toEqual([])
  })

  test('manages preferred sessions and removes mappings before records', async () => {
    const registry = createSessionRegistry(registryOptions())
    await registry.upsert({
      status: 'open',
      channel: channel(),
      account: { name: 'testnet', address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet',
      challenge: challenge(),
    })

    await registry.setPreferred(scope(), channelId)
    expect(await registry.getPreferred(scope())).toBe(channelId)
    await registry.clearPreferred(scope(), `0x${'bb'.repeat(32)}`)
    expect(await registry.getPreferred(scope())).toBe(channelId)
    expect(await registry.list()).toEqual([
      expect.objectContaining({ channel: expect.objectContaining({ channelId }) }),
    ])
    await expect(
      registry.setPreferred(
        scope({ payee: '0x7777777777777777777777777777777777777777' }),
        channelId,
      ),
    ).rejects.toBeInstanceOf(SessionStateError)

    await registry.remove(channelId)
    expect(await registry.get(channelId)).toBeUndefined()
    expect(await registry.getPreferred(scope())).toBeUndefined()
  })

  test('does not overwrite a corrupt managed record', async () => {
    const file = path.join(stateRoot, 'channels', `${channelId}.json`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{invalid json')

    await expect(createSessionRegistry(registryOptions()).get(channelId)).rejects.toMatchObject({
      code: 'SESSION_STATE_INVALID',
      file,
    })
    await expect(
      createSessionRegistry(registryOptions()).upsert({
        status: 'open',
        channel: channel(),
        account: { address: payer },
        endpoint: 'https://api.example.test/query',
        challenge: challenge(),
      }),
    ).rejects.toBeInstanceOf(SessionStateError)
    expect(await fs.readFile(file, 'utf8')).toBe('{invalid json')
  })

  test('rejects live and remote locks, then reclaims a dead same-host lock', async () => {
    const first = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 101, isProcessAlive: () => true }),
    )
    const live = await first.acquire(scope())
    const contender = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 202, isProcessAlive: (pid) => pid === 101 }),
    )

    await expect(contender.acquire(scope())).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      exitCode: 75,
      scope: sessionScopeKey(scope()),
      owner: { hostname: 'host-a', pid: 101 },
    })
    await live.release()

    const deadOwner = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 303, isProcessAlive: () => true }),
    )
    const abandoned = await deadOwner.acquire(scope())
    const reclaimer = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 404, isProcessAlive: () => false }),
    )
    const reclaimed = await reclaimer.acquire(scope())
    await abandoned.release()
    const observer = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 405, isProcessAlive: () => true }),
    )
    await expect(observer.acquire(scope())).rejects.toBeInstanceOf(SessionBusyError)
    await reclaimed.release()

    const remoteOwner = createSessionRegistry(
      registryOptions({ hostname: 'host-b', pid: 505, isProcessAlive: () => true }),
    )
    const remote = await remoteOwner.acquire(scope())
    await expect(reclaimer.acquire(scope())).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      owner: { hostname: 'host-b', pid: 505 },
    })
    await remote.release()
  })

  test('allows only one concurrent dead-lock reclaimer to acquire', async () => {
    const deadOwner = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 101, isProcessAlive: () => true }),
    )
    await deadOwner.acquire(scope())
    const [lockName] = await fs.readdir(path.join(stateRoot, 'locks'))
    if (!lockName) throw new Error('Expected a lock file.')
    const lock = path.join(stateRoot, 'locks', lockName)
    const stale = JSON.parse(await fs.readFile(lock, 'utf8')) as { token: string }

    let unsafeUnlinks = 0
    let releaseFirstUnlink: (() => void) | undefined
    const secondUnlink = new Promise<void>((resolve) => {
      releaseFirstUnlink = resolve
    })
    const { unlink } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file) !== lock) return unlink(file)
      try {
        await fs.access(`${lock}.reclaim`)
        return unlink(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      unsafeUnlinks++
      if (unsafeUnlinks === 1) {
        await secondUnlink
        return unlink(file)
      }
      if (unsafeUnlinks === 2) {
        releaseFirstUnlink?.()
        await vi.waitUntil(
          async () => {
            try {
              const current = JSON.parse(await fs.readFile(lock, 'utf8')) as { token: string }
              return current.token !== stale.token
            } catch {
              return false
            }
          },
          { interval: 1, timeout: 1_000 },
        )
      }
      return unlink(file)
    })

    const isProcessAlive = (pid: number) => pid === 202 || pid === 303
    const first = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 202, isProcessAlive }),
    )
    const second = createSessionRegistry(
      registryOptions({ hostname: 'host-a', pid: 303, isProcessAlive }),
    )
    try {
      const results = await Promise.allSettled([first.acquire(scope()), second.acquire(scope())])
      unlinkSpy.mockRestore()
      const acquired = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>> =>
          result.status === 'fulfilled',
      )
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      expect(acquired).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(SessionBusyError)
      await acquired[0]?.value.release()
    } finally {
      unlinkSpy.mockRestore()
    }
  })
})

describe('toChannelStore', () => {
  test('uses preferred open sessions and never reuses opening sessions', async () => {
    const registry = createSessionRegistry(registryOptions())
    let status: SessionPersistenceContext['status'] = 'opening'
    const context = (): SessionPersistenceContext => ({
      status,
      account: { name: 'testnet', address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet',
      challenge: challenge(),
    })
    const store = toChannelStore(registry, { scope: scope(), selection: 'new', context })

    expect(await store.get(entryKey(channel()))).toBeUndefined()
    await store.set(channel())
    expect((await registry.get(channelId))?.status).toBe('opening')
    expect(await registry.getPreferred(scope())).toBe(channelId)
    expect(await store.get(entryKey(channel()))).toBeUndefined()

    await store.delete(entryKey(channel()))
    expect((await registry.get(channelId))?.status).toBe('stale')
    expect(await registry.getPreferred(scope())).toBeUndefined()

    status = 'open'
    const reopened = toChannelStore(registry, { scope: scope(), selection: 'new', context })
    await reopened.set(channel())
    const automatic = toChannelStore(registry, { scope: scope(), selection: 'auto', context })
    expect(await automatic.get(entryKey(channel()))).toEqual(channel())
  })

  test('retains closing state when the manager deletes after creating a close credential', async () => {
    const registry = createSessionRegistry(registryOptions())
    let status: SessionPersistenceContext['status'] = 'open'
    const context = (): SessionPersistenceContext => ({
      status,
      account: { address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet',
      challenge: challenge(),
      spent: 4n,
      units: 5,
    })
    const store = toChannelStore(registry, { scope: scope(), selection: 'new', context })
    await store.set(channel())
    status = 'closing'

    await store.delete(entryKey(channel()))

    expect(await registry.get(channelId)).toMatchObject({
      status: 'closing',
      spent: 4n,
      units: 5,
    })
    expect(await registry.getPreferred(scope())).toBe(channelId)
  })

  test('resets persistence context when a rejected channel is replaced', async () => {
    const registry = createSessionRegistry(registryOptions())
    await registry.upsert({
      status: 'open',
      channel: channel(),
      account: { address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet',
      challenge: challenge(),
      receipt: receipt(),
      spent: 2n,
      units: 3,
    })
    await registry.setPreferred(scope(), channelId)

    let status: SessionPersistenceContext['status'] = 'open'
    let latestReceipt: SessionReceipt | undefined = receipt()
    let spent = 2n
    let units = 3
    const context = (): SessionPersistenceContext => ({
      status,
      account: { address: payer },
      endpoint: 'https://api.example.test/query?chainId=testnet',
      challenge: challenge(),
      ...(latestReceipt && { receipt: latestReceipt }),
      spent,
      units,
    })
    const store = toChannelStore(registry, {
      scope: scope(),
      selection: 'auto',
      context,
      onNewChannel() {
        status = 'opening'
        latestReceipt = undefined
        spent = 0n
        units = 0
      },
    })
    expect(await store.get(entryKey(channel()))).toEqual(channel())
    await store.delete(entryKey(channel()))

    const replacementId = `0x${'bb'.repeat(32)}` as Hex
    await store.set(channel({ channelId: replacementId }))

    expect(await registry.get(channelId)).toMatchObject({ status: 'stale', spent: 2n, units: 3 })
    expect(await registry.get(replacementId)).toMatchObject({
      status: 'opening',
      spent: 0n,
      units: 0,
    })
    expect((await registry.get(replacementId))?.receipt).toBeUndefined()
  })
})

describe('session commands', () => {
  test('list and view return stable JSON projections with filters', async () => {
    await seedCommandSessions(commandRegistry())

    const listed = JSON.parse((await serveSessions(['list', '--json'])).output)
    expect(listed.sessions).toEqual([
      {
        status: 'open',
        channelId,
        account: 'testnet-payer',
        payer,
        payee,
        authorizedSigner: payer,
        token,
        escrow,
        chainId: 42431,
        cumulativeAmount: '9007199254740993123456789',
        confirmedSpend: '1234567890123456789',
        deposit: '9999999999999999999999999',
        units: 7,
        resourceUrl: 'https://api.example.test/query?chainId=testnet&sql=select%201',
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      },
      expect.objectContaining({
        status: 'closing',
        channelId: mainnetChannelId,
        account: 'mainnet-payer',
        chainId: 4217,
        cumulativeAmount: '20',
        confirmedSpend: '5',
      }),
    ])

    const viewed = await serveSessions(['view', channelId, '--json'])
    const byAccount = await serveSessions(['list', '--account', 'testnet-payer', '--json'])
    const byNetwork = await serveSessions(['list', '--network', 'mainnet', '--json'])
    const mismatch = await serveSessions([
      'list',
      '--account',
      'testnet-payer',
      '--network',
      'mainnet',
      '--json',
    ])
    expect(JSON.parse(viewed.output)).toEqual(listed.sessions[0])
    expect(JSON.parse(byAccount.output).sessions).toMatchObject([{ channelId }])
    expect(JSON.parse(byNetwork.output).sessions).toMatchObject([{ channelId: mainnetChannelId }])
    expect(JSON.parse(mismatch.output)).toEqual({ sessions: [] })
  })

  test('view rejects a missing channel', async () => {
    const missing = `0x${'cc'.repeat(32)}`
    const result = await serveSessions(['view', missing, '--json'])
    expect(result).toMatchObject({ exitCode: 2 })
    expect(result.output).toContain(`Session ${missing} was not found.`)
  })

  test('close all reports failures in session order', async () => {
    await seedCommandSessions(commandRegistry())
    vi.stubEnv('MPPX_PRIVATE_KEY', `0x${'11'.repeat(32)}`)
    const originalExitCode = process.exitCode
    const originalWrite = process.stderr.write
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      const result = await serveSessions(['close', '--all', '--yes', '--json'])
      const output = JSON.parse(result.output)
      expect(output.closed).toEqual([])
      expect(output.failed.map((failure: { channelId: string }) => failure.channelId)).toEqual([
        channelId,
        mainnetChannelId,
      ])
      expect(process.exitCode).toBe(1)
      expect(stderr).toContain(channelId)
      expect(stderr).toContain(mainnetChannelId)
    } finally {
      process.exitCode = originalExitCode
      process.stderr.write = originalWrite
    }
  })
})
