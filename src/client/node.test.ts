import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, test } from 'vp/test'

import type { ChannelEntry } from '../tempo/session/client/ChannelOps.js'
import { entryKey } from '../tempo/session/client/ChannelStore.js'
import { createSqliteChannelStore, defaultChannelDatabasePath } from './node.js'

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
})
