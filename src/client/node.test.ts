import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoDevnet } from 'viem/chains'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../Challenge.js'
import * as Constants from '../Constants.js'
import * as Credential from '../Credential.js'
import type { ChannelEntry } from '../tempo/session/client/ChannelOps.js'
import { entryKey } from '../tempo/session/client/ChannelStore.js'
import * as Chain from '../tempo/session/precompile/Chain.js'
import * as SessionChannel from '../tempo/session/precompile/Channel.js'
import { escrowAbi } from '../tempo/session/precompile/escrow.abi.js'
import {
  createSessionAdministration,
  createSqliteChannelStore,
  defaultChannelDatabasePath,
} from './node.js'

const channel: ChannelEntry = {
  channelId: `0x${'11'.repeat(32)}`,
  cumulativeAmount: 2_000_000n,
  deposit: 10_000_000n,
  descriptor: {
    authorizedSigner: '0x0000000000000000000000000000000000000001',
    expiringNonceHash: `0x${'22'.repeat(32)}`,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000002',
    payer: '0x0000000000000000000000000000000000000003',
    salt: `0x${'33'.repeat(32)}`,
    token: '0x0000000000000000000000000000000000000004',
  },
  escrow: '0x0000000000000000000000000000000000000005',
  chainId: 4217,
  opened: true,
}

