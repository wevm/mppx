import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoDevnet } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

import type { ChannelEntry } from '../tempo/session/client/ChannelOps.js'
import { entryKey } from '../tempo/session/client/ChannelStore.js'
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
      const first = createSqliteChannelStore({ namespace: 'https://api.example.com', path })
      first.set(channel)
      first.close()

      const second = createSqliteChannelStore({ namespace: 'https://api.example.com', path })
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
      database
        .prepare(`INSERT INTO channels (
          channel_id, origin, chain_id, escrow_contract, token, payee, payer,
          authorized_signer, salt, deposit, cumulative_amount, challenge_echo,
          state, created_at, last_used_at, session_protocol, descriptor_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', 1, 1, 'v2', ?)`)
        .run(
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
      database.close()

      const store = createSqliteChannelStore({ namespace: 'https://api.example.com', path })
      expect(store.get(entryKey(channel))).toEqual(channel)
      store.close()
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
      const store = createSqliteChannelStore({ path })
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

      const reopened = createSqliteChannelStore({ path })
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
})
