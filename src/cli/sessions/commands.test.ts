import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, test } from 'vp/test'

import type * as Challenge from '../../Challenge.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { closeAllSessions, listSessions, viewSession } from './commands.js'
import { createSessionRegistry, type SessionRegistry } from './store.js'

const payer = '0x1111111111111111111111111111111111111111' as Address
const payee = '0x2222222222222222222222222222222222222222' as Address
const token = '0x3333333333333333333333333333333333333333' as Address
const escrow = '0x4444444444444444444444444444444444444444' as Address
const operator = '0x0000000000000000000000000000000000000000' as Address
const testnetChannelId = `0x${'aa'.repeat(32)}` as Hex
const mainnetChannelId = `0x${'bb'.repeat(32)}` as Hex

let temporaryDirectory: string
let registry: SessionRegistry

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mppx-session-commands-'))
  const timestamps = [new Date('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:01:00.000Z')]
  registry = createSessionRegistry({
    stateRoot: path.join(temporaryDirectory, 'state'),
    now: () => timestamps.shift() ?? new Date('2026-07-16T00:02:00.000Z'),
  })
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { force: true, recursive: true })
})

function channel(parameters: {
  channelId: Hex
  chainId: number
  cumulativeAmount: bigint
  deposit: bigint
  saltByte: string
}): ChannelEntry {
  return {
    channelId: parameters.channelId,
    cumulativeAmount: parameters.cumulativeAmount,
    deposit: parameters.deposit,
    descriptor: {
      payer,
      payee,
      operator,
      token,
      salt: `0x${parameters.saltByte.repeat(32)}` as Hex,
      authorizedSigner: payer,
      expiringNonceHash: `0x${'66'.repeat(32)}`,
    },
    escrow,
    chainId: parameters.chainId,
    opened: true,
  }
}

function challenge(chainId: number, id: string): Challenge.Challenge {
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

async function seedSessions() {
  await registry.upsert({
    status: 'open',
    channel: channel({
      channelId: testnetChannelId,
      chainId: 42431,
      cumulativeAmount: 9_007_199_254_740_993_123_456_789n,
      deposit: 9_999_999_999_999_999_999_999_999n,
      saltByte: '55',
    }),
    account: { name: 'testnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=testnet&sql=select%201',
    challenge: challenge(42431, 'testnet-challenge'),
    spent: 1_234_567_890_123_456_789n,
    units: 7,
  })
  await registry.upsert({
    status: 'closing',
    channel: channel({
      channelId: mainnetChannelId,
      chainId: 4217,
      cumulativeAmount: 20n,
      deposit: 100n,
      saltByte: '77',
    }),
    account: { name: 'mainnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=mainnet',
    challenge: challenge(4217, 'mainnet-challenge'),
    spent: 5n,
    units: 2,
  })
}

describe('session commands', () => {
  test('list returns stable JSON-safe decimal-string projections', async () => {
    await seedSessions()

    const sessions = await listSessions({}, registry)

    expect(sessions).toEqual([
      {
        status: 'open',
        channelId: testnetChannelId,
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
      {
        status: 'closing',
        channelId: mainnetChannelId,
        account: 'mainnet-payer',
        payer,
        payee,
        authorizedSigner: payer,
        token,
        escrow,
        chainId: 4217,
        cumulativeAmount: '20',
        confirmedSpend: '5',
        deposit: '100',
        units: 2,
        resourceUrl: 'https://api.example.test/query?chainId=mainnet',
        createdAt: '2026-07-16T00:01:00.000Z',
        updatedAt: '2026-07-16T00:01:00.000Z',
      },
    ])
    expect(JSON.parse(JSON.stringify(sessions))).toEqual(sessions)
  })

  test('list filters by account and network', async () => {
    await seedSessions()

    await expect(listSessions({ account: 'testnet-payer' }, registry)).resolves.toMatchObject([
      { channelId: testnetChannelId },
    ])
    await expect(listSessions({ network: 'mainnet' }, registry)).resolves.toMatchObject([
      { channelId: mainnetChannelId },
    ])
    await expect(
      listSessions({ account: 'testnet-payer', network: 'mainnet' }, registry),
    ).resolves.toEqual([])
  })

  test('view returns the same stable projection as list', async () => {
    await seedSessions()
    const [listed] = await listSessions({ network: 'testnet' }, registry)

    await expect(viewSession(testnetChannelId, registry)).resolves.toEqual(listed)
  })

  test('view rejects a missing full channel ID', async () => {
    const missingChannelId = `0x${'cc'.repeat(32)}`

    await expect(viewSession(missingChannelId, registry)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      exitCode: 2,
      message: `Session ${missingChannelId} was not found.`,
    })
  })

  test('close all runs sequentially and reports partial failure', async () => {
    await seedSessions()
    const calls: string[] = []

    const result = await closeAllSessions({}, registry, async (channelId) => {
      calls.push(channelId)
      if (channelId === mainnetChannelId) throw new Error('settlement unavailable')
      return { channelId: testnetChannelId, status: 'closed', spent: '123' }
    })

    expect(calls).toEqual([testnetChannelId, mainnetChannelId])
    expect(result).toEqual({
      closed: [{ channelId: testnetChannelId, status: 'closed', spent: '123' }],
      failed: [{ channelId: mainnetChannelId, message: 'settlement unavailable' }],
    })
  })
})