describe('SQLite ChannelStore', () => {
  test('defaults to the shared Tempo wallet channels database', () => {
    expect(defaultChannelDatabasePath()).toBe(join(homedir(), '.tempo', 'wallet', 'channels.db'))
  })

  test('persists a namespaced channel across fresh client instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-channels-'))
    const path = join(directory, 'channels.db')
    try {
      const first = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      first.set(channel)
      first.close()

      const second = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      expect(second.get(entryKey(channel))).toEqual(channel)
      expect(second.latestAuthorizedSigner()).toBe(channel.descriptor.authorizedSigner)
      second.set({ ...channel, cumulativeAmount: 1_000_000n, deposit: 5_000_000n })
      expect(second.get(entryKey(channel))).toMatchObject({
        cumulativeAmount: 2_000_000n,
        deposit: 10_000_000n,
      })
      second.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('isolates identical payment scopes for different payers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-channel-payers-'))
    const path = join(directory, 'channels.db')
    const other = {
      ...channel,
      channelId: `0x${'44'.repeat(32)}` as const,
      descriptor: {
        ...channel.descriptor,
        payer: '0x0000000000000000000000000000000000000006' as const,
        salt: `0x${'55'.repeat(32)}` as const,
      },
    }
    try {
      const first = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      const second = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: other.descriptor.payer,
      })
      first.set(channel)
      second.set(other)

      expect(first.get(entryKey(channel))).toEqual(channel)
      expect(second.get(entryKey(other))).toEqual(other)
      expect(first.listSessions()).toHaveLength(1)
      expect(second.listSessions()).toHaveLength(1)
      expect(first.listSessions({ payer: other.descriptor.payer })).toEqual([])
      first.close()
      second.close()

      const database = new DatabaseSync(path)
      expect(
        (
          database
            .prepare("SELECT count(*) AS count FROM channels WHERE state = 'active'")
            .get() as {
            count: number
          }
        ).count,
      ).toBe(2)
      database.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('retains superseded channels for explicit selection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-channel-preference-'))
    const path = join(directory, 'channels.db')
    const newer = {
      ...channel,
      channelId: `0x${'44'.repeat(32)}` as const,
      descriptor: { ...channel.descriptor, salt: `0x${'55'.repeat(32)}` as const },
    }
    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      store.set(channel)
      store.set(newer)

      expect(store.get(entryKey(channel))).toEqual(newer)
      expect(store.getChannel(channel.channelId)).toEqual(channel)
      expect(store.listSessions()).toHaveLength(2)
      store.close()

      const reopened = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      expect(reopened.get(entryKey(channel))).toEqual(newer)
      expect(reopened.getChannel(channel.channelId)).toEqual(channel)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('serializes the same payer and payment scope across processes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-channel-lock-'))
    const path = join(directory, 'channels.db')
    const first = createSqliteChannelStore({
      namespace: 'https://api.example.com',
      path,
      payer: channel.descriptor.payer,
    })
    const second = createSqliteChannelStore({
      namespace: 'https://api.example.com',
      path,
      payer: channel.descriptor.payer,
    })
    try {
      const firstLock = await first.acquire(entryKey(channel))
      let acquired = false
      const secondLock = second.acquire(entryKey(channel)).then((lock) => {
        acquired = true
        return lock
      })
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(acquired).toBe(false)

      firstLock.release()
      const lock = await secondLock
      expect(acquired).toBe(true)
      lock.release()
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true })
    }
  })

  test('rehydrates an existing wallet-cli v2 channel row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-wallet-channels-'))
    const path = join(directory, 'channels.db')
    try {
      const database = new DatabaseSync(path)
      database.exec(`CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL,
        request_url TEXT NOT NULL DEFAULT '',
        chain_id INTEGER NOT NULL,
        escrow_contract TEXT NOT NULL,
        token TEXT NOT NULL,
        payee TEXT NOT NULL,
        payer TEXT NOT NULL,
        authorized_signer TEXT NOT NULL,
        salt TEXT NOT NULL,
        deposit TEXT NOT NULL,
        cumulative_amount TEXT NOT NULL,
        challenge_echo TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        close_requested_at INTEGER NOT NULL DEFAULT 0,
        grace_ready_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        accepted_cumulative TEXT NOT NULL DEFAULT '0',
        server_spent TEXT NOT NULL DEFAULT '0',
        session_protocol TEXT NOT NULL DEFAULT 'v1',
        descriptor_json TEXT
      )`)
      const insert = database.prepare(`INSERT INTO channels (
          channel_id, origin, chain_id, escrow_contract, token, payee, payer,
          authorized_signer, salt, deposit, cumulative_amount, challenge_echo,
          state, created_at, last_used_at, session_protocol, descriptor_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', 1, 1, 'v2', ?)`)
      insert.run(
        channel.channelId,
        'https://api.example.com',
        channel.chainId,
        channel.escrow,
        channel.descriptor.token,
        channel.descriptor.payee,
        channel.descriptor.payer,
        channel.descriptor.authorizedSigner,
        channel.descriptor.salt,
        channel.deposit.toString(),
        channel.cumulativeAmount.toString(),
        JSON.stringify(channel.descriptor),
      )
      const otherPayer = '0x0000000000000000000000000000000000000006' as const
      const otherDescriptor = {
        ...channel.descriptor,
        payer: otherPayer,
        salt: `0x${'55'.repeat(32)}` as const,
      }
      insert.run(
        `0x${'44'.repeat(32)}`,
        'https://api.example.com',
        channel.chainId,
        channel.escrow,
        channel.descriptor.token,
        channel.descriptor.payee,
        otherPayer,
        channel.descriptor.authorizedSigner,
        otherDescriptor.salt,
        channel.deposit.toString(),
        channel.cumulativeAmount.toString(),
        JSON.stringify(otherDescriptor),
      )
      database.exec('UPDATE channels SET version = 2')
      database.close()

      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      expect(store.get(entryKey(channel))).toEqual(channel)
      store.close()

      const otherStore = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: otherPayer,
      })
      expect(otherStore.get(entryKey(channel))).toMatchObject({
        channelId: `0x${'44'.repeat(32)}`,
        descriptor: { payer: otherPayer },
      })
      otherStore.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('uses shared scalar columns after another client updates an MPPx row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-wallet-update-'))
    const path = join(directory, 'channels.db')
    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      store.set(channel)
      store.close()

      const database = new DatabaseSync(path)
      database
        .prepare(`UPDATE channels
          SET entry_json = ?, cumulative_amount = ?, deposit = ?
          WHERE channel_id = ?`)
        .run(
          JSON.stringify({
            ...channel,
            cumulativeAmount: channel.cumulativeAmount.toString(),
            deposit: channel.deposit.toString(),
          }),
          '3000000',
          '12000000',
          channel.channelId,
        )
      database.close()

      const reopened = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
      })
      expect(reopened.getChannel(channel.channelId)).toMatchObject({
        cumulativeAmount: 3_000_000n,
        deposit: 12_000_000n,
      })
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('uses the same rows for request persistence and session administration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-administration-'))
    const path = join(directory, 'channels.db')
    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: channel.descriptor.payer,
        requestUrl: 'https://api.example.com/v1/responses',
      })
      store.set(channel)

      expect(store.listSessions({ chainId: 4217, payer: channel.descriptor.payer })).toEqual([
        expect.objectContaining({
          acceptedCumulative: 0n,
          entry: channel,
          origin: 'https://api.example.com',
          requestUrl: 'https://api.example.com/v1/responses',
          state: 'active',
        }),
      ])

      store.updateSessionState(channel.channelId, 'closing', {
        closeRequestedAt: 10,
        graceReadyAt: 20,
      })
      expect(store.listSessions()[0]).toMatchObject({
        closeRequestedAt: 10,
        graceReadyAt: 20,
        state: 'closing',
      })

      const record = store.listSessions()[0]!
      store.setSession({
        ...record,
        acceptedCumulative: 1_500_000n,
        entry: { ...record.entry, cumulativeAmount: 3_000_000n },
        state: 'finalizable',
      })
      expect(store.listSessions()[0]).toMatchObject({
        acceptedCumulative: 1_500_000n,
        entry: { cumulativeAmount: 3_000_000n },
        state: 'finalizable',
      })

      store.deleteChannel(channel.channelId)
      expect(store.listSessions()).toEqual([])
      store.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('retains every recovered orphan even when payment scopes match', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-orphans-'))
    const path = join(directory, 'channels.db')
    try {
      const store = createSqliteChannelStore({ path, payer: channel.descriptor.payer })
      const base = {
        acceptedCumulative: 0n,
        closeRequestedAt: 0,
        createdAt: 1,
        entry: channel,
        graceReadyAt: 0,
        lastUsedAt: 1,
        origin: '',
        requestUrl: '',
        state: 'orphaned',
      } as const
      store.setSession(base)
      store.setSession({
        ...base,
        entry: {
          ...channel,
          channelId: `0x${'44'.repeat(32)}`,
          descriptor: { ...channel.descriptor, salt: `0x${'55'.repeat(32)}` },
        },
      })

      expect(store.listSessions()).toHaveLength(2)
      store.close()

      const reopened = createSqliteChannelStore({ path, payer: channel.descriptor.payer })
      expect(reopened.listSessions()).toHaveLength(2)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('reconciles retained sessions with the canonical precompile state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-sync-'))
    const path = join(directory, 'channels.db')
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
    const client = createClient({
      account,
      chain: tempoDevnet,
      transport: custom({
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected RPC method ${method}`)
          const request = params[0] as { data: `0x${string}` }
          const call = decodeFunctionData({ abi: escrowAbi, data: request.data })
          if (call.functionName === 'CLOSE_GRACE_PERIOD')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'CLOSE_GRACE_PERIOD',
              result: 900n,
            })
          if (call.functionName === 'getChannelState')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'getChannelState',
              result: { closeRequestedAt: 10, deposit: 12_000_000n, settled: 3_000_000n },
            })
          throw new Error(`unexpected contract call ${call.functionName}`)
        },
      }),
    })
    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: account.address,
      })
      store.set({
        ...channel,
        chainId: tempoDevnet.id,
        descriptor: { ...channel.descriptor, payer: account.address },
      })
      const administration = createSessionAdministration({
        account,
        client,
        now: () => 1_000,
        store,
      })

      const records = await administration.sync({ discover: false })

      expect(records).toEqual([
        expect.objectContaining({
          acceptedCumulative: 3_000_000n,
          closeRequestedAt: 10,
          entry: expect.objectContaining({
            cumulativeAmount: 3_000_000n,
            deposit: 12_000_000n,
            opened: false,
          }),
          graceReadyAt: 910,
          state: 'finalizable',
        }),
      ])
      store.close()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('retains durable state when cooperative close omits its receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-close-receipt-'))
    const path = join(directory, 'channels.db')
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
    const retainedDescriptor = {
      ...channel.descriptor,
      authorizedSigner: account.address,
      payer: account.address,
    }
    const retained = {
      ...channel,
      chainId: tempoDevnet.id,
      channelId: SessionChannel.computeId({
        ...retainedDescriptor,
        chainId: tempoDevnet.id,
        escrow: channel.escrow,
      }),
      descriptor: retainedDescriptor,
    }
    const client = createClient({
      account,
      chain: tempoDevnet,
      transport: custom({
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected RPC method ${method}`)
          const request = params[0] as { data: `0x${string}` }
          const call = decodeFunctionData({ abi: escrowAbi, data: request.data })
          if (call.functionName === 'CLOSE_GRACE_PERIOD')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'CLOSE_GRACE_PERIOD',
              result: 900n,
            })
          throw new Error(`unexpected contract call ${call.functionName}`)
        },
      }),
    })
    const challenge = Challenge.from({
      id: 'close-challenge',
      intent: 'session',
      method: 'tempo',
      realm: 'api.example.com',
      request: {
        amount: '1000000',
        currency: retained.descriptor.token,
        recipient: retained.descriptor.payee,
        methodDetails: {
          chainId: retained.chainId,
          escrowContract: retained.escrow,
          sessionProtocol: Constants.SessionProtocols.v2,
        },
      },
    })
    const getState = vi.spyOn(Chain, 'getChannelState').mockResolvedValue({
      closeRequestedAt: 0,
      deposit: retained.deposit,
      settled: retained.cumulativeAmount,
    })
    let requests = 0
    let closeCredential: string | null = null
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
      requests++
      if (requests === 1)
        return new Response(null, {
          status: 402,
          headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
        })
      closeCredential = new Headers(init?.headers).get('Authorization')
      return new Response('closed', { status: 200 })
    })

    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: account.address,
        requestUrl: 'https://api.example.com/v1/responses',
      })
      store.set(retained)
      const administration = createSessionAdministration({ account, client, fetch, store })

      const summary = await administration.close({
        cooperative: true,
        target: retained.channelId,
      })

      expect(summary).toMatchObject({ closed: 0, failed: 1, pending: 0 })
      expect(summary.results[0]?.error).toContain('authoritative payment receipt')
      expect(
        Credential.deserialize<{ cumulativeAmount: string }>(closeCredential!).payload
          .cumulativeAmount,
      ).toBe(retained.cumulativeAmount.toString())
      expect(store.getChannel(retained.channelId)).toBeDefined()
      store.close()
    } finally {
      getState.mockRestore()
      rmSync(directory, { recursive: true })
    }
  })

  test('does not advance close state when the request-close transaction reverts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-close-revert-'))
    const path = join(directory, 'channels.db')
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
    const retainedDescriptor = {
      ...channel.descriptor,
      authorizedSigner: account.address,
      payer: account.address,
    }
    const retained = {
      ...channel,
      chainId: tempoDevnet.id,
      channelId: SessionChannel.computeId({
        ...retainedDescriptor,
        chainId: tempoDevnet.id,
        escrow: channel.escrow,
      }),
      descriptor: retainedDescriptor,
    }
    const client = createClient({
      account,
      chain: tempoDevnet,
      transport: custom({
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected RPC method ${method}`)
          const request = params[0] as { data: `0x${string}` }
          const call = decodeFunctionData({ abi: escrowAbi, data: request.data })
          if (call.functionName === 'CLOSE_GRACE_PERIOD')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'CLOSE_GRACE_PERIOD',
              result: 900n,
            })
          throw new Error(`unexpected contract call ${call.functionName}`)
        },
      }),
    })
    const getState = vi.spyOn(Chain, 'getChannelState').mockResolvedValue({
      closeRequestedAt: 0,
      deposit: retained.deposit,
      settled: retained.cumulativeAmount,
    })
    const requestClose = vi
      .spyOn(Chain, 'requestCloseOnChain')
      .mockResolvedValue(`0x${'66'.repeat(32)}`)
    const wait = vi
      .spyOn(Chain, 'waitForSuccessfulReceipt')
      .mockRejectedValue(new Error('precompile transaction reverted'))

    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: account.address,
      })
      store.set(retained)
      const administration = createSessionAdministration({ account, client, store })

      const summary = await administration.close({ target: retained.channelId })

      expect(summary).toMatchObject({ closed: 0, failed: 1, pending: 0 })
      expect(summary.results[0]?.error).toContain('precompile transaction reverted')
      expect(store.listSessions()[0]).toMatchObject({ state: 'active' })
      expect(requestClose).toHaveBeenCalledOnce()
      expect(wait).toHaveBeenCalledOnce()
      store.close()
    } finally {
      getState.mockRestore()
      requestClose.mockRestore()
      wait.mockRestore()
      rmSync(directory, { recursive: true })
    }
  })

  test('does not delete a session when the withdrawal transaction reverts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mppx-session-withdraw-revert-'))
    const path = join(directory, 'channels.db')
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
    const retainedDescriptor = {
      ...channel.descriptor,
      authorizedSigner: account.address,
      payer: account.address,
    }
    const retained = {
      ...channel,
      chainId: tempoDevnet.id,
      channelId: SessionChannel.computeId({
        ...retainedDescriptor,
        chainId: tempoDevnet.id,
        escrow: channel.escrow,
      }),
      descriptor: retainedDescriptor,
    }
    const client = createClient({
      account,
      chain: tempoDevnet,
      transport: custom({
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected RPC method ${method}`)
          const request = params[0] as { data: `0x${string}` }
          const call = decodeFunctionData({ abi: escrowAbi, data: request.data })
          if (call.functionName === 'CLOSE_GRACE_PERIOD')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'CLOSE_GRACE_PERIOD',
              result: 900n,
            })
          throw new Error(`unexpected contract call ${call.functionName}`)
        },
      }),
    })
    const getState = vi.spyOn(Chain, 'getChannelState').mockResolvedValue({
      closeRequestedAt: 1,
      deposit: retained.deposit,
      settled: retained.cumulativeAmount,
    })
    const withdraw = vi.spyOn(Chain, 'withdrawOnChain').mockResolvedValue(`0x${'77'.repeat(32)}`)
    const wait = vi
      .spyOn(Chain, 'waitForSuccessfulReceipt')
      .mockRejectedValue(new Error('precompile transaction reverted'))

    try {
      const store = createSqliteChannelStore({
        namespace: 'https://api.example.com',
        path,
        payer: account.address,
      })
      store.set(retained)
      const administration = createSessionAdministration({
        account,
        client,
        now: () => 1_000,
        store,
      })

      const summary = await administration.close({ target: retained.channelId })

      expect(summary).toMatchObject({ closed: 0, failed: 1, pending: 0 })
      expect(summary.results[0]?.error).toContain('precompile transaction reverted')
      expect(store.getChannel(retained.channelId)).toBeDefined()
      expect(withdraw).toHaveBeenCalledOnce()
      expect(wait).toHaveBeenCalledOnce()
      store.close()
    } finally {
      getState.mockRestore()
      withdraw.mockRestore()
      wait.mockRestore()
      rmSync(directory, { recursive: true })
    }
  })
})
